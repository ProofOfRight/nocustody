// SPDX-License-Identifier: Apache-2.0
import { type AmountPolicy, classifyAmount } from "./amount-policy.ts";
import { EARLY_PAYMENT_TOLERANCE_MS } from "./amount-slot.ts";
import { type Asset, sameAsset } from "./asset.ts";
import { type ChainAddress, sameAddress } from "./chain-address.ts";
import { DomainError, invariant } from "./errors.ts";
import type { DomainEvent, DomainEventType } from "./events.ts";
import { Money } from "./money.ts";

/**
 * Every invoice status. The same list is the CHECK constraint in the first migration, the OpenAPI `Status` enum,
 * the API's list filter and the payment page's texts; a cross-check test keeps them equal (a status forgotten in
 * one place is otherwise found only in production).
 */
export const INVOICE_STATUSES = [
  "awaiting_payment",
  "confirming",
  "paid",
  "underpaid",
  "overpaid",
  "paid_late",
  "expired",
  "cancelled",
  "aml_pending",
  "aml_hold",
  "completed",
  "rejected",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Where and how much to pay. The address comes from the pinned receiving-address list. */
export interface PaymentInstructions {
  readonly address: ChainAddress;
  readonly amount: Money;
  readonly memo: string | null;
}

/**
 * The price exactly as the merchant gave it and the rate locked into the invoice for its TTL. Priced directly in the
 * asset, the rate fields are null. Invoices created before 0.5.0 that were priced in the asset have no price at all.
 */
export interface LockedPrice {
  readonly amount: string;
  readonly currency: string;
  readonly rate: string | null;
  readonly rateSource: string | null;
  readonly rateAt: Date | null;
  readonly ratePath: string | null;
}

export interface PaymentRecord {
  readonly transferKey: string;
  /** Sender as reported by the finalized-state query; screened by AML. */
  readonly from: string;
  /** Recipient from the finalized-state query; always the invoice's payment address (checked on apply). */
  readonly to: ChainAddress;
  readonly amount: Money;
  readonly at: Date;
}

export interface InvoiceState {
  readonly id: string;
  readonly merchantOrderId: string;
  readonly asset: Asset;
  readonly expected: Money;
  readonly instructions: PaymentInstructions;
  readonly price: LockedPrice | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly graceUntil: Date;
  readonly status: InvoiceStatus;
  readonly payments: readonly PaymentRecord[];
  readonly amlReason: string | null;
  /**
   * Where the payment page sends the payer back to the merchant (a button, never an automatic redirect): after the
   * payment is received, or when the invoice can no longer be paid. Never a proof of payment.
   */
  readonly successUrl: string | null;
  readonly cancelUrl: string | null;
  /** Optimistic concurrency version, incremented on every change. */
  readonly version: number;
}

export interface NewInvoice {
  readonly id: string;
  readonly merchantOrderId: string;
  readonly instructions: PaymentInstructions;
  readonly price: LockedPrice | null;
  readonly ttlMs: number;
  readonly graceMs: number;
  readonly successUrl?: string | null;
  readonly cancelUrl?: string | null;
}

/** Longest return URL accepted. */
export const MAX_RETURN_URL_LENGTH = 2048;

const PAYABLE: ReadonlySet<InvoiceStatus> = new Set([
  "awaiting_payment",
  "confirming",
  "expired",
  "underpaid",
]);

export type PaymentOutcome = "applied" | "duplicate";

/**
 * Invoice aggregate. All state changes go through its methods, which check invariants and record domain events.
 * Lifecycle: docs/architecture.md#invoice-lifecycle.
 */
export class Invoice {
  #state: InvoiceState;
  #events: DomainEvent[] = [];
  readonly #loadedVersion: number | null;

  private constructor(state: InvoiceState, loadedVersion: number | null) {
    this.#state = state;
    this.#loadedVersion = loadedVersion;
  }

  static create(input: NewInvoice, now: Date): Invoice {
    invariant(input.id.length > 0, "invoice.id", "invoice id is required");
    invariant(
      input.merchantOrderId.length > 0 && input.merchantOrderId.length <= 128,
      "invoice.order_id",
      "merchant order id must be 1..128 characters",
    );
    invariant(Number.isInteger(input.ttlMs) && input.ttlMs > 0, "invoice.ttl", "ttl must be positive");
    invariant(
      Number.isInteger(input.graceMs) && input.graceMs >= 0,
      "invoice.grace",
      "grace must be non-negative",
    );
    for (const url of [input.successUrl, input.cancelUrl])
      invariant(
        url == null || (url.length > 0 && url.length <= MAX_RETURN_URL_LENGTH),
        "invoice.return_url",
        `return url must be 1..${MAX_RETURN_URL_LENGTH} characters`,
      );
    invariant(!input.instructions.amount.isZero(), "invoice.amount", "amount must be positive");
    invariant(
      input.instructions.address.network === input.instructions.amount.asset.network,
      "invoice.network",
      "address and asset must be on the same network",
    );
    const expiresAt = new Date(now.getTime() + input.ttlMs);
    const invoice = new Invoice(
      {
        id: input.id,
        merchantOrderId: input.merchantOrderId,
        asset: input.instructions.amount.asset,
        expected: input.instructions.amount,
        instructions: input.instructions,
        price: input.price,
        createdAt: now,
        expiresAt,
        graceUntil: new Date(expiresAt.getTime() + input.graceMs),
        status: "awaiting_payment",
        payments: [],
        amlReason: null,
        successUrl: input.successUrl ?? null,
        cancelUrl: input.cancelUrl ?? null,
        version: 0,
      },
      null,
    );
    invoice.#record("invoice.created", now, {
      merchantOrderId: input.merchantOrderId,
      address: input.instructions.address.value,
      amount: input.instructions.amount.toDecimalString(),
      asset: invoice.#state.asset.id,
      expiresAt: expiresAt.toISOString(),
    });
    return invoice;
  }

  /** Rebuilds an aggregate from storage. No events are recorded. */
  static restore(state: InvoiceState): Invoice {
    return new Invoice(state, state.version);
  }

  /** Version the aggregate was loaded with; null for a new invoice. Used for optimistic locking. */
  get loadedVersion(): number | null {
    return this.#loadedVersion;
  }

  get state(): InvoiceState {
    return this.#state;
  }

  get id(): string {
    return this.#state.id;
  }

  get status(): InvoiceStatus {
    return this.#state.status;
  }

  received(): Money {
    return this.#state.payments.reduce((sum, p) => sum.plus(p.amount), Money.zero(this.#state.asset));
  }

  /** Events recorded since the last call; the caller writes them to the outbox. */
  pullEvents(): DomainEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  /** A matching transfer was seen but is not final yet. */
  markDetected(transferKey: string, now: Date): void {
    if (this.#state.status === "awaiting_payment") this.#set({ status: "confirming" });
    else if (this.#state.status !== "expired" && this.#state.status !== "underpaid") return;
    this.#record("invoice.transfer_detected", now, { transferKey });
  }

  /**
   * Applies a final, verified payment matched to this invoice. Idempotent per transfer.
   * Throws DomainError when the payment cannot belong to this invoice; the caller then quarantines the transfer.
   */
  applyPayment(payment: PaymentRecord, policy: AmountPolicy, now: Date): PaymentOutcome {
    const s = this.#state;
    if (s.payments.some((p) => p.transferKey === payment.transferKey)) return "duplicate";
    if (!PAYABLE.has(s.status))
      throw new DomainError("invoice.not_payable", `invoice ${s.id} is ${s.status}`);
    if (!sameAsset(payment.amount.asset, s.asset))
      throw new DomainError("invoice.asset", "payment in another asset");
    // Strategies match on the recipient already; the aggregate does not rely on every future strategy doing so.
    if (!sameAddress(payment.to, s.instructions.address))
      throw new DomainError("invoice.recipient", "payment to another address than the invoice's");
    const t = payment.at.getTime();
    // An Invalid Date compares false with everything and would pass every window check below.
    invariant(Number.isFinite(t), "invoice.payment_time", "payment time is not a valid date");
    if (t < s.createdAt.getTime() - EARLY_PAYMENT_TOLERANCE_MS) {
      throw new DomainError("invoice.payment_before_creation", "transfer predates the invoice");
    }
    if (t > s.graceUntil.getTime())
      throw new DomainError("invoice.payment_after_grace", "transfer after grace period");
    const late = t > s.expiresAt.getTime();
    if (late && !policy.acceptLatePayments)
      throw new DomainError("invoice.late_not_accepted", "late payments are off");

    const payments = [...s.payments, payment];
    const received = payments.reduce((sum, p) => sum.plus(p.amount), Money.zero(s.asset));
    const cls = classifyAmount(s.expected, received, policy);
    const data = {
      transferKey: payment.transferKey,
      amount: payment.amount.toDecimalString(),
      received: received.toDecimalString(),
      expected: s.expected.toDecimalString(),
      classification: cls,
      late,
    };
    if (cls === "under") {
      this.#set({ payments, status: "underpaid" });
      this.#record("invoice.underpaid", now, data);
    } else if (late) {
      this.#set({ payments, status: "paid_late" });
      this.#record("invoice.paid_late", now, data);
    } else if (cls === "over") {
      this.#set({ payments, status: "overpaid" });
      this.#record("invoice.overpaid", now, data);
    } else {
      this.#set({ payments, status: "paid" });
      this.#record("invoice.paid", now, data);
    }
    return "applied";
  }

  /**
   * TTL elapsed without a final payment. Also applies to `confirming`: a detected transfer may never become final
   * (failed or fake), and a genuine one is still credited later — lateness is judged by its block time.
   * Returns whether the status changed.
   */
  expire(now: Date): boolean {
    const st = this.#state.status;
    if (
      (st !== "awaiting_payment" && st !== "confirming") ||
      now.getTime() < this.#state.expiresAt.getTime()
    ) {
      return false;
    }
    this.#set({ status: "expired" });
    this.#record("invoice.expired", now, {});
    return true;
  }

  /** Cancelled by the merchant before any payment. The amount slot stays reserved until grace ends. */
  cancel(now: Date): void {
    invariant(
      this.#state.status === "awaiting_payment" || this.#state.status === "expired",
      "invoice.not_cancellable",
      `invoice ${this.#state.id} is ${this.#state.status}`,
    );
    this.#set({ status: "cancelled" });
    this.#record("invoice.cancelled", now, {});
  }

  /** A payment was credited and compliance has not looked at it yet (the only states `startAmlReview` accepts). */
  needsAmlReview(): boolean {
    const st = this.#state.status;
    return st === "paid" || st === "overpaid" || st === "paid_late";
  }

  startAmlReview(now: Date): void {
    invariant(this.needsAmlReview(), "invoice.aml_state", `cannot screen ${this.#state.status}`);
    this.#set({ status: "aml_pending" });
    this.#record("invoice.aml_pending", now, {});
  }

  amlCleared(now: Date): void {
    invariant(this.#state.status === "aml_pending", "invoice.aml_state", "not pending AML");
    this.#set({ status: "completed" });
    this.#record("invoice.completed", now, {});
  }

  placeAmlHold(reason: string, now: Date): void {
    invariant(this.#state.status === "aml_pending", "invoice.aml_state", "not pending AML");
    this.#set({ status: "aml_hold", amlReason: reason });
    this.#record("invoice.aml_hold", now, { reason });
  }

  /** Manual decision on an AML hold. */
  resolveAmlHold(approve: boolean, now: Date): void {
    invariant(this.#state.status === "aml_hold", "invoice.aml_state", "not on AML hold");
    this.#set({ status: approve ? "completed" : "rejected" });
    this.#record(approve ? "invoice.completed" : "invoice.rejected", now, {});
  }

  #set(patch: Partial<InvoiceState>): void {
    this.#state = Object.freeze({ ...this.#state, ...patch, version: this.#state.version + 1 });
  }

  #record(type: DomainEventType, at: Date, data: DomainEvent["data"]): void {
    this.#events.push(
      Object.freeze({ type, aggregateId: this.#state.id, occurredAt: at, data: { ...data } }),
    );
  }
}
