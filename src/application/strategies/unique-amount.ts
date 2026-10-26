// SPDX-License-Identifier: Apache-2.0
import { candidateAmounts } from "../../domain/amount-policy.ts";
import { type AmountSlot, amountSlot, matchSlot } from "../../domain/amount-slot.ts";
import type { PaymentInstructions } from "../../domain/invoice.ts";
import { ApplicationError } from "../errors.ts";
import type { Repositories } from "../ports.ts";
import type { AllocationRequest, MatchFacts, PaymentInstructionStrategy, StrategyMatch } from "./strategy.ts";

/** First free (address, base + k·step) slot on the active addresses, or null when all are taken. */
export async function allocateAmountSlot(
  req: AllocationRequest,
  repos: Repositories,
): Promise<{ instructions: PaymentInstructions; slot: AmountSlot } | null> {
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
      if (await repos.slots.tryInsert(slot)) return { instructions: { address, amount, memo: null }, slot };
    }
  }
  return null;
}

/** Exact (address, amount) match within the slot window at the transfer's block time. */
export async function matchAmountSlot(facts: MatchFacts, repos: Repositories): Promise<StrategyMatch> {
  const candidates = await repos.slots.findCandidates(facts.to, facts.amount, facts.at);
  const m = matchSlot(facts, candidates);
  return m.kind === "matched"
    ? { kind: "matched", invoiceId: m.slot.invoiceId, by: "amount" }
    : { kind: "unmatched", reason: m.reason };
}

/**
 * Unique amount per address: base + k·step on the first active address with a free slot. Matching is exact on
 * (address, amount) within the slot window at the transfer's block time; anything else is unmatched.
 */
export class UniqueAmountStrategy implements PaymentInstructionStrategy {
  async allocate(req: AllocationRequest, repos: Repositories) {
    const r = await allocateAmountSlot(req, repos);
    if (!r)
      throw new ApplicationError(
        "allocation.no_free_slot",
        `no free amount slot for ${req.settings.asset.id}`,
      );
    return r;
  }

  match(facts: MatchFacts, repos: Repositories): Promise<StrategyMatch> {
    return matchAmountSlot(facts, repos);
  }
}
