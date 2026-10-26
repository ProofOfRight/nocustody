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
  ApiKeyRecord,
  AuditEntry,
  CandidateStatus,
  Heartbeat,
  Repositories,
  StoredCandidate,
  StoredTransfer,
  TransferCandidate,
  UnitOfWork,
  VerifiedTransfer,
} from "../ports.ts";

interface OutboxRow {
  id: string;
  eventId: string;
  event: DomainEvent;
  attempts: number;
  nextAttemptAt: number;
  deliveredAt: Date | null;
  deadAt: Date | null;
  lastError: string | null;
}

interface Data {
  invoices: Map<string, InvoiceState>;
  slots: AmountSlot[];
  memos: Map<string, { invoiceId: string; address: ChainAddress; assetId: string }>;
  candidates: Map<string, StoredCandidate>;
  transfers: Map<string, StoredTransfer>;
  outbox: DomainEvent[];
  outboxRows: OutboxRow[];
  apiKeys: Map<string, ApiKeyRecord & { lastUsedAt: Date | null }>;
  idempotency: Map<string, { requestSha256: string; invoiceId: string }>;
  heartbeats: Map<string, Heartbeat>;
  guards: Map<string, { blocked: boolean; reason: string; updatedAt: Date }>;
  cursors: Map<string, string>;
  audit: AuditEntry[];
}

/** Transactions are emulated by copying the (immutable-valued) collections and restoring them on failure. */
export class InMemoryStore implements UnitOfWork {
  /** Time for `seen_at`-like columns PostgreSQL fills with `now()`; tests pass their fake clock. */
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  data: Data = {
    invoices: new Map(),
    slots: [],
    memos: new Map(),
    candidates: new Map(),
    transfers: new Map(),
    outbox: [],
    outboxRows: [],
    apiKeys: new Map(),
    idempotency: new Map(),
    heartbeats: new Map(),
    guards: new Map(),
    cursors: new Map(),
    audit: [],
  };

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const snapshot: Data = {
      invoices: new Map(this.data.invoices),
      slots: [...this.data.slots],
      memos: new Map(this.data.memos),
      candidates: new Map(this.data.candidates),
      transfers: new Map(this.data.transfers),
      outbox: [...this.data.outbox],
      outboxRows: this.data.outboxRows.map((r) => ({ ...r })),
      apiKeys: new Map(this.data.apiKeys),
      idempotency: new Map(this.data.idempotency),
      heartbeats: new Map(this.data.heartbeats),
      guards: new Map(this.data.guards),
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
    /** Like the SQL `UPDATE … WHERE status = 'verified'`: false when another worker settled the transfer first. */
    const settle = (ref: TxRef, p: Partial<StoredTransfer>): boolean => {
      const key = txRefKey(ref);
      const cur = d().transfers.get(key);
      if (cur?.status !== "verified") return false;
      d().transfers.set(key, { ...cur, ...p });
      return true;
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
            throw new ConcurrencyError(`merchant order ${inv.state.merchantOrderId} already has an invoice`);
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
        search: async ({ status, since, limit }) =>
          [...d().invoices.values()]
            .filter(
              (s) => (!status || s.status === status) && (!since || s.createdAt.getTime() >= since.getTime()),
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
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
      memos: {
        tryInsert: async (network, memo, invoiceId, address, assetId) => {
          const key = `${network}/${memo}`;
          if (d().memos.has(key)) return false;
          d().memos.set(key, { invoiceId, address, assetId });
          return true;
        },
        find: async (network, memo) => d().memos.get(`${network}/${memo}`) ?? null,
      },
      candidates: {
        insert: async (c: TransferCandidate, status, reason) => {
          const key = `${c.network}/${c.txHash}`;
          if (d().candidates.has(key)) return "duplicate";
          d().candidates.set(key, { candidate: c, status, attempts: 0, reason, seenAt: this.#now() });
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
        listVerified: async (network, address, from, until) =>
          [...d().candidates.values()]
            .filter(
              (c) =>
                c.candidate.network === network &&
                c.status === "verified" &&
                c.candidate.to.value === address.value &&
                c.candidate.at >= from &&
                c.candidate.at <= until,
            )
            .map((c) => c.candidate.txHash),
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
        markMatched: async (ref, invoiceId) => settle(ref, { status: "matched", invoiceId }),
        markUnmatched: async (ref, reason) => settle(ref, { status: "unmatched", reason }),
      },
      outbox: {
        append: async (events) => {
          d().outbox.push(...events);
          for (const event of events) {
            const n = d().outboxRows.length + 1;
            d().outboxRows.push({
              id: String(n),
              eventId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
              event,
              attempts: 0,
              nextAttemptAt: 0,
              deliveredAt: null,
              deadAt: null,
              lastError: null,
            });
          }
        },
      },
      delivery: {
        claim: async (now, leaseMs, limit) => {
          const due = d()
            .outboxRows.filter((r) => !r.deliveredAt && !r.deadAt && r.nextAttemptAt <= now.getTime())
            .slice(0, limit);
          for (const r of due) r.nextAttemptAt = now.getTime() + leaseMs;
          return due.map((r) => ({
            id: r.id,
            eventId: r.eventId,
            type: r.event.type,
            aggregateId: r.event.aggregateId,
            occurredAt: r.event.occurredAt,
            payload: r.event.data,
            attempts: r.attempts,
          }));
        },
        markDelivered: async (id, at) => {
          const r = d().outboxRows.find((x) => x.id === id);
          if (r) r.deliveredAt = at;
        },
        markFailed: async (id, next, error) => {
          const r = d().outboxRows.find((x) => x.id === id);
          if (r)
            Object.assign(r, { attempts: r.attempts + 1, nextAttemptAt: next.getTime(), lastError: error });
        },
        markDead: async (id, at, error) => {
          const r = d().outboxRows.find((x) => x.id === id);
          if (r) Object.assign(r, { attempts: r.attempts + 1, deadAt: at, lastError: error });
        },
        countDead: async () => d().outboxRows.filter((r) => r.deadAt).length,
        reviveDead: async (now, eventId) => {
          const rows = d().outboxRows.filter((r) => r.deadAt && (!eventId || r.eventId === eventId));
          for (const r of rows) Object.assign(r, { deadAt: null, attempts: 0, nextAttemptAt: now.getTime() });
          return rows.length;
        },
      },
      heartbeats: {
        ok: async (role, at) => {
          const cur = d().heartbeats.get(role);
          d().heartbeats.set(role, {
            role,
            lastOkAt: at,
            lastErrorAt: cur?.lastErrorAt ?? null,
            lastError: cur?.lastError ?? null,
          });
        },
        error: async (role, at, error) => {
          const cur = d().heartbeats.get(role);
          d().heartbeats.set(role, {
            role,
            lastOkAt: cur?.lastOkAt ?? null,
            lastErrorAt: at,
            lastError: error,
          });
        },
        list: async () => [...d().heartbeats.values()],
      },
      guards: {
        get: async (key) => d().guards.get(key) ?? null,
        set: async (key, blocked, reason, at) => {
          d().guards.set(key, { blocked, reason, updatedAt: at });
        },
      },
      apiKeys: {
        insert: async (k) => {
          d().apiKeys.set(k.id, { ...k, lastUsedAt: null });
        },
        findById: async (id) => d().apiKeys.get(id) ?? null,
        list: async () => [...d().apiKeys.values()],
        revoke: async (id, at) => {
          const k = d().apiKeys.get(id);
          if (!k || k.revokedAt) return false;
          d().apiKeys.set(id, { ...k, revokedAt: at });
          return true;
        },
        touch: async (id, at) => {
          const k = d().apiKeys.get(id);
          if (k) d().apiKeys.set(id, { ...k, lastUsedAt: at });
        },
      },
      idempotency: {
        find: async (apiKeyId, key) => d().idempotency.get(`${apiKeyId}/${key}`) ?? null,
        insert: async (apiKeyId, key, requestSha256, invoiceId) => {
          if (d().idempotency.has(`${apiKeyId}/${key}`)) throw new Error("duplicate idempotency key");
          d().idempotency.set(`${apiKeyId}/${key}`, { requestSha256, invoiceId });
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
