// SPDX-License-Identifier: Apache-2.0
import { sameAsset } from "./asset.ts";
import { type ChainAddress, sameAddress } from "./chain-address.ts";
import { invariant } from "./errors.ts";
import type { Money } from "./money.ts";

/** A transfer timestamped up to this much before the slot opened still counts (clock skew). */
export const SLOT_CLOCK_SKEW_MS = 30_000;

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
  return t >= slot.from.getTime() - SLOT_CLOCK_SKEW_MS && t <= slot.until.getTime();
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
