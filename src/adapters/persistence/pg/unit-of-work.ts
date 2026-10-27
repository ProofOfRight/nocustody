// SPDX-License-Identifier: Apache-2.0
import type { Pool, PoolClient } from "pg";
import { ApplicationError, ConcurrencyError } from "../../../application/errors.ts";
import type {
  ApiKeyRecord,
  ApiScope,
  AuditEntry,
  CandidateStatus,
  Repositories,
  StoredCandidate,
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

/**
 * Assets from the pinned config by stored id. Rows whose asset id is no longer configured can never be processed:
 * they are left out of every batch (so one stale row cannot wedge a pipeline) and are an error when loaded by id.
 */
export type AssetResolver = ReadonlyMap<string, Asset>;

/** SQL condition on `invoices` ($3 = now): a payment sent now could still be credited to the invoice. */
const OPEN_INVOICE =
  "status IN ('awaiting_payment', 'confirming', 'underpaid', 'expired') AND grace_until >= $3";

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

const isUniqueViolation = (e: unknown, constraint: string): boolean =>
  typeof e === "object" &&
  e !== null &&
  (e as { code?: unknown }).code === "23505" &&
  (e as { constraint?: unknown }).constraint === constraint;

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
  success_url: string | null;
  cancel_url: string | null;
  version: number;
}

interface PaymentRow {
  invoice_id: string;
  transfer_key: string;
  sender: string;
  amount_units: string;
  paid_at: Date;
}

interface CandidateRow {
  network: string;
  tx_hash: string;
  asset_id: string;
  sender: string;
  recipient: string;
  amount_units: string;
  block_time: Date;
  memo: string | null;
  status: CandidateStatus;
  attempts: number;
  reason: string | null;
  seen_at: Date;
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
  memo: string | null;
  status: TransferStatus;
  invoice_id: string | null;
  reason: string | null;
}

function repositories(db: PoolClient, assets: AssetResolver): Repositories {
  const assetIds = [...assets.keys()];
  const assetOf = (id: string): Asset => {
    const a = assets.get(id);
    if (!a)
      throw new ApplicationError("asset.unknown", `asset ${id} is stored in the database but not configured`);
    return a;
  };
  const toInvoice = (r: InvoiceRow, payments: PaymentRow[]): Invoice => {
    const asset = assetOf(r.asset_id);
    const network = r.network as NetworkId;
    // The stored address is not checked against the pin here: an invoice on a removed address must stay readable.
    // Whoever shows an address to a payer checks it (isShownAddress, ADR-0037).
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
        // applyPayment admits only payments to the invoice's address (and strategies matched on it before), so the
        // stored payment address is the recipient of every stored payment.
        to: chainAddress(network, r.pay_address),
        amount: Money.of(asset, units(p.amount_units)),
        at: p.paid_at,
      })),
      amlReason: r.aml_reason,
      successUrl: r.success_url,
      cancelUrl: r.cancel_url,
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

  const toCandidate = (r: CandidateRow): StoredCandidate => {
    const network = r.network as NetworkId;
    return {
      candidate: {
        network,
        txHash: r.tx_hash,
        from: r.sender,
        to: chainAddress(network, r.recipient),
        amount: Money.of(assetOf(r.asset_id), units(r.amount_units)),
        at: r.block_time,
        memo: r.memo,
      },
      status: r.status,
      attempts: r.attempts,
      reason: r.reason,
      seenAt: r.seen_at,
    };
  };

  const toTransfer = (r: TransferRow): StoredTransfer => {
    const network = r.network as NetworkId;
    return {
      transfer: {
        ref: txRef(network, r.tx_hash, units(r.log_index)),
        from: r.sender,
        to: chainAddress(network, r.recipient),
        amount: Money.of(assetOf(r.asset_id), units(r.amount_units)),
        at: r.block_time,
        memo: r.memo,
      },
      status: r.status,
      invoiceId: r.invoice_id,
      reason: r.reason,
    };
  };

  const setCandidate = async (c: TransferCandidate, sets: string, params: unknown[]): Promise<void> => {
    const res = await db.query(
      `UPDATE tx_candidates SET ${sets}, updated_at = now()
       WHERE network = $1 AND tx_hash = $2 AND asset_id = $3`,
      [c.network, c.txHash, c.amount.asset.id, ...params],
    );
    if (res.rowCount !== 1)
      throw new Error(`candidate ${c.network}/${c.txHash} (${c.amount.asset.id}) not found`);
  };

  /** Settles a transfer that is still `verified`; false when another worker got there first. */
  const settleTransfer = async (ref: TxRef, sets: string, params: unknown[]): Promise<boolean> => {
    const res = await db.query(
      `UPDATE observed_transfers SET ${sets}, updated_at = now()
       WHERE network = $1 AND tx_hash = $2 AND log_index = $3 AND status = 'verified'`,
      [ref.network, ref.txHash, ref.index.toString(), ...params],
    );
    return res.rowCount === 1;
  };

  return {
    invoices: {
      findById: async (id) => (await loadInvoices("id = $1", [id]))[0] ?? null,
      findByMerchantOrderId: async (oid) => (await loadInvoices("merchant_order_id = $1", [oid]))[0] ?? null,
      insert: async (inv) => {
        const s = inv.state;
        try {
          await db.query(
            `INSERT INTO invoices (id, merchant_order_id, network, asset_id, expected_units, pay_address,
               pay_amount_units, memo, price, created_at, expires_at, grace_until, status, aml_reason, version,
               success_url, cancel_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
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
              s.successUrl,
              s.cancelUrl,
            ],
          );
        } catch (e) {
          // A concurrent request created the invoice for this order first; the caller re-reads it.
          if (isUniqueViolation(e, "invoices_merchant_order_id_key"))
            throw new ConcurrencyError(`merchant order ${s.merchantOrderId} already has an invoice`);
          throw e;
        }
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
          `status IN ('awaiting_payment', 'confirming') AND expires_at <= $1 AND asset_id = ANY($3::text[])
           ORDER BY expires_at LIMIT $2`,
          [now, limit, assetIds],
        ),
      listByStatus: (status, limit) =>
        loadInvoices("status = $1 AND asset_id = ANY($3::text[]) ORDER BY updated_at LIMIT $2", [
          status,
          limit,
          assetIds,
        ]),
      addressUsage: async ({ openOnly, now }) => {
        // Open = a payment sent now could still be credited: the page's payable statuses, inside the grace period.
        const { rows } = await db.query<{
          asset_id: string;
          pay_address: string;
          open: string;
          total: string;
        }>(
          `SELECT asset_id, pay_address,
             count(*) FILTER (WHERE ${OPEN_INVOICE}) AS open, count(*) AS total
           FROM invoices WHERE asset_id = ANY($1::text[]) AND ($2::boolean IS FALSE OR ${OPEN_INVOICE})
           GROUP BY asset_id, pay_address ORDER BY asset_id, pay_address`,
          [assetIds, openOnly, now],
        );
        return rows.map((r) => ({
          assetId: r.asset_id,
          address: r.pay_address,
          open: Number(r.open),
          total: Number(r.total),
        }));
      },
      search: ({ status, since, before, limit }) =>
        loadInvoices(
          `($1::text IS NULL OR status = $1) AND ($2::timestamptz IS NULL OR created_at >= $2)
           AND ($5::timestamptz IS NULL OR created_at < $5 OR (created_at = $5 AND id > $6))
           AND asset_id = ANY($4::text[]) ORDER BY created_at DESC, id LIMIT $3`,
          [status ?? null, since ?? null, limit, assetIds, before?.createdAt ?? null, before?.id ?? null],
        ),
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

    memos: {
      tryInsert: async (network, memo, invoiceId, address, assetId) => {
        const res = await db.query(
          `INSERT INTO memo_reservations (network, memo, invoice_id, address, asset_id) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (network, memo) DO NOTHING`,
          [network, memo, invoiceId, address.value, assetId],
        );
        return res.rowCount === 1;
      },
      find: async (network, memo) => {
        const { rows } = await db.query<{ invoice_id: string; address: string; asset_id: string }>(
          "SELECT invoice_id, address, asset_id FROM memo_reservations WHERE network = $1 AND memo = $2",
          [network, memo],
        );
        const r = rows[0];
        return r
          ? { invoiceId: r.invoice_id, address: chainAddress(network, r.address), assetId: r.asset_id }
          : null;
      },
    },

    candidates: {
      insert: async (c: TransferCandidate, status, reason) => {
        const res = await db.query(
          `INSERT INTO tx_candidates (network, tx_hash, asset_id, sender, recipient, amount_units, block_time, status,
             reason, memo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (network, tx_hash, asset_id) DO UPDATE
             SET status = 'seen', reason = NULL, amount_units = EXCLUDED.amount_units, sender = EXCLUDED.sender,
                 memo = EXCLUDED.memo, updated_at = now()
             WHERE tx_candidates.status = 'dust' AND EXCLUDED.status = 'seen'`,
          [
            c.network,
            c.txHash,
            c.amount.asset.id,
            c.from,
            c.to.value,
            c.amount.units.toString(),
            c.at,
            status,
            reason,
            c.memo,
          ],
        );
        return res.rowCount === 1 ? "inserted" : "duplicate";
      },
      listSeen: async (network: NetworkId, limit: number) => {
        const { rows } = await db.query<CandidateRow>(
          // Oldest transfers first, so a backlog never starves an older payment.
          `SELECT * FROM tx_candidates WHERE network = $1 AND status = 'seen' AND asset_id = ANY($3::text[])
           ORDER BY block_time, tx_hash LIMIT $2`,
          [network, limit, assetIds],
        );
        return rows.map(toCandidate);
      },
      markVerified: (c) => setCandidate(c, "status = 'verified', reason = NULL", []),
      markRejected: (c, reason) => setCandidate(c, "status = 'rejected', reason = $4", [reason]),
      markPending: (c, reason) => setCandidate(c, "attempts = attempts + 1, reason = $4", [reason]),
      listVerified: async (network: NetworkId, address: ChainAddress, from: Date, until: Date) => {
        const { rows } = await db.query<{ tx_hash: string }>(
          `SELECT tx_hash FROM tx_candidates
           WHERE network = $1 AND recipient = $2 AND status = 'verified' AND block_time BETWEEN $3 AND $4`,
          [network, address.value, from, until],
        );
        return rows.map((r) => r.tx_hash);
      },
      pruneSettled: async (before: Date) => {
        const res = await db.query(
          "DELETE FROM tx_candidates WHERE status IN ('dust', 'rejected') AND updated_at < $1",
          [before],
        );
        return res.rowCount ?? 0;
      },
    },

    transfers: {
      insert: async (t: VerifiedTransfer, status, reason) => {
        const res = await db.query(
          `INSERT INTO observed_transfers (network, tx_hash, log_index, asset_id, sender, recipient, amount_units,
             block_time, status, reason, memo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (network, tx_hash, log_index) DO NOTHING`,
          [
            t.ref.network,
            t.ref.txHash,
            t.ref.index.toString(),
            t.amount.asset.id,
            t.from,
            t.to.value,
            t.amount.units.toString(),
            t.at,
            status,
            reason,
            t.memo,
          ],
        );
        return res.rowCount === 1 ? "inserted" : "duplicate";
      },
      listVerified: async (network: NetworkId, limit: number) => {
        const { rows } = await db.query<TransferRow>(
          `SELECT * FROM observed_transfers WHERE network = $1 AND status = 'verified' AND asset_id = ANY($3::text[])
           ORDER BY created_at, tx_hash, log_index LIMIT $2`,
          [network, limit, assetIds],
        );
        return rows.map(toTransfer);
      },
      markMatched: (ref: TxRef, invoiceId: string) =>
        settleTransfer(ref, "status = 'matched', invoice_id = $4", [invoiceId]),
      markUnmatched: (ref: TxRef, reason: string) =>
        settleTransfer(ref, "status = 'unmatched', reason = $4", [reason]),
    },

    outbox: {
      append: async (events: readonly DomainEvent[]) => {
        for (const e of events) {
          await db.query(
            // next_attempt_at uses the application clock like the dispatcher does (no mix of DB and app time).
            "INSERT INTO outbox (type, aggregate_id, occurred_at, payload, next_attempt_at) VALUES ($1, $2, $3, $4, $3)",
            [e.type, e.aggregateId, e.occurredAt, JSON.stringify(e.data)],
          );
        }
      },
    },

    delivery: {
      claim: async (now: Date, leaseMs: number, limit: number) => {
        const { rows } = await db.query<{
          id: string;
          event_id: string;
          type: string;
          aggregate_id: string;
          occurred_at: Date;
          payload: Record<string, unknown>;
          attempts: number;
        }>(
          `UPDATE outbox SET next_attempt_at = $1::timestamptz + make_interval(secs => $2::double precision / 1000)
           WHERE id IN (
             SELECT id FROM outbox
             WHERE delivered_at IS NULL AND dead_at IS NULL AND next_attempt_at <= $1
             ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED)
           RETURNING id, event_id, type, aggregate_id, occurred_at, payload, attempts`,
          [now, leaseMs, limit],
        );
        return rows
          .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)))
          .map((r) => ({
            id: String(r.id),
            eventId: r.event_id,
            type: r.type,
            aggregateId: r.aggregate_id,
            occurredAt: r.occurred_at,
            payload: r.payload,
            attempts: r.attempts,
          }));
      },
      markDelivered: async (id: string, at: Date) => {
        await db.query("UPDATE outbox SET delivered_at = $2, last_error = NULL WHERE id = $1", [id, at]);
      },
      markFailed: async (id: string, next: Date, error: string) => {
        await db.query(
          "UPDATE outbox SET attempts = attempts + 1, next_attempt_at = $2, last_error = $3 WHERE id = $1",
          [id, next, error.slice(0, 500)],
        );
      },
      countDead: async () => {
        const { rows } = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM outbox WHERE dead_at IS NOT NULL",
        );
        return rows[0]?.n ?? 0;
      },
      reviveDead: async (now: Date, eventId?: string) => {
        const res = await db.query(
          `UPDATE outbox SET dead_at = NULL, attempts = 0, next_attempt_at = $1, last_error = NULL
           WHERE dead_at IS NOT NULL AND ($2::uuid IS NULL OR event_id = $2::uuid)`,
          [now, eventId ?? null],
        );
        return res.rowCount ?? 0;
      },
      markDead: async (id: string, at: Date, error: string) => {
        await db.query(
          "UPDATE outbox SET attempts = attempts + 1, dead_at = $2, last_error = $3 WHERE id = $1",
          [id, at, error.slice(0, 500)],
        );
      },
      oldestDue: async (now: Date) => {
        const { rows } = await db.query<{ t: Date | null }>(
          `SELECT min(next_attempt_at) AS t FROM outbox
           WHERE delivered_at IS NULL AND dead_at IS NULL AND next_attempt_at <= $1`,
          [now],
        );
        return rows[0]?.t ?? null;
      },
      pruneDelivered: async (before: Date) => {
        const res = await db.query(
          "DELETE FROM outbox WHERE delivered_at IS NOT NULL AND delivered_at < $1",
          [before],
        );
        return res.rowCount ?? 0;
      },
    },

    heartbeats: {
      ok: async (role: string, at: Date) => {
        await db.query(
          `INSERT INTO heartbeats (role, last_ok_at) VALUES ($1, $2)
           ON CONFLICT (role) DO UPDATE SET last_ok_at = EXCLUDED.last_ok_at`,
          [role, at],
        );
      },
      error: async (role: string, at: Date, error: string) => {
        await db.query(
          `INSERT INTO heartbeats (role, last_error_at, last_error) VALUES ($1, $2, $3)
           ON CONFLICT (role) DO UPDATE SET last_error_at = EXCLUDED.last_error_at, last_error = EXCLUDED.last_error`,
          [role, at, error.slice(0, 500)],
        );
      },
      list: async () => {
        const { rows } = await db.query<{
          role: string;
          last_ok_at: Date | null;
          last_error_at: Date | null;
          last_error: string | null;
        }>("SELECT role, last_ok_at, last_error_at, last_error FROM heartbeats ORDER BY role");
        return rows.map((r) => ({
          role: r.role,
          lastOkAt: r.last_ok_at,
          lastErrorAt: r.last_error_at,
          lastError: r.last_error,
        }));
      },
    },

    guards: {
      get: async (key: string) => {
        const { rows } = await db.query<{ blocked: boolean; reason: string; updated_at: Date }>(
          "SELECT blocked, reason, updated_at FROM guards WHERE key = $1",
          [key],
        );
        const r = rows[0];
        return r ? { blocked: r.blocked, reason: r.reason, updatedAt: r.updated_at } : null;
      },
      set: async (key: string, blocked: boolean, reason: string, at: Date) => {
        await db.query(
          `INSERT INTO guards (key, blocked, reason, updated_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (key) DO UPDATE SET blocked = EXCLUDED.blocked, reason = EXCLUDED.reason, updated_at = EXCLUDED.updated_at`,
          [key, blocked, reason.slice(0, 500), at],
        );
      },
    },

    apiKeys: {
      insert: async (k: ApiKeyRecord) => {
        await db.query(
          "INSERT INTO api_keys (id, name, secret_sha256, scopes, revoked_at) VALUES ($1, $2, $3, $4, $5)",
          [k.id, k.name, k.secretSha256, k.scopes, k.revokedAt],
        );
      },
      findById: async (id: string) => {
        const { rows } = await db.query<{
          id: string;
          name: string;
          secret_sha256: string;
          scopes: ApiScope[];
          revoked_at: Date | null;
        }>("SELECT id, name, secret_sha256, scopes, revoked_at FROM api_keys WHERE id = $1", [id]);
        const r = rows[0];
        return r
          ? {
              id: r.id,
              name: r.name,
              secretSha256: r.secret_sha256,
              scopes: r.scopes,
              revokedAt: r.revoked_at,
            }
          : null;
      },
      list: async () => {
        const { rows } = await db.query<{
          id: string;
          name: string;
          secret_sha256: string;
          scopes: ApiScope[];
          revoked_at: Date | null;
        }>("SELECT id, name, secret_sha256, scopes, revoked_at FROM api_keys ORDER BY created_at");
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          secretSha256: r.secret_sha256,
          scopes: r.scopes,
          revokedAt: r.revoked_at,
        }));
      },
      revoke: async (id: string, at: Date) => {
        const res = await db.query(
          "UPDATE api_keys SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL",
          [id, at],
        );
        return res.rowCount === 1;
      },
      touch: async (id: string, at: Date) => {
        await db.query("UPDATE api_keys SET last_used_at = $2 WHERE id = $1", [id, at]);
      },
    },

    idempotency: {
      find: async (apiKeyId: string, key: string) => {
        const { rows } = await db.query<{ request_sha256: string; invoice_id: string }>(
          "SELECT request_sha256, invoice_id FROM idempotency_keys WHERE api_key_id = $1 AND key = $2",
          [apiKeyId, key],
        );
        const r = rows[0];
        return r ? { requestSha256: r.request_sha256, invoiceId: r.invoice_id } : null;
      },
      insert: async (apiKeyId: string, key: string, requestSha256: string, invoiceId: string) => {
        await db.query(
          "INSERT INTO idempotency_keys (api_key_id, key, request_sha256, invoice_id) VALUES ($1, $2, $3, $4)",
          [apiKeyId, key, requestSha256, invoiceId],
        );
      },
      prune: async (before: Date) => {
        const res = await db.query("DELETE FROM idempotency_keys WHERE created_at < $1", [before]);
        return res.rowCount ?? 0;
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
