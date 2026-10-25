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
import type { TxRef } from "../domain/tx-ref.ts";

export interface Clock {
  now(): Date;
}

/** Checks that receiving addresses and asset contracts still match the pinned checksum. */
export interface IntegrityGuard {
  check(): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
}

export interface IdGenerator {
  /** Unguessable identifier (node:crypto). */
  newId(): string;
}

/** A possibly non-final transfer reported by an indexer. Never credited on its own. */
export interface TransferCandidate {
  readonly ref: TxRef;
  readonly from: string;
  readonly to: ChainAddress;
  readonly amount: Money;
  readonly at: Date;
}

/** Facts confirmed by a finalized-state query (not copied from the candidate). */
export interface VerifiedTransfer {
  readonly ref: TxRef;
  readonly from: string;
  readonly to: ChainAddress;
  readonly amount: Money;
  readonly at: Date;
}

export type VerificationResult =
  | { readonly status: "final"; readonly transfer: VerifiedTransfer }
  | { readonly status: "pending"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string };

export interface FetchResult {
  readonly candidates: readonly TransferCandidate[];
  /** Opaque adapter-defined cursor to persist after the candidates are stored. */
  readonly next: string;
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
}

export interface SlotRepository {
  /** Inserts the slot unless a blocking slot for the same pair exists; returns false on conflict. Atomic. */
  tryInsert(slot: AmountSlot): Promise<boolean>;
  /** Slots for this (address, amount) whose window may cover `at` (domain makes the final decision). */
  findCandidates(address: ChainAddress, amount: Money, at: Date): Promise<AmountSlot[]>;
}

export type TransferStatus = "seen" | "dust" | "verified" | "rejected" | "matched" | "unmatched";

export interface StoredTransfer {
  readonly candidate: TransferCandidate;
  readonly status: TransferStatus;
  readonly verified: VerifiedTransfer | null;
  readonly attempts: number;
  readonly invoiceId: string | null;
  readonly reason: string | null;
}

export interface TransferRepository {
  /** Idempotent by TxRef (UNIQUE(network, tx_hash, log_index)). */
  insertCandidate(
    candidate: TransferCandidate,
    status: "seen" | "dust",
    reason: string | null,
  ): Promise<"inserted" | "duplicate">;
  listByStatus(network: NetworkId, status: TransferStatus, limit: number): Promise<StoredTransfer[]>;
  markVerified(ref: TxRef, verified: VerifiedTransfer): Promise<void>;
  markRejected(ref: TxRef, reason: string): Promise<void>;
  markPending(ref: TxRef, reason: string): Promise<void>;
  markMatched(ref: TxRef, invoiceId: string): Promise<void>;
  markUnmatched(ref: TxRef, reason: string): Promise<void>;
}

export interface OutboxRepository {
  append(events: readonly DomainEvent[]): Promise<void>;
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
  readonly transfers: TransferRepository;
  readonly outbox: OutboxRepository;
  readonly cursors: CursorRepository;
  readonly audit: AuditLog;
}

/** Runs `work` in one database transaction; everything written through `repos` commits or rolls back together. */
export interface UnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}
