// SPDX-License-Identifier: Apache-2.0
// In-memory implementations of the persistence ports, for application tests only (excluded from the build).
import { type AmountSlot, blocksNewSlot } from "../../domain/amount-slot.ts";
import type { ChainAddress } from "../../domain/chain-address.ts";
import type { DomainEvent } from "../../domain/events.ts";
import { Invoice, type InvoiceState, type InvoiceStatus } from "../../domain/invoice.ts";
import type { Money } from "../../domain/money.ts";
import type { NetworkId } from "../../domain/network.ts";
import { type TxRef, txRefKey } from "../../domain/tx-ref.ts";
import { ConcurrencyError } from "../errors.ts";
import type {
  AuditEntry,
  CandidateStatus,
  Repositories,
  StoredCandidate,
  StoredTransfer,
  TransferCandidate,
  UnitOfWork,
  VerifiedTransfer,
} from "../ports.ts";

interface Data {
  invoices: Map<string, InvoiceState>;
  slots: AmountSlot[];
  candidates: Map<string, StoredCandidate>;
  transfers: Map<string, StoredTransfer>;
  outbox: DomainEvent[];
  cursors: Map<string, string>;
  audit: AuditEntry[];
}

/** Transactions are emulated by copying the (immutable-valued) collections and restoring them on failure. */
export class InMemoryStore implements UnitOfWork {
  data: Data = {
    invoices: new Map(),
    slots: [],
    candidates: new Map(),
    transfers: new Map(),
    outbox: [],
    cursors: new Map(),
    audit: [],
  };

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const snapshot: Data = {
      invoices: new Map(this.data.invoices),
      slots: [...this.data.slots],
      candidates: new Map(this.data.candidates),
      transfers: new Map(this.data.transfers),
      outbox: [...this.data.outbox],
      cursors: new Map(this.data.cursors),
      audit: [...this.data.audit],
    };
    try {
      return await work(this.#repos());
    } catch (e) {
      this.data = snapshot;
      throw e;
    }
  }

  #repos(): Repositories {
    const d = () => this.data;
    const patch = (ref: TxRef, p: Partial<StoredTransfer>) => {
      const key = txRefKey(ref);
      const cur = d().transfers.get(key);
      if (!cur) throw new Error(`no transfer ${key}`);
      d().transfers.set(key, { ...cur, ...p });
    };
    const patchCandidate = (network: NetworkId, txHash: string, p: Partial<StoredCandidate>) => {
      const key = `${network}/${txHash}`;
      const cur = d().candidates.get(key);
      if (!cur) throw new Error(`no candidate ${key}`);
      d().candidates.set(key, { ...cur, ...p });
    };
    return {
      invoices: {
        findById: async (id) => {
          const s = d().invoices.get(id);
          return s ? Invoice.restore(s) : null;
        },
        findByMerchantOrderId: async (oid) => {
          const s = [...d().invoices.values()].find((x) => x.merchantOrderId === oid);
          return s ? Invoice.restore(s) : null;
        },
        insert: async (inv) => {
          if ([...d().invoices.values()].some((x) => x.merchantOrderId === inv.state.merchantOrderId)) {
            throw new Error("duplicate merchant order id");
          }
          d().invoices.set(inv.id, inv.state);
        },
        update: async (inv) => {
          const cur = d().invoices.get(inv.id);
          if (!cur || cur.version !== inv.loadedVersion)
            throw new ConcurrencyError(`invoice ${inv.id} changed`);
          d().invoices.set(inv.id, inv.state);
        },
        listExpirable: async (now, limit) =>
          [...d().invoices.values()]
            .filter(
              (s) =>
                (s.status === "awaiting_payment" || s.status === "confirming") &&
                s.expiresAt.getTime() <= now.getTime(),
            )
            .slice(0, limit)
            .map((s) => Invoice.restore(s)),
        listByStatus: async (status: InvoiceStatus, limit) =>
          [...d().invoices.values()]
            .filter((s) => s.status === status)
            .slice(0, limit)
            .map((s) => Invoice.restore(s)),
      },
      slots: {
        tryInsert: async (slot) => {
          const blocked = d().slots.some(
            (x) =>
              x.address.network === slot.address.network &&
              x.address.value === slot.address.value &&
              x.amount.units === slot.amount.units &&
              x.amount.asset.id === slot.amount.asset.id &&
              blocksNewSlot(x, slot.from),
          );
          if (blocked) return false;
          d().slots.push(slot);
          return true;
        },
        findCandidates: async (address: ChainAddress, amount: Money) =>
          d().slots.filter(
            (x) =>
              x.address.value === address.value &&
              x.address.network === address.network &&
              x.amount.units === amount.units,
          ),
      },
      candidates: {
        insert: async (c: TransferCandidate, status, reason) => {
          const key = `${c.network}/${c.txHash}`;
          if (d().candidates.has(key)) return "duplicate";
          d().candidates.set(key, { candidate: c, status, attempts: 0, reason });
          return "inserted";
        },
        listSeen: async (network: NetworkId, limit) =>
          [...d().candidates.values()]
            .filter((c) => c.candidate.network === network && c.status === "seen")
            .slice(0, limit),
        markVerified: async (network, txHash) =>
          patchCandidate(network, txHash, { status: "verified" as CandidateStatus }),
        markRejected: async (network, txHash, reason) =>
          patchCandidate(network, txHash, { status: "rejected", reason }),
        markPending: async (network, txHash, reason) => {
          const cur = d().candidates.get(`${network}/${txHash}`);
          patchCandidate(network, txHash, { reason, attempts: (cur?.attempts ?? 0) + 1 });
        },
      },
      transfers: {
        insert: async (t: VerifiedTransfer, status, reason) => {
          const key = txRefKey(t.ref);
          if (d().transfers.has(key)) return "duplicate";
          d().transfers.set(key, { transfer: t, status, invoiceId: null, reason });
          return "inserted";
        },
        listVerified: async (network: NetworkId, limit) =>
          [...d().transfers.values()]
            .filter((t) => t.transfer.ref.network === network && t.status === "verified")
            .slice(0, limit),
        markMatched: async (ref, invoiceId) => patch(ref, { status: "matched", invoiceId }),
        markUnmatched: async (ref, reason) => patch(ref, { status: "unmatched", reason }),
      },
      outbox: {
        append: async (events) => {
          d().outbox.push(...events);
        },
      },
      cursors: {
        get: async (network, stream) => d().cursors.get(`${network}/${stream}`) ?? null,
        set: async (network, stream, cursor) => {
          d().cursors.set(`${network}/${stream}`, cursor);
        },
      },
      audit: {
        record: async (entry) => {
          d().audit.push(entry);
        },
      },
    };
  }
}
