// SPDX-License-Identifier: Apache-2.0
import { sameAddress } from "../../domain/chain-address.ts";
import { normalizeMemo } from "../../domain/memo.ts";
import { ApplicationError } from "../errors.ts";
import type { MemoGenerator, Repositories } from "../ports.ts";
import type { AllocationRequest, MatchFacts, PaymentInstructionStrategy, StrategyMatch } from "./strategy.ts";
import { allocateAmountSlot, matchAmountSlot } from "./unique-amount.ts";

const MAX_MEMO_ATTEMPTS = 5;

/**
 * One wallet, invoice identified by a text comment (memo) — the watch-only model for TON. A unique amount is reserved
 * as a second signal when available, for payers who forget the comment. A memo is never reused.
 */
export class MemoStrategy implements PaymentInstructionStrategy {
  readonly #memos: MemoGenerator;

  constructor(memos: MemoGenerator) {
    this.#memos = memos;
  }

  async allocate(req: AllocationRequest, repos: Repositories) {
    const fallback = await allocateAmountSlot(req, repos);
    const address =
      fallback?.instructions.address ?? req.settings.addresses.find((a) => a.status === "active")?.address;
    if (!address)
      throw new ApplicationError("allocation.no_address", `no active address for ${req.settings.asset.id}`);
    for (let i = 0; i < MAX_MEMO_ATTEMPTS; i++) {
      const memo = normalizeMemo(this.#memos.newMemo());
      if (memo === null)
        throw new ApplicationError("allocation.bad_memo", "memo generator produced an invalid memo");
      if (await repos.memos.tryInsert(address.network, memo, req.invoiceId, address, req.settings.asset.id)) {
        return {
          instructions: { address, amount: fallback?.instructions.amount ?? req.base, memo },
          slot: fallback?.slot ?? null,
        };
      }
    }
    throw new ApplicationError("allocation.memo_collision", "could not allocate a unique memo");
  }

  async match(facts: MatchFacts, repos: Repositories): Promise<StrategyMatch> {
    const memo = normalizeMemo(facts.memo);
    if (memo !== null) {
      const r = await repos.memos.find(facts.to.network, memo);
      if (r && sameAddress(r.address, facts.to) && r.assetId === facts.amount.asset.id) {
        return { kind: "matched", invoiceId: r.invoiceId, by: "memo" };
      }
    }
    return matchAmountSlot(facts, repos);
  }
}
