// SPDX-License-Identifier: Apache-2.0
import type { AmountSlot } from "../../domain/amount-slot.ts";
import type { ChainAddress } from "../../domain/chain-address.ts";
import type { PaymentInstructions } from "../../domain/invoice.ts";
import type { Money } from "../../domain/money.ts";
import type { AssetSettings } from "../catalog.ts";
import type { Repositories } from "../ports.ts";

export interface AllocationRequest {
  readonly invoiceId: string;
  readonly settings: AssetSettings;
  readonly base: Money;
  readonly from: Date;
  readonly until: Date;
}

/** What a strategy needs to know about a transfer; callers pass verified facts when crediting. */
export interface MatchFacts {
  readonly to: ChainAddress;
  readonly amount: Money;
  readonly at: Date;
  readonly memo: string | null;
}

export type StrategyMatch =
  | { readonly kind: "matched"; readonly invoiceId: string; readonly by: "memo" | "amount" }
  | { readonly kind: "unmatched"; readonly reason: string };

/** Pluggable way to tell payments apart (unique amount, memo, later xpub derivation / reference key). */
export interface PaymentInstructionStrategy {
  allocate(
    req: AllocationRequest,
    repos: Repositories,
  ): Promise<{ instructions: PaymentInstructions; slot: AmountSlot | null }>;
  match(facts: MatchFacts, repos: Repositories): Promise<StrategyMatch>;
}

export type StrategyResolver = (settings: AssetSettings) => PaymentInstructionStrategy;
