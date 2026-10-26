// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AmountPolicy,
  amountPolicy,
  candidateAmounts,
  classifyAmount,
  isDust,
  STRICT_AMOUNT_POLICY,
  uniqueAmountPolicy,
} from "./amount-policy.ts";
import { type AmountSlot, amountSlot, blocksNewSlot, matchSlot } from "./amount-slot.ts";
import { defineAsset } from "./asset.ts";
import { chainAddress } from "./chain-address.ts";
import { DomainError } from "./errors.ts";
import { Invoice } from "./invoice.ts";
import { Money } from "./money.ts";
import { TRON, USDT_TRON } from "./test-fixtures.ts";

const T0 = new Date("2026-10-26T12:00:00Z");
const MIN = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);
const ADDR = chainAddress(TRON, "TAddrA111111111111111111111111111");
const ADDR_B = chainAddress(TRON, "TAddrB111111111111111111111111111");
const usdt = (d: string) => Money.parse(USDT_TRON, d);

function newInvoice(amount = "10.01"): Invoice {
  return Invoice.create(
    {
      id: "inv-1",
      merchantOrderId: "order-1",
      instructions: { address: ADDR, amount: usdt(amount), memo: null },
      price: null,
      ttlMs: 30 * MIN,
      graceMs: 60 * MIN,
    },
    T0,
  );
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : "not-a-domain-error";
  }
  return undefined;
};

describe("Invoice lifecycle", () => {
  it("is created awaiting payment with expiry and grace, and records an event", () => {
    const inv = newInvoice();
    expect(inv.status).toBe("awaiting_payment");
    expect(inv.state.expiresAt).toEqual(at(30 * MIN));
    expect(inv.state.graceUntil).toEqual(at(90 * MIN));
    expect(inv.pullEvents().map((e) => e.type)).toEqual(["invoice.created"]);
    expect(inv.pullEvents()).toEqual([]);
  });

  it("detected → confirming → paid on exact amount", () => {
    const inv = newInvoice();
    inv.markDetected("tx/0", at(MIN));
    expect(inv.status).toBe("confirming");
    expect(
      inv.applyPayment(
        { from: "TSender", transferKey: "tx/0", amount: usdt("10.01"), at: at(MIN) },
        STRICT_AMOUNT_POLICY,
        at(2 * MIN),
      ),
    ).toBe("applied");
    expect(inv.status).toBe("paid");
    expect(inv.pullEvents().map((e) => e.type)).toEqual([
      "invoice.created",
      "invoice.transfer_detected",
      "invoice.paid",
    ]);
  });

  it("is idempotent per transfer", () => {
    const inv = newInvoice();
    const p = { from: "TSender", transferKey: "tx/0", amount: usdt("10.01"), at: at(MIN) };
    inv.applyPayment(p, STRICT_AMOUNT_POLICY, at(MIN));
    expect(inv.applyPayment(p, STRICT_AMOUNT_POLICY, at(MIN))).toBe("duplicate");
    expect(inv.received().units).toBe(10_010_000n);
  });

  it("underpaid, then topped up to paid", () => {
    const inv = newInvoice();
    inv.applyPayment(
      { from: "TSender", transferKey: "a", amount: usdt("10"), at: at(MIN) },
      STRICT_AMOUNT_POLICY,
      at(MIN),
    );
    expect(inv.status).toBe("underpaid");
    inv.applyPayment(
      { from: "TSender", transferKey: "b", amount: usdt("0.01"), at: at(2 * MIN) },
      STRICT_AMOUNT_POLICY,
      at(2 * MIN),
    );
    expect(inv.status).toBe("paid");
  });

  it("no '95% = paid' by default; tolerance only when configured", () => {
    const policy = amountPolicy({ ...STRICT_AMOUNT_POLICY, underpaymentToleranceBps: 100 });
    const strict = newInvoice("100");
    strict.applyPayment(
      { from: "TSender", transferKey: "a", amount: usdt("99.5"), at: at(MIN) },
      STRICT_AMOUNT_POLICY,
      at(MIN),
    );
    expect(strict.status).toBe("underpaid");
    const tolerant = newInvoice("100");
    tolerant.applyPayment(
      { from: "TSender", transferKey: "a", amount: usdt("99.5"), at: at(MIN) },
      policy,
      at(MIN),
    );
    expect(tolerant.status).toBe("paid");
  });

  it("overpaid is a separate status", () => {
    const inv = newInvoice();
    inv.applyPayment(
      { from: "TSender", transferKey: "a", amount: usdt("10.02"), at: at(MIN) },
      STRICT_AMOUNT_POLICY,
      at(MIN),
    );
    expect(inv.status).toBe("overpaid");
  });

  it("expires after TTL; a payment within grace makes it paid_late", () => {
    const inv = newInvoice();
    expect(inv.expire(at(29 * MIN))).toBe(false);
    expect(inv.expire(at(30 * MIN))).toBe(true);
    expect(inv.status).toBe("expired");
    inv.applyPayment(
      { from: "TSender", transferKey: "a", amount: usdt("10.01"), at: at(45 * MIN) },
      STRICT_AMOUNT_POLICY,
      at(50 * MIN),
    );
    expect(inv.status).toBe("paid_late");
  });

  it("expires from confirming; a genuine payment made before expiry is still paid, not late", () => {
    const inv = newInvoice();
    inv.markDetected("tx/0", at(MIN));
    expect(inv.expire(at(31 * MIN))).toBe(true);
    inv.applyPayment(
      { from: "TSender", transferKey: "tx/0", amount: usdt("10.01"), at: at(MIN) },
      STRICT_AMOUNT_POLICY,
      at(40 * MIN),
    );
    expect(inv.status).toBe("paid");
  });

  it("rejects late payments when the policy says so", () => {
    const inv = newInvoice();
    inv.expire(at(30 * MIN));
    const policy: AmountPolicy = { ...STRICT_AMOUNT_POLICY, acceptLatePayments: false };
    expect(
      code(() =>
        inv.applyPayment(
          { from: "TSender", transferKey: "a", amount: usdt("10.01"), at: at(45 * MIN) },
          policy,
          at(50 * MIN),
        ),
      ),
    ).toBe("invoice.late_not_accepted");
  });

  it("rejects payments after grace, before creation, or in another asset", () => {
    const pay =
      (ms: number, amount = usdt("10.01")) =>
      () =>
        newInvoice().applyPayment(
          { from: "TSender", transferKey: "a", amount, at: at(ms) },
          STRICT_AMOUNT_POLICY,
          at(ms),
        );
    expect(code(pay(91 * MIN))).toBe("invoice.payment_after_grace");
    expect(code(pay(-MIN))).toBe("invoice.payment_before_creation");
    expect(code(pay(-4_000))).toBeUndefined(); // within the early-payment tolerance (clock skew)
    // but not a transfer that landed well before the invoice existed (ADR-0030: it may be someone else's money)
    expect(code(pay(-10_000))).toBe("invoice.payment_before_creation");
    // An Invalid Date compares false with every bound and would otherwise be accepted as paid on time.
    expect(code(pay(Number.NaN))).toBe("invoice.payment_time");
    const fake = defineAsset({ ...USDT_TRON, id: "fake", contract: "TFakeContract1111111111111111111111" });
    expect(code(pay(MIN, Money.parse(fake, "10.01")))).toBe("invoice.asset");
  });

  it("cannot be paid after cancellation or completion", () => {
    const inv = newInvoice();
    inv.cancel(at(MIN));
    expect(
      code(() =>
        inv.applyPayment(
          { from: "TSender", transferKey: "a", amount: usdt("10.01"), at: at(2 * MIN) },
          STRICT_AMOUNT_POLICY,
          at(2 * MIN),
        ),
      ),
    ).toBe("invoice.not_payable");
  });

  it("goes through AML: pending → completed, or hold → manual decision", () => {
    const ok = newInvoice();
    ok.applyPayment(
      { from: "TSender", transferKey: "a", amount: usdt("10.01"), at: at(MIN) },
      STRICT_AMOUNT_POLICY,
      at(MIN),
    );
    expect(ok.needsAmlReview()).toBe(true);
    ok.startAmlReview(at(MIN));
    expect(ok.needsAmlReview()).toBe(false);
    ok.amlCleared(at(MIN));
    expect(ok.status).toBe("completed");
    expect(newInvoice().needsAmlReview()).toBe(false);
    expect(code(() => newInvoice().startAmlReview(at(MIN)))).toBe("invoice.aml_state");

    const held = newInvoice();
    held.applyPayment(
      { from: "TSender", transferKey: "a", amount: usdt("10.01"), at: at(MIN) },
      STRICT_AMOUNT_POLICY,
      at(MIN),
    );
    held.startAmlReview(at(MIN));
    held.placeAmlHold("sanctioned source", at(MIN));
    expect(held.state.amlReason).toBe("sanctioned source");
    held.resolveAmlHold(false, at(2 * MIN));
    expect(held.status).toBe("rejected");

    expect(code(() => newInvoice().startAmlReview(at(MIN)))).toBe("invoice.aml_state");
  });

  it("increments the version on every change and keeps the loaded version", () => {
    const inv = newInvoice();
    expect(inv.loadedVersion).toBeNull();
    inv.applyPayment(
      { from: "TSender", transferKey: "a", amount: usdt("10.01"), at: at(MIN) },
      STRICT_AMOUNT_POLICY,
      at(MIN),
    );
    const restored = Invoice.restore(inv.state);
    expect(restored.loadedVersion).toBe(1);
    expect(restored.pullEvents()).toEqual([]);
  });
});

describe("amount policies", () => {
  it("classifies exactly", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        (e, r) => {
          const cls = classifyAmount(Money.of(USDT_TRON, e), Money.of(USDT_TRON, r), STRICT_AMOUNT_POLICY);
          expect(cls).toBe(r === e ? "exact" : r > e ? "over" : "under");
        },
      ),
    );
  });

  it("treats amounts below the threshold as dust", () => {
    const policy = amountPolicy({ ...STRICT_AMOUNT_POLICY, dustThresholdUnits: 100_000n });
    expect(isDust(usdt("0.09"), policy)).toBe(true);
    expect(isDust(usdt("0.1"), policy)).toBe(false);
    // zero is dust even with the default threshold "0": poisoning bots send 0-value transfers
    expect(isDust(usdt("0"), STRICT_AMOUNT_POLICY)).toBe(true);
    expect(isDust(usdt("0.000001"), STRICT_AMOUNT_POLICY)).toBe(false);
  });

  it("generates distinct slot amounts strictly above the base", () => {
    const amounts = candidateAmounts(usdt("10"), uniqueAmountPolicy({ stepUnits: 10_000n, maxSlots: 99 }));
    expect(amounts).toHaveLength(99);
    expect(amounts[0]?.toDecimalString()).toBe("10.010000");
    expect(amounts[98]?.toDecimalString()).toBe("10.990000");
    expect(new Set(amounts.map((a) => a.units)).size).toBe(99);
  });
});

describe("amount slots", () => {
  const slot = (
    amount: string,
    fromMin: number,
    untilMin: number,
    address = ADDR,
    invoiceId = "i",
  ): AmountSlot =>
    amountSlot({
      invoiceId,
      address,
      amount: usdt(amount),
      from: at(fromMin * MIN),
      until: at(untilMin * MIN),
    });

  it("matches only the exact amount on the same address within the slot window", () => {
    const slots = [slot("10.01", 0, 90)];
    expect(matchSlot({ to: ADDR, amount: usdt("10.01"), at: at(5 * MIN) }, slots).kind).toBe("matched");
    expect(matchSlot({ to: ADDR, amount: usdt("10.02"), at: at(5 * MIN) }, slots).kind).toBe("unmatched");
    expect(matchSlot({ to: ADDR, amount: usdt("10.011"), at: at(5 * MIN) }, slots).kind).toBe("unmatched");
    expect(matchSlot({ to: ADDR_B, amount: usdt("10.01"), at: at(5 * MIN) }, slots).kind).toBe("unmatched");
    expect(matchSlot({ to: ADDR, amount: usdt("10.01"), at: at(91 * MIN) }, slots).kind).toBe("unmatched");
  });

  it("a late payment for an old invoice cannot settle a newer invoice with the same pair", () => {
    const old = slot("10.01", 0, 90, ADDR, "old");
    expect(blocksNewSlot(old, at(60 * MIN))).toBe(true); // still locked: cannot be re-allocated
    const fresh = slot("10.01", 91, 181, ADDR, "new");
    const m = matchSlot({ to: ADDR, amount: usdt("10.01"), at: at(80 * MIN) }, [old, fresh]);
    expect(m.kind === "matched" && m.slot.invoiceId).toBe("old");
  });

  it("a slot for the same pair cannot reopen inside the clock-skew margin of the previous one", () => {
    const old = slot("10.01", 0, 90);
    expect(blocksNewSlot(old, at(90 * MIN + 10_000))).toBe(true);
    expect(blocksNewSlot(old, at(90 * MIN + 31_000))).toBe(false);
  });

  it("property: with non-overlapping slots a transfer matches at most one slot, and only on exact facts", () => {
    const slotArb = fc.record({
      addr: fc.constantFrom(ADDR, ADDR_B),
      k: fc.integer({ min: 1, max: 5 }),
      start: fc.integer({ min: 0, max: 400 }),
      len: fc.integer({ min: 1, max: 90 }),
    });
    fc.assert(
      fc.property(
        fc.array(slotArb, { maxLength: 30 }),
        fc.constantFrom(ADDR, ADDR_B),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: -40, max: 500 }),
        (specs, to, k, tSec) => {
          // allocate like the application does: skip a slot whose pair is still blocked
          const slots: AmountSlot[] = [];
          for (const s of [...specs].sort((a, b) => a.start - b.start)) {
            const candidate = amountSlot({
              invoiceId: `i${slots.length}`,
              address: s.addr,
              amount: Money.of(USDT_TRON, 10_000_000n + BigInt(s.k) * 10_000n),
              from: at(s.start * 1000),
              until: at((s.start + s.len) * 1000),
            });
            const blocked = slots.some(
              (x) =>
                x.address.value === candidate.address.value &&
                x.amount.units === candidate.amount.units &&
                blocksNewSlot(x, candidate.from),
            );
            if (!blocked) slots.push(candidate);
          }
          const amount = Money.of(USDT_TRON, 10_000_000n + BigInt(k) * 10_000n);
          const transfer = { to, amount, at: at(tSec * 1000) };
          const m = matchSlot(transfer, slots);
          expect(m.kind === "unmatched" && m.reason === "ambiguous").toBe(false);
          if (m.kind === "matched") {
            expect(m.slot.address.value).toBe(to.value);
            expect(m.slot.amount.units).toBe(amount.units);
            expect(transfer.at.getTime()).toBeLessThanOrEqual(m.slot.until.getTime());
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
