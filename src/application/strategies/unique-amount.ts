// SPDX-License-Identifier: Apache-2.0
import { candidateAmounts } from "../../domain/amount-policy.ts";
import { type AmountSlot, amountSlot, matchSlot } from "../../domain/amount-slot.ts";
import type { PaymentInstructions } from "../../domain/invoice.ts";
import type { Money } from "../../domain/money.ts";
import type { AssetSettings } from "../catalog.ts";
import { ApplicationError } from "../errors.ts";
import type { SlotRepository, VerifiedTransfer } from "../ports.ts";

export interface AllocationRequest {
  readonly invoiceId: string;
  readonly settings: AssetSettings;
  readonly base: Money;
  readonly from: Date;
  readonly until: Date;
}

export type StrategyMatch =
  | { readonly kind: "matched"; readonly invoiceId: string }
  | { readonly kind: "unmatched"; readonly reason: string };

/** Pluggable way to tell payments apart (unique amount, memo, xpub derivation, reference key). */
export interface PaymentInstructionStrategy {
  allocate(
    req: AllocationRequest,
    slots: SlotRepository,
  ): Promise<{ instructions: PaymentInstructions; slot: AmountSlot }>;
  match(transfer: VerifiedTransfer, slots: SlotRepository): Promise<StrategyMatch>;
}

/**
 * Unique amount per address: base + k·step on the first active address with a free slot. Matching is exact on
 * (address, amount) within the slot window at the transfer's block time; anything else is unmatched.
 */
export class UniqueAmountStrategy implements PaymentInstructionStrategy {
  async allocate(
    req: AllocationRequest,
    slots: SlotRepository,
  ): Promise<{ instructions: PaymentInstructions; slot: AmountSlot }> {
    const amounts = candidateAmounts(req.base, req.settings.uniqueAmount);
    for (const { address, status } of req.settings.addresses) {
      if (status !== "active") continue;
      for (const amount of amounts) {
        const slot = amountSlot({
          invoiceId: req.invoiceId,
          address,
          amount,
          from: req.from,
          until: req.until,
        });
        if (await slots.tryInsert(slot)) return { instructions: { address, amount, memo: null }, slot };
      }
    }
    throw new ApplicationError("allocation.no_free_slot", `no free amount slot for ${req.settings.asset.id}`);
  }

  async match(transfer: VerifiedTransfer, slots: SlotRepository): Promise<StrategyMatch> {
    const candidates = await slots.findCandidates(transfer.to, transfer.amount, transfer.at);
    const m = matchSlot({ to: transfer.to, amount: transfer.amount, at: transfer.at }, candidates);
    return m.kind === "matched"
      ? { kind: "matched", invoiceId: m.slot.invoiceId }
      : { kind: "unmatched", reason: m.reason };
  }
}
