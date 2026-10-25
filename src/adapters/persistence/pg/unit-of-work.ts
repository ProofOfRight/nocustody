// SPDX-License-Identifier: Apache-2.0
import type { Pool, PoolClient } from "pg";
import { ConcurrencyError } from "../../../application/errors.ts";
import type {
  AuditEntry,
  Repositories,
  StoredTransfer,
  TransferCandidate,
  TransferStatus,
  UnitOfWork,
  VerifiedTransfer,
} from "../../../application/ports.ts";
import { type AmountSlot, SLOT_CLOCK_SKEW_MS } from "../../../domain/amount-slot.ts";
import type { Asset } from "../../../domain/asset.ts";
import { type ChainAddress, chainAddress } from "../../../domain/chain-address.ts";
import type { DomainEvent } from "../../../domain/events.ts";
import { Invoice, type InvoiceState, type InvoiceStatus, type LockedPrice } from "../../../domain/invoice.ts";
import { Money } from "../../../domain/money.ts";
import type { NetworkId } from "../../../domain/network.ts";
import { type TxRef, txRef } from "../../../domain/tx-ref.ts";

/** Resolves stored asset ids to assets from the pinned config; an unknown id is a hard error. */
export type AssetResolver = (assetId: string) => Asset;

/** PostgreSQL unit of work: one transaction per `run`, repositories bound to its connection. */
export class PgUnitOfWork implements UnitOfWork {
  readonly #pool: Pool;
  readonly #assets: AssetResolver;

  constructor(pool: Pool, assets: AssetResolver) {
    this.#pool = pool;
    this.#assets = assets;
  }

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(repositories(client, this.#assets));
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

const units = (v: string | bigint): bigint => BigInt(v);

interface InvoiceRow {
  id: string;
  merchant_order_id: string;
  network: string;
  asset_id: string;
  expected_units: string;
  pay_address: string;
  pay_amount_units: string;
  memo: string | null;
  price: (Omit<LockedPrice, "rateAt"> & { rateAt: string | null }) | null;
  created_at: Date;
  expires_at: Date;
  grace_until: Date;
  status: InvoiceStatus;
  aml_reason: string | null;
  version: number;
}

interface PaymentRow {
  invoice_id: string;
  transfer_key: string;
  sender: string;
  amount_units: string;
  paid_at: Date;
}

interface TransferRow {
  network: string;
  tx_hash: string;
  log_index: string;
  asset_id: string;
  sender: string;
  recipient: string;
  amount_units: string;
  block_time: Date;
  status: TransferStatus;
  verified: { from: string; to: string; amount: string; at: string } | null;
  attempts: number;
  invoice_id: string | null;
  reason: string | null;
}

function repositories(db: PoolClient, assetOf: AssetResolver): Repositories {
  const toInvoice = (r: InvoiceRow, payments: PaymentRow[]): Invoice => {
    const asset = assetOf(r.asset_id);
    const network = r.network as NetworkId;
    const state: InvoiceState = {
      id: r.id,
      merchantOrderId: r.merchant_order_id,
      asset,
      expected: Money.of(asset, units(r.expected_units)),
      instructions: {
        address: chainAddress(network, r.pay_address),
        amount: Money.of(asset, units(r.pay_amount_units)),
        memo: r.memo,
      },
      price: r.price ? { ...r.price, rateAt: r.price.rateAt ? new Date(r.price.rateAt) : null } : null,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      graceUntil: r.grace_until,
      status: r.status,
      payments: payments.map((p) => ({
        transferKey: p.transfer_key,
        from: p.sender,
        amount: Money.of(asset, units(p.amount_units)),
        at: p.paid_at,
      })),
      amlReason: r.aml_reason,
      version: r.version,
    };
    return Invoice.restore(Object.freeze(state));
  };

  const loadInvoices = async (where: string, params: unknown[]): Promise<Invoice[]> => {
    const { rows } = await db.query<InvoiceRow>(`SELECT * FROM invoices WHERE ${where}`, params);
    if (rows.length === 0) return [];
    const pay = await db.query<PaymentRow>(
      "SELECT * FROM invoice_payments WHERE invoice_id = ANY($1) ORDER BY paid_at, transfer_key",
      [rows.map((r) => r.id)],
    );
    return rows.map((r) =>
      toInvoice(
        r,
        pay.rows.filter((p) => p.invoice_id === r.id),
      ),
    );
  };

  const savePayments = async (invoice: Invoice): Promise<void> => {
    for (const p of invoice.state.payments) {
      await db.query(
        `INSERT INTO invoice_payments (invoice_id, transfer_key, sender, amount_units, paid_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (invoice_id, transfer_key) DO NOTHING`,
        [invoice.id, p.transferKey, p.from, p.amount.units.toString(), p.at],
      );
    }
  };

  const priceJson = (p: LockedPrice | null) =>
    p ? JSON.stringify({ ...p, rateAt: p.rateAt ? p.rateAt.toISOString() : null }) : null;

  const toTransfer = (r: TransferRow): StoredTransfer => {
    const asset = assetOf(r.asset_id);
    const network = r.network as NetworkId;
    const ref = txRef(network, r.tx_hash, units(r.log_index));
    return {
      candidate: {
        ref,
        from: r.sender,
        to: chainAddress(network, r.recipient),
        amount: Money.of(asset, units(r.amount_units)),
        at: r.block_time,
      },
      status: r.status,
      verified: r.verified
        ? {
            ref,
            from: r.verified.from,
            to: chainAddress(network, r.verified.to),
            amount: Money.of(asset, units(r.verified.amount)),
            at: new Date(r.verified.at),
          }
        : null,
      attempts: r.attempts,
      invoiceId: r.invoice_id,
      reason: r.reason,
    };
  };

  const setTransfer = async (ref: TxRef, sets: string, params: unknown[]): Promise<void> => {
    const res = await db.query(
      `UPDATE observed_transfers SET ${sets}, updated_at = now()
       WHERE network = $1 AND tx_hash = $2 AND log_index = $3`,
      [ref.network, ref.txHash, ref.index.toString(), ...params],
    );
    if (res.rowCount !== 1) throw new Error(`transfer ${ref.network}/${ref.txHash}/${ref.index} not found`);
  };

  return {
    invoices: {
      findById: async (id) => (await loadInvoices("id = $1", [id]))[0] ?? null,
      findByMerchantOrderId: async (oid) => (await loadInvoices("merchant_order_id = $1", [oid]))[0] ?? null,
      insert: async (inv) => {
        const s = inv.state;
        await db.query(
          `INSERT INTO invoices (id, merchant_order_id, network, asset_id, expected_units, pay_address,
             pay_amount_units, memo, price, created_at, expires_at, grace_until, status, aml_reason, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            s.id,
            s.merchantOrderId,
            s.asset.network,
            s.asset.id,
            s.expected.units.toString(),
            s.instructions.address.value,
            s.instructions.amount.units.toString(),
            s.instructions.memo,
            priceJson(s.price),
            s.createdAt,
            s.expiresAt,
            s.graceUntil,
            s.status,
            s.amlReason,
            s.version,
          ],
        );
        await savePayments(inv);
      },
      update: async (inv) => {
        const s = inv.state;
        const res = await db.query(
          `UPDATE invoices SET status = $3, aml_reason = $4, version = $5, updated_at = now()
           WHERE id = $1 AND version = $2`,
          [s.id, inv.loadedVersion, s.status, s.amlReason, s.version],
        );
        if (res.rowCount !== 1) throw new ConcurrencyError(`invoice ${s.id} was modified concurrently`);
        await savePayments(inv);
      },
      listExpirable: (now, limit) =>
        loadInvoices(
          "status IN ('awaiting_payment', 'confirming') AND expires_at <= $1 ORDER BY expires_at LIMIT $2",
          [now, limit],
        ),
      listByStatus: (status, limit) =>
        loadInvoices("status = $1 ORDER BY updated_at LIMIT $2", [status, limit]),
    },

    slots: {
      tryInsert: async (slot: AmountSlot) => {
        // ON CONFLICT DO NOTHING also covers the exclusion constraint, so a taken pair does not abort the transaction.
        const res = await db.query(
          `INSERT INTO amount_slots (invoice_id, network, address, asset_id, amount_units, valid_from, valid_until, lock_until)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
          [
            slot.invoiceId,
            slot.address.network,
            slot.address.value,
            slot.amount.asset.id,
            slot.amount.units.toString(),
            slot.from,
            slot.until,
            new Date(slot.until.getTime() + SLOT_CLOCK_SKEW_MS),
          ],
        );
        return res.rowCount === 1;
      },
      findCandidates: async (address: ChainAddress, amount: Money, at: Date) => {
        const { rows } = await db.query<{
          invoice_id: string;
          address: string;
          asset_id: string;
          amount_units: string;
          valid_from: Date;
          valid_until: Date;
        }>(
          `SELECT invoice_id, address, asset_id, amount_units, valid_from, valid_until FROM amount_slots
           WHERE network = $1 AND address = $2 AND asset_id = $3 AND amount_units = $4
             AND valid_from <= $5::timestamptz + interval '1 minute' AND valid_until >= $5::timestamptz`,
          [address.network, address.value, amount.asset.id, amount.units.toString(), at],
        );
        return rows.map((r) => ({
          invoiceId: r.invoice_id,
          address: chainAddress(address.network, r.address),
          amount: Money.of(assetOf(r.asset_id), units(r.amount_units)),
          from: r.valid_from,
          until: r.valid_until,
        }));
      },
    },

    transfers: {
      insertCandidate: async (c: TransferCandidate, status, reason) => {
        const res = await db.query(
          `INSERT INTO observed_transfers (network, tx_hash, log_index, asset_id, sender, recipient, amount_units,
             block_time, status, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (network, tx_hash, log_index) DO NOTHING`,
          [
            c.ref.network,
            c.ref.txHash,
            c.ref.index.toString(),
            c.amount.asset.id,
            c.from,
            c.to.value,
            c.amount.units.toString(),
            c.at,
            status,
            reason,
          ],
        );
        return res.rowCount === 1 ? "inserted" : "duplicate";
      },
      listByStatus: async (network: NetworkId, status: TransferStatus, limit) => {
        const { rows } = await db.query<TransferRow>(
          "SELECT * FROM observed_transfers WHERE network = $1 AND status = $2 ORDER BY seen_at, tx_hash, log_index LIMIT $3",
          [network, status, limit],
        );
        return rows.map(toTransfer);
      },
      markVerified: (ref, v: VerifiedTransfer) =>
        setTransfer(ref, "status = 'verified', verified = $4, reason = NULL", [
          JSON.stringify({
            from: v.from,
            to: v.to.value,
            amount: v.amount.units.toString(),
            at: v.at.toISOString(),
          }),
        ]),
      markRejected: (ref, reason) => setTransfer(ref, "status = 'rejected', reason = $4", [reason]),
      markPending: (ref, reason) => setTransfer(ref, "attempts = attempts + 1, reason = $4", [reason]),
      markMatched: (ref, invoiceId) => setTransfer(ref, "status = 'matched', invoice_id = $4", [invoiceId]),
      markUnmatched: (ref, reason) => setTransfer(ref, "status = 'unmatched', reason = $4", [reason]),
    },

    outbox: {
      append: async (events: readonly DomainEvent[]) => {
        for (const e of events) {
          await db.query(
            "INSERT INTO outbox (type, aggregate_id, occurred_at, payload) VALUES ($1, $2, $3, $4)",
            [e.type, e.aggregateId, e.occurredAt, JSON.stringify(e.data)],
          );
        }
      },
    },

    cursors: {
      get: async (network, stream) => {
        const { rows } = await db.query<{ cursor: string }>(
          "SELECT cursor FROM scan_cursors WHERE network = $1 AND stream = $2",
          [network, stream],
        );
        return rows[0]?.cursor ?? null;
      },
      set: async (network, stream, cursor) => {
        await db.query(
          `INSERT INTO scan_cursors (network, stream, cursor) VALUES ($1, $2, $3)
           ON CONFLICT (network, stream) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
          [network, stream, cursor],
        );
      },
    },

    audit: {
      record: async (e: AuditEntry) => {
        await db.query(
          "INSERT INTO audit_log (at, actor, subject, decision, reason, data) VALUES ($1, $2, $3, $4, $5, $6)",
          [e.at, e.actor, e.subject, e.decision, e.reason, e.data ? JSON.stringify(e.data) : null],
        );
      },
    },
  };
}
