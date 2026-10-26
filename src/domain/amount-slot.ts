// SPDX-License-Identifier: Apache-2.0
import { sameAsset } from "./asset.ts";
import { type ChainAddress, sameAddress } from "./chain-address.ts";
import { invariant } from "./errors.ts";
import type { Money } from "./money.ts";

/**
 * Margin between two slots of the same (address, amount) pair: a new slot may open only this long after the previous
 * one closed, so their acceptance windows never touch even with clock skew. Mirrored by `lock_until` in PostgreSQL.
 */
export const SLOT_CLOCK_SKEW_MS = 30_000;

/**
 * How much earlier than the slot (invoice) opened a transfer's block time may be and still count. This covers only
 * the gateway's clock running ahead of the chain; a human needs seconds to pay after seeing an invoice. It is kept
 * small on purpose: a transfer that landed before an invoice existed must not be claimed by an invoice opened right
 * after it with the same amount (docs/adr/0030-early-payment-tolerance.md).
 */
export const EARLY_PAYMENT_TOLERANCE_MS = 5_000;

/**
 * Reservation of the pair (address, amount) for one invoice during [from, until], where until = expires_at + grace.
 * Two slots with the same pair never overlap in time, so a transfer matches at most one slot. Slots are kept as
 * history after they end; a cancelled invoice keeps its slot until `until`.
 */
export interface AmountSlot {
  readonly invoiceId: string;
  readonly address: ChainAddress;
  readonly amount: Money;
  readonly from: Date;
  readonly until: Date;
}

export function amountSlot(s: AmountSlot): AmountSlot {
  invariant(s.from.getTime() < s.until.getTime(), "slot.window", "slot must end after it starts");
  return Object.freeze({ ...s });
}

/**
 * Whether a new slot for the same pair opening at `from` would conflict with `existing`. Includes the clock-skew
 * margin, so the windows in which two slots accept transfers never overlap.
 */
export function blocksNewSlot(existing: AmountSlot, from: Date): boolean {
  return existing.until.getTime() + SLOT_CLOCK_SKEW_MS >= from.getTime();
}

export function slotCovers(slot: AmountSlot, at: Date): boolean {
  const t = at.getTime();
  return t >= slot.from.getTime() - EARLY_PAYMENT_TOLERANCE_MS && t <= slot.until.getTime();
}

export interface TransferFacts {
  readonly to: ChainAddress;
  readonly amount: Money;
  /** Block time of the transfer, not the time we saw it. */
  readonly at: Date;
}

export type SlotMatch =
  | { readonly kind: "matched"; readonly slot: AmountSlot }
  | { readonly kind: "unmatched"; readonly reason: "no_slot" | "ambiguous" };

/** Exact (address, amount) match against slots that were open at the transfer's block time. */
export function matchSlot(transfer: TransferFacts, slots: readonly AmountSlot[]): SlotMatch {
  const hits = slots.filter(
    (s) =>
      sameAddress(s.address, transfer.to) &&
      sameAsset(s.amount.asset, transfer.amount.asset) &&
      s.amount.units === transfer.amount.units &&
      slotCovers(s, transfer.at),
  );
  if (hits.length === 1 && hits[0]) return { kind: "matched", slot: hits[0] };
  return { kind: "unmatched", reason: hits.length === 0 ? "no_slot" : "ambiguous" };
}
