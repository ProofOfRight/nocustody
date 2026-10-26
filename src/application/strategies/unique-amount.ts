// SPDX-License-Identifier: Apache-2.0
import { candidateAmounts } from "../../domain/amount-policy.ts";
import { type AmountSlot, amountSlot, matchSlot } from "../../domain/amount-slot.ts";
import type { PaymentInstructions } from "../../domain/invoice.ts";
import { ApplicationError } from "../errors.ts";
import type { Repositories } from "../ports.ts";
import type { AllocationRequest, MatchFacts, PaymentInstructionStrategy, StrategyMatch } from "./strategy.ts";

/** Picks where to start looking for a free slot among `n` candidates; the default always starts at the first. */
export type SlotStart = (n: number) => number;

/**
 * A free (address, base + k·step) slot on the active addresses, or null when all are taken. The search starts at
 * `start(n)` and wraps around: with a random start the pair that was freed a moment ago (a slot past its grace) is
 * not the next one handed out, so a late payment for the old invoice rarely meets a new invoice holding the same
 * pair (docs/threat-model.md, late payments).
 */
export async function allocateAmountSlot(
  req: AllocationRequest,
  repos: Repositories,
  start: SlotStart = () => 0,
): Promise<{ instructions: PaymentInstructions; slot: AmountSlot } | null> {
  const all = candidateAmounts(req.base, req.settings.uniqueAmount);
  const offset = Math.min(Math.max(0, Math.floor(start(all.length))), Math.max(0, all.length - 1));
  const amounts = [...all.slice(offset), ...all.slice(0, offset)];
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
  readonly #start: SlotStart;

  /** `start` chooses the first slot to try (production: a random one from node:crypto; tests: deterministic). */
  constructor(start: SlotStart = () => 0) {
    this.#start = start;
  }

  async allocate(req: AllocationRequest, repos: Repositories) {
    const r = await allocateAmountSlot(req, repos, this.#start);
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
