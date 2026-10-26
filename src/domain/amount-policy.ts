// SPDX-License-Identifier: Apache-2.0
import { invariant } from "./errors.ts";
import { Money } from "./money.ts";

/** Configurable policies for comparing received and expected amounts. Defaults are strict. */
export interface AmountPolicy {
  /** Underpayment still counted as paid, absolute part (minimal units). Default 0. */
  readonly underpaymentToleranceUnits: bigint;
  /** Underpayment still counted as paid, relative part in basis points of the expected amount. Default 0. */
  readonly underpaymentToleranceBps: number;
  /** Transfers below this amount are ignored and logged (address poisoning, dust spam). */
  readonly dustThresholdUnits: bigint;
  /** Whether payments after `expires_at` but before `grace_until` are accepted (as `paid_late`). */
  readonly acceptLatePayments: boolean;
}

export const STRICT_AMOUNT_POLICY: AmountPolicy = Object.freeze({
  underpaymentToleranceUnits: 0n,
  underpaymentToleranceBps: 0,
  dustThresholdUnits: 0n,
  acceptLatePayments: true,
});

export function amountPolicy(p: AmountPolicy): AmountPolicy {
  invariant(p.underpaymentToleranceUnits >= 0n, "policy.tolerance", "tolerance must be non-negative");
  invariant(
    Number.isInteger(p.underpaymentToleranceBps) &&
      p.underpaymentToleranceBps >= 0 &&
      p.underpaymentToleranceBps < 10_000,
    "policy.tolerance",
    "tolerance bps must be 0..9999",
  );
  invariant(p.dustThresholdUnits >= 0n, "policy.dust", "dust threshold must be non-negative");
  return Object.freeze({ ...p });
}

export type AmountClass = "exact" | "under_tolerated" | "under" | "over";

/** Exact comparison; tolerance applies only to underpayment and only when configured. */
export function classifyAmount(expected: Money, received: Money, policy: AmountPolicy): AmountClass {
  const diff = received.diff(expected);
  if (diff === 0n) return "exact";
  if (diff > 0n) return "over";
  const shortfall = -diff;
  const relative = (expected.units * BigInt(policy.underpaymentToleranceBps)) / 10_000n;
  const tolerance =
    policy.underpaymentToleranceUnits > relative ? policy.underpaymentToleranceUnits : relative;
  return shortfall <= tolerance ? "under_tolerated" : "under";
}

/** A zero-value transfer is never a payment (TRON address-poisoning spam sends them), whatever the threshold. */
export function isDust(amount: Money, policy: AmountPolicy): boolean {
  return amount.units === 0n || amount.units < policy.dustThresholdUnits;
}

/** Unique-amount allocation: base + k·step for k = 1..maxSlots on each address of the pool. */
export interface UniqueAmountPolicy {
  readonly stepUnits: bigint;
  readonly maxSlots: number;
}

export function uniqueAmountPolicy(p: UniqueAmountPolicy): UniqueAmountPolicy {
  invariant(p.stepUnits > 0n, "policy.step", "step must be positive");
  invariant(
    Number.isInteger(p.maxSlots) && p.maxSlots >= 1 && p.maxSlots <= 999,
    "policy.slots",
    "maxSlots 1..999",
  );
  return Object.freeze({ ...p });
}

export function candidateAmounts(base: Money, policy: UniqueAmountPolicy): Money[] {
  const out: Money[] = [];
  for (let k = 1; k <= policy.maxSlots; k++)
    out.push(base.plus(Money.of(base.asset, policy.stepUnits * BigInt(k))));
  return out;
}
