// SPDX-License-Identifier: Apache-2.0
// Ports: interfaces the application needs from the outside world. Implementations live in src/adapters.
import type { AmountSlot } from "../domain/amount-slot.ts";
import type { Asset } from "../domain/asset.ts";
import type { ChainAddress } from "../domain/chain-address.ts";
import type { DomainEvent } from "../domain/events.ts";
import type { Invoice, InvoiceStatus, PaymentInstructions } from "../domain/invoice.ts";
import type { Money } from "../domain/money.ts";
import type { NetworkId } from "../domain/network.ts";
import type { RateQuote } from "../domain/pricing.ts";
import type { Rational } from "../domain/rational.ts";
import type { TxRef } from "../domain/tx-ref.ts";
import type { ReceivingAddress } from "./catalog.ts";

export interface Clock {
  now(): Date;
}

/** Checks that receiving addresses and asset contracts still match the pinned checksum. */
export interface IntegrityGuard {
  check(): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
}

/** Generates payment memos (node:crypto). */
export interface MemoGenerator {
  newMemo(): string;
}

export interface IdGenerator {
  /** Unguessable identifier (node:crypto). */
  newId(): string;
}

/**
 * A transaction an indexer reports as possibly containing an incoming transfer. Its fields are an untrusted hint
 * (used for early detection and dust filtering); only the finalized-state query decides what was transferred.
 */
export interface TransferCandidate {
  readonly network: NetworkId;
  readonly txHash: string;
  readonly from: string;
  readonly to: ChainAddress;
  readonly amount: Money;
  readonly at: Date;
  /** Text comment attached by the payer (TON), or null. */
  readonly memo: string | null;
}

/** One transfer confirmed by a finalized-state query; `ref.index` is the real log index / lt. */
export interface VerifiedTransfer {
  readonly ref: TxRef;
  readonly from: string;
  readonly to: ChainAddress;
  readonly amount: Money;
  readonly at: Date;
  readonly memo: string | null;
}

export type VerificationResult =
  /** Final and successful; the transfers of the asset to our addresses it contains (may be several). */
  | { readonly status: "final"; readonly transfers: readonly VerifiedTransfer[] }
  | { readonly status: "pending"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string };

export interface FetchResult {
  readonly candidates: readonly TransferCandidate[];
  /** Opaque adapter-defined cursor to persist after the candidates are stored. */
  readonly next: string;
  /**
   * The scan read its whole page budget for at least one account: more transactions arrived than one cycle reads,
   * so the scanner lags behind the chain (the cursor still advances; the application alerts the operator).
   */
  readonly exhausted?: boolean;
}

/** Chain adapter. See CONTRIBUTING.md, "Network adapter checklist". */
export interface ChainAdapter {
  readonly network: NetworkId;
  supports(asset: Asset): boolean;
  /** Validates and normalises an address; throws on invalid input. */
  validateAddress(raw: string): ChainAddress;
  /** Candidates from an indexer for incoming transfers of `asset` to `addresses`, starting at `cursor`. */
  fetchIncoming(
    asset: Asset,
    addresses: readonly ChainAddress[],
    cursor: string | null,
    limit: number,
  ): Promise<FetchResult>;
  /** Truth: finality, success, contract, recipient and amount from a finalized-state query. */
  verify(
    candidate: TransferCandidate,
    asset: Asset,
    receiving: readonly ChainAddress[],
  ): Promise<VerificationResult>;
  buildPaymentUri(instructions: PaymentInstructions): string | null;
  /** Form wallets expect when the address is shown to a payer (TON: user-friendly, non-bounceable). */
  formatAddress?(address: ChainAddress): string;
}

/** Operator alert (Telegram, log, …). `key` groups repeats of the same condition. */
export interface Alert {
  readonly key: string;
  readonly severity: "info" | "warning" | "critical";
  readonly message: string;
}

export interface AlertSink {
  send(alert: Alert): Promise<void>;
}

/** Market price of a pegged asset in units of its peg (e.g. USDT in USD), for depeg protection. */
export interface PegPriceSource {
  readonly name: string;
  price(): Promise<Rational>;
}

/**
 * What a second source reported for one address. `complete` is false when its page budget ran out before the
 * window was covered: the transfers it did not return are not evidence that a transfer is unknown to it.
 */
export interface SecondaryReport {
  readonly transfers: TransferCandidate[];
  readonly complete: boolean;
}

/**
 * Independent second indexer used for reconciliation. Returns incoming transfers of `asset` to `address` in
 * [`from`, `until`], already filtered like the primary adapter does (contract / our jetton-wallet, success), as
 * candidates. A source may return transfers after `until`; the caller drops them.
 */
export interface SecondarySource {
  readonly name: string;
  readonly network: NetworkId;
  supports(asset: Asset): boolean;
  incoming(
    asset: Asset,
    address: ChainAddress,
    receiving: readonly ReceivingAddress[],
    from: Date,
    until: Date,
  ): Promise<SecondaryReport>;
}

export interface RateProvider {
  readonly name: string;
  /** All quotes this provider currently has; stale ones are filtered by the domain. */
  quotes(): Promise<readonly RateQuote[]>;
}

export interface AmlInput {
  readonly network: NetworkId;
  readonly from: string;
  readonly txRef: TxRef;
  readonly amount: Money;
}

export type AmlVerdict =
  | { readonly verdict: "clear" }
  | { readonly verdict: "hold"; readonly reason: string }
  | { readonly verdict: "unavailable"; readonly reason: string };

export interface AmlScreener {
  screen(input: AmlInput): Promise<AmlVerdict>;
}

// ---- persistence -------------------------------------------------------------------------------------------------

export interface InvoiceRepository {
  findById(id: string): Promise<Invoice | null>;
  findByMerchantOrderId(merchantOrderId: string): Promise<Invoice | null>;
  insert(invoice: Invoice): Promise<void>;
  /** Optimistic update: fails with ConcurrencyError if the stored version differs from `invoice.loadedVersion`. */
  update(invoice: Invoice): Promise<void>;
  listExpirable(now: Date, limit: number): Promise<Invoice[]>;
  listByStatus(status: InvoiceStatus, limit: number): Promise<Invoice[]>;
  /** For the merchant API: newest first, optional status filter and lower bound on creation time. */
  search(filter: { status?: InvoiceStatus; since?: Date; limit: number }): Promise<Invoice[]>;
}

export interface SlotRepository {
  /** Inserts the slot unless a blocking slot for the same pair exists; returns false on conflict. Atomic. */
  tryInsert(slot: AmountSlot): Promise<boolean>;
  /** Slots for this (address, amount) whose window may cover `at` (domain makes the final decision). */
  findCandidates(address: ChainAddress, amount: Money, at: Date): Promise<AmountSlot[]>;
}

export interface MemoRepository {
  /** Reserves a memo for an invoice forever; false if the memo is already taken on this network. */
  tryInsert(
    network: NetworkId,
    memo: string,
    invoiceId: string,
    address: ChainAddress,
    assetId: string,
  ): Promise<boolean>;
  find(
    network: NetworkId,
    memo: string,
  ): Promise<{ invoiceId: string; address: ChainAddress; assetId: string } | null>;
}

export const CANDIDATE_STATUSES = ["seen", "dust", "verified", "rejected"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export interface StoredCandidate {
  readonly candidate: TransferCandidate;
  readonly status: CandidateStatus;
  /** Verification attempts that ended without a decision (provider error, not final yet). */
  readonly attempts: number;
  readonly reason: string | null;
  /** When the scanner first stored it; `candidateMaxAge` counts from here when the block time is older (downtime). */
  readonly seenAt: Date;
}

export interface CandidateRepository {
  /**
   * Idempotent by (network, tx_hash, asset). A "seen" hint for a transaction stored as "dust" re-queues it (the hint
   * was wrong or a smaller transfer of the same transaction came first) and counts as "inserted"; anything else about
   * a known transaction is a "duplicate".
   */
  insert(
    candidate: TransferCandidate,
    status: "seen" | "dust",
    reason: string | null,
  ): Promise<"inserted" | "duplicate">;
  /** Oldest block time first, so a backlog never starves an older payment. */
  listSeen(network: NetworkId, limit: number): Promise<StoredCandidate[]>;
  markVerified(candidate: TransferCandidate): Promise<void>;
  markRejected(candidate: TransferCandidate, reason: string): Promise<void>;
  /** No decision this cycle: attempts + 1, status unchanged. */
  markPending(candidate: TransferCandidate, reason: string): Promise<void>;
  /** Hashes of candidates to `address` with block time in [from, until] that the verifier accepted. */
  listVerified(network: NetworkId, address: ChainAddress, from: Date, until: Date): Promise<string[]>;
  /** Deletes dust and rejected candidates last touched before `before`; returns how many. */
  pruneSettled(before: Date): Promise<number>;
}

export const TRANSFER_STATUSES = ["verified", "dust", "matched", "unmatched"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export interface StoredTransfer {
  readonly transfer: VerifiedTransfer;
  readonly status: TransferStatus;
  readonly invoiceId: string | null;
  readonly reason: string | null;
}

export interface TransferRepository {
  /** Idempotent by TxRef: UNIQUE(network, tx_hash, log_index). */
  insert(
    transfer: VerifiedTransfer,
    status: "verified" | "dust",
    reason: string | null,
  ): Promise<"inserted" | "duplicate">;
  listVerified(network: NetworkId, limit: number): Promise<StoredTransfer[]>;
  /**
   * Settle a transfer that is still `verified`. Returns false when it no longer is (another worker settled it
   * between list and write), and the caller must not record an outcome for it.
   */
  markMatched(ref: TxRef, invoiceId: string): Promise<boolean>;
  markUnmatched(ref: TxRef, reason: string): Promise<boolean>;
}

export interface OutboxRepository {
  append(events: readonly DomainEvent[]): Promise<void>;
}

/** An outbox row ready for delivery. */
export interface OutboxMessage {
  readonly id: string;
  readonly eventId: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
}

/**
 * Delivery side of the outbox. `claim` leases due rows (SKIP LOCKED) so parallel dispatchers never double-send, as
 * long as `leaseMs` outlives the caller's whole batch. mark* calls are by row id and do not check the lease.
 */
export interface OutboxDelivery {
  claim(now: Date, leaseMs: number, limit: number): Promise<OutboxMessage[]>;
  markDelivered(id: string, at: Date): Promise<void>;
  markFailed(id: string, nextAttemptAt: Date, error: string): Promise<void>;
  markDead(id: string, at: Date, error: string): Promise<void>;
  countDead(): Promise<number>;
  /** Puts dead-lettered events back into delivery (all, or one event id). Returns how many. */
  reviveDead(now: Date, eventId?: string): Promise<number>;
  /** Deletes events delivered before `before` (retention); returns how many. */
  pruneDelivered(before: Date): Promise<number>;
  /** Earliest `next_attempt_at` of an undelivered, not dead-lettered event that is due; null when none is. */
  oldestDue(now: Date): Promise<Date | null>;
}

export interface Heartbeat {
  readonly role: string;
  readonly lastOkAt: Date | null;
  readonly lastErrorAt: Date | null;
  readonly lastError: string | null;
}

export interface HeartbeatRepository {
  ok(role: string, at: Date): Promise<void>;
  error(role: string, at: Date, error: string): Promise<void>;
  list(): Promise<Heartbeat[]>;
}

/** Shared switches set by the monitor and read by other processes, e.g. "depeg:USDT". */
/** `updatedAt` is the time of the last reading; CreateInvoice treats a stale depeg reading as blocked. */
export interface GuardRepository {
  get(key: string): Promise<{ blocked: boolean; reason: string; updatedAt: Date } | null>;
  set(key: string, blocked: boolean, reason: string, at: Date): Promise<void>;
}

/**
 * Outcome of one delivery attempt. `retryable: false` dead-letters the event at once (only for a policy decision such
 * as an SSRF refusal); every transport failure, timeout or non-2xx answer is retryable.
 */
export type DeliveryResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

/** One signed POST of an outbox event to the merchant, bounded by the configured timeout as a whole. */
export interface WebhookSender {
  send(message: OutboxMessage): Promise<DeliveryResult>;
}

export type ApiScope = "invoices:read" | "invoices:write" | "quotes:read";

export interface ApiKeyRecord {
  readonly id: string;
  readonly name: string;
  readonly secretSha256: string;
  readonly scopes: readonly ApiScope[];
  readonly revokedAt: Date | null;
}

export interface ApiKeyRepository {
  insert(key: ApiKeyRecord): Promise<void>;
  findById(id: string): Promise<ApiKeyRecord | null>;
  list(): Promise<ApiKeyRecord[]>;
  revoke(id: string, at: Date): Promise<boolean>;
  touch(id: string, at: Date): Promise<void>;
}

export interface IdempotencyRepository {
  find(apiKeyId: string, key: string): Promise<{ requestSha256: string; invoiceId: string } | null>;
  insert(apiKeyId: string, key: string, requestSha256: string, invoiceId: string): Promise<void>;
  /** Deletes keys recorded before `before` (retention); returns how many. */
  prune(before: Date): Promise<number>;
}

export interface CursorRepository {
  get(network: NetworkId, stream: string): Promise<string | null>;
  set(network: NetworkId, stream: string, cursor: string): Promise<void>;
}

/** Why a payment was credited or rejected. Never contains secrets. */
export interface AuditEntry {
  readonly at: Date;
  readonly actor: "scanner" | "verifier" | "settlement" | "aml" | "invoicing";
  readonly subject: string;
  readonly decision: string;
  readonly reason: string;
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export interface Repositories {
  readonly invoices: InvoiceRepository;
  readonly slots: SlotRepository;
  readonly memos: MemoRepository;
  readonly candidates: CandidateRepository;
  readonly transfers: TransferRepository;
  readonly outbox: OutboxRepository;
  readonly delivery: OutboxDelivery;
  readonly heartbeats: HeartbeatRepository;
  readonly guards: GuardRepository;
  readonly apiKeys: ApiKeyRepository;
  readonly idempotency: IdempotencyRepository;
  readonly cursors: CursorRepository;
  readonly audit: AuditLog;
}

/** Runs `work` in one database transaction; everything written through `repos` commits or rolls back together. */
export interface UnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}
