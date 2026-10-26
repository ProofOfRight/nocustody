// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ManualRateTable } from "../adapters/pricing/manual-table.ts";
import { STRICT_AMOUNT_POLICY, uniqueAmountPolicy } from "../domain/amount-policy.ts";
import { chainAddress } from "../domain/chain-address.ts";
import { Money } from "../domain/money.ts";
import { rational, rationalFromDecimal } from "../domain/rational.ts";
import { TRON, USDT_TRON } from "../domain/test-fixtures.ts";
import { txRef } from "../domain/tx-ref.ts";
import { AssetCatalog, type AssetSettings } from "./catalog.ts";
import { ApplicationError } from "./errors.ts";
import type { Alert, IntegrityGuard, PegPriceSource, SecondarySource, TransferCandidate } from "./ports.ts";
import { RateService } from "./rates.ts";
import { UniqueAmountStrategy } from "./strategies/unique-amount.ts";
import { FakeChain } from "./testing/fake-chain.ts";
import { InMemoryStore } from "./testing/in-memory.ts";
import { CreateInvoice } from "./use-cases/create-invoice.ts";
import { deviationBps, exceedsDeviation, Monitor } from "./use-cases/monitor.ts";
import { ResolveAmlHold } from "./use-cases/resolve-aml-hold.ts";
import { SettlePayments } from "./use-cases/settle-payments.ts";
import { VerifyTransfers } from "./use-cases/verify-transfers.ts";

const T0 = new Date("2026-10-26T12:00:00Z").getTime();
const MIN = 60_000;
const ADDR = chainAddress(TRON, "TAddrA111111111111111111111111111");
const settings = (over: Partial<AssetSettings> = {}): AssetSettings => ({
  asset: USDT_TRON,
  priceSymbol: "USDT",
  strategy: "unique-amount",
  addresses: [{ address: ADDR, status: "active", tokenAccount: null }],
  amountPolicy: STRICT_AMOUNT_POLICY,
  uniqueAmount: uniqueAmountPolicy({ stepUnits: 10_000n, maxSlots: 99 }),
  ttlMs: 30 * MIN,
  graceMs: 60 * MIN,
  amlThresholdUnits: 0n,
  ...over,
});
const cand = (hash: string, amount: string, at: number): TransferCandidate => ({
  network: TRON,
  txHash: hash.padEnd(64, "0"),
  from: "TSender",
  to: ADDR,
  amount: Money.parse(USDT_TRON, amount),
  at: new Date(at),
  memo: null,
});

function setup(
  o: {
    peg?: PegPriceSource[];
    secondary?: SecondarySource[];
    asset?: AssetSettings;
    integrity?: IntegrityGuard;
  } = {},
) {
  let t = T0;
  const clock = { now: () => new Date(t) };
  const store = new InMemoryStore(() => clock.now());
  const sent: Alert[] = [];
  const alerts = { send: async (a: Alert) => void sent.push(a) };
  const catalog = new AssetCatalog([o.asset ?? settings()]);
  const monitor = new Monitor({
    uow: store,
    clock,
    alerts,
    catalog,
    maxScannerLagMs: new Map([[TRON, 5 * MIN]]),
    secondary: o.secondary ?? [],
    reconcileLookbackMs: 180 * MIN,
    reconcileSettleDelayMs: 10 * MIN,
    depeg: o.peg ? { symbol: "USDT", sources: o.peg, maxDeviationBps: 150 } : null,
    ...(o.integrity ? { integrity: o.integrity } : {}),
  });
  const uniqueAmount = new UniqueAmountStrategy();
  let n = 0;
  const create = new CreateInvoice({
    uow: store,
    catalog,
    pricing: { currencies: new Set(), markupBps: new Map() },
    rates: new RateService([new ManualRateTable([])]),
    strategies: () => uniqueAmount,
    clock,
    ids: { newId: () => `inv-${++n}` },
    integrity: { check: async () => ({ ok: true }) },
  });
  return { store, monitor, sent, create, catalog, clock, advance: (ms: number) => (t += ms) };
}

const peg = (name: string, price: string | Error): PegPriceSource => ({
  name,
  price: async () => {
    if (price instanceof Error) throw price;
    return rationalFromDecimal(price);
  },
});

describe("monitor: health", () => {
  it("alerts when a scanner has not succeeded within the allowed lag", async () => {
    const s = setup();
    expect(await s.monitor.checkHealth()).toHaveLength(1); // never ran
    await s.store.run((r) => r.heartbeats.ok(`scanner:${TRON}`, s.clock.now()));
    expect(await s.monitor.checkHealth()).toEqual([]);
    s.advance(6 * MIN);
    await s.store.run((r) => r.heartbeats.error(`scanner:${TRON}`, s.clock.now(), "HTTP 503"));
    const problems = await s.monitor.checkHealth();
    expect(problems[0]).toContain("HTTP 503");
    expect(s.sent.at(-1)).toMatchObject({ key: `scanner-lag:${TRON}`, severity: "critical" });
  });

  it("re-checks the pinned config every health cycle and alerts on a violation (not only on invoice creation)", async () => {
    let ok = true;
    const s = setup({
      integrity: {
        check: async () => (ok ? { ok: true } : { ok: false, reason: "pinned checksum mismatch" }),
      },
    });
    await s.store.run((r) => r.heartbeats.ok(`scanner:${TRON}`, s.clock.now()));
    expect(await s.monitor.checkHealth()).toEqual([]);
    ok = false;
    const problems = await s.monitor.checkHealth();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("pinned checksum mismatch");
    expect(s.sent.at(-1)).toMatchObject({ key: "address_pin_violation", severity: "critical" });
  });

  it("alerts on dead-lettered webhooks", async () => {
    const s = setup();
    await s.store.run((r) => r.heartbeats.ok(`scanner:${TRON}`, s.clock.now()));
    await s.store.run((r) =>
      r.outbox.append([{ type: "invoice.paid", aggregateId: "a", occurredAt: new Date(T0), data: {} }]),
    );
    await s.store.run((r) => r.delivery.markDead("1", new Date(T0), "gave up"));
    expect(await s.monitor.checkHealth()).toEqual(["1 webhook event(s) in dead-letter"]);
  });
});

describe("monitor: depeg protection", () => {
  it("measures deviation from the peg in basis points", () => {
    expect(deviationBps(rationalFromDecimal("0.9986"))).toBe(14);
    expect(deviationBps(rational(1n))).toBe(0);
    expect(deviationBps(rationalFromDecimal("1.03"))).toBe(300);
    // the decision is exact, not on the floored number: 150.9 bps is over a 150 bps limit
    expect(exceedsDeviation(rationalFromDecimal("1.01509"), 150)).toBe(true);
    expect(exceedsDeviation(rationalFromDecimal("0.98491"), 150)).toBe(true);
    expect(exceedsDeviation(rationalFromDecimal("1.0150"), 150)).toBe(false);
    expect(exceedsDeviation(rationalFromDecimal("0.985"), 150)).toBe(false);
  });

  it("blocks on a deviation just over the limit that the floored basis points would hide", async () => {
    const s = setup({ peg: [peg("kraken", "1.01509")] });
    expect((await s.monitor.checkDepeg())?.blocked).toBe(true);
    const fine = setup({ peg: [peg("kraken", "1.0150")] });
    expect((await fine.monitor.checkDepeg())?.blocked).toBe(false);
  });

  it("blocks new invoices while the price is off the peg and unblocks when it returns", async () => {
    let price = "0.97";
    const s = setup({
      peg: [{ name: "kraken", price: async () => rationalFromDecimal(price) }, peg("coinbase", "0.999")],
    });
    expect(await s.monitor.checkDepeg()).toMatchObject({ blocked: true });
    const err = await s.create
      .execute({ merchantOrderId: "o1", priceAmount: "10", priceCurrency: "USDT", assetId: "usdt-tron" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplicationError);
    expect((err as ApplicationError).code).toBe("pricing.depeg_block");
    price = "0.999";
    expect(await s.monitor.checkDepeg()).toMatchObject({ blocked: false });
    expect(s.sent.at(-1)?.key).toBe("depeg:USDT:cleared");
    const ok = await s.create.execute({
      merchantOrderId: "o1",
      priceAmount: "10",
      priceCurrency: "USDT",
      assetId: "usdt-tron",
    });
    expect(ok.created).toBe(true);
  });

  it("blocks when no source answers; one failing source only warns", async () => {
    const down = setup({ peg: [peg("kraken", new Error("timeout")), peg("coinbase", new Error("timeout"))] });
    expect(await down.monitor.checkDepeg()).toMatchObject({ blocked: true });
    const half = setup({ peg: [peg("kraken", new Error("timeout")), peg("coinbase", "1.0002")] });
    expect(await half.monitor.checkDepeg()).toMatchObject({ blocked: false });
    expect(half.sent.at(-1)?.key).toBe("depeg:USDT:source");
  });
});

describe("monitor: reconciliation with a second source", () => {
  const source = (list: TransferCandidate[] | Error): SecondarySource => ({
    name: "tronscan",
    network: TRON,
    supports: () => true,
    incoming: async () => {
      if (list instanceof Error) throw list;
      return list;
    },
  });

  it("queues transfers the primary indexer missed as candidates (the verifier decides) and alerts", async () => {
    const s = setup({
      secondary: [source([cand("aa", "10.01", T0 - 60 * MIN), cand("bb", "5", T0 - 2 * MIN)])],
    });
    const stats = await s.monitor.reconcile();
    expect(stats).toMatchObject({ checked: 1, missedByPrimary: 1 }); // "bb" is inside the settle delay
    expect(
      [...s.store.data.candidates.values()].map((c) => [c.candidate.txHash.slice(0, 2), c.status]),
    ).toEqual([["aa", "seen"]]);
    expect(s.sent.at(-1)?.key).toBe(`reconcile-missed:${TRON}:${ADDR.value}`);
    expect((await s.monitor.reconcile()).missedByPrimary).toBe(0); // idempotent
  });

  it("reports verified transfers the second source does not know", async () => {
    const s = setup({ secondary: [source([])] });
    const c = cand("cc", "10.01", T0 - 30 * MIN);
    await s.store.run(async (r) => {
      await r.candidates.insert(c, "seen", null);
      await r.candidates.markVerified(TRON, c.txHash);
    });
    expect((await s.monitor.reconcile()).notInSecondary).toBe(1);
    expect(s.sent.at(-1)?.key).toBe(`reconcile-unknown:${TRON}:${ADDR.value}`);
  });

  it("a failing second source is an alert, not a crash", async () => {
    const s = setup({ secondary: [source(new Error("HTTP 401"))] });
    expect((await s.monitor.reconcile()).errors).toBe(1);
    expect(s.sent.at(-1)?.message).toContain("HTTP 401");
  });
});

describe("verifier and settlement policies", () => {
  it("rejects a candidate that never becomes final", async () => {
    const s = setup();
    const chain = new FakeChain(TRON);
    const c = cand("dd", "10.01", T0);
    chain.verdicts.set(c.txHash, { status: "pending", reason: "not solidified" });
    await s.store.run((r) => r.candidates.insert(c, "seen", null));
    const alerts: Alert[] = [];
    const verify = new VerifyTransfers({
      adapter: chain,
      catalog: s.catalog,
      uow: s.store,
      clock: s.clock,
      batchSize: 10,
      maxPendingMs: 24 * 60 * MIN,
      alerts: { send: async (a) => void alerts.push(a) },
    });
    expect((await verify.execute()).pending).toBe(1);
    s.advance(25 * 60 * MIN);
    expect((await verify.execute()).rejected).toBe(1);
    expect([...s.store.data.candidates.values()][0]?.status).toBe("rejected");
    expect(alerts).toHaveLength(1);
  });

  it("a candidate whose verification keeps failing is rejected after the max age, with an alert", async () => {
    const s = setup();
    const chain = new FakeChain(TRON);
    const c = cand("ee", "10.01", T0);
    chain.verdicts.set(c.txHash, new Error("HTTP 503"));
    await s.store.run((r) => r.candidates.insert(c, "seen", null));
    const alerts: Alert[] = [];
    const verify = new VerifyTransfers({
      adapter: chain,
      catalog: s.catalog,
      uow: s.store,
      clock: s.clock,
      batchSize: 10,
      maxPendingMs: 24 * 60 * MIN,
      alerts: { send: async (a) => void alerts.push(a) },
    });
    expect(await verify.execute()).toMatchObject({ errors: 1, rejected: 0 });
    expect([...s.store.data.candidates.values()][0]).toMatchObject({ status: "seen", attempts: 1 });
    s.advance(25 * 60 * MIN);
    expect(await verify.execute()).toMatchObject({ errors: 1, rejected: 1 });
    expect([...s.store.data.candidates.values()][0]?.status).toBe("rejected");
    expect(alerts.map((a) => a.key)).toEqual([`never-final:${TRON}/${c.txHash}`]);
  });

  it("the max age counts from the time the candidate was first seen when its block time is older (downtime)", async () => {
    const s = setup();
    const chain = new FakeChain(TRON);
    // The gateway was down for two days; the scanner catches up and stores a candidate whose block is 48 h old.
    const c = cand("ff", "10.01", T0 - 48 * 60 * MIN);
    chain.verdicts.set(c.txHash, { status: "pending", reason: "not solidified" });
    await s.store.run((r) => r.candidates.insert(c, "seen", null));
    const verify = new VerifyTransfers({
      adapter: chain,
      catalog: s.catalog,
      uow: s.store,
      clock: s.clock,
      batchSize: 10,
      maxPendingMs: 24 * 60 * MIN,
    });
    // One lagging "not final" answer must not reject a payment that was made while we were down.
    expect(await verify.execute()).toMatchObject({ pending: 1, rejected: 0 });
    expect([...s.store.data.candidates.values()][0]?.status).toBe("seen");
    s.advance(25 * 60 * MIN);
    expect(await verify.execute()).toMatchObject({ rejected: 1 });
  });

  it("payments below the AML threshold complete without screening; above it are screened; holds can be resolved", async () => {
    for (const [amount, expected] of [
      ["5", "completed"],
      ["50", "aml_hold"],
    ] as const) {
      const s = setup({ asset: settings({ amlThresholdUnits: 10_000_000n }) });
      const { invoice } = await s.create.execute({
        merchantOrderId: "o1",
        priceAmount: amount,
        priceCurrency: "USDT",
        assetId: "usdt-tron",
      });
      const screened: string[] = [];
      const settle = new SettlePayments({
        network: TRON,
        catalog: s.catalog,
        strategies: () => new UniqueAmountStrategy(),
        aml: {
          screen: async (i) => {
            screened.push(i.from);
            return { verdict: "hold", reason: "high risk" };
          },
        },
        uow: s.store,
        clock: s.clock,
        batchSize: 10,
      });
      const amt = invoice.state.instructions.amount;
      await s.store.run(async (r) => {
        const c = { ...cand("ee", amt.toDecimalString(), T0 + MIN) };
        await r.candidates.insert(c, "seen", null);
        await r.transfers.insert(
          { ref: txRef(TRON, c.txHash, 0n), from: "TSender", to: ADDR, amount: amt, at: c.at, memo: null },
          "verified",
          null,
        );
      });
      await settle.execute();
      expect(s.store.data.invoices.get(invoice.id)?.status).toBe(expected);
      expect(screened.length > 0).toBe(expected === "aml_hold");
      if (expected === "aml_hold") {
        expect(await new ResolveAmlHold(s.store, s.clock).execute(invoice.id, true, "checked manually")).toBe(
          "completed",
        );
        expect(s.store.data.audit.at(-1)).toMatchObject({
          decision: "approved",
          reason: "manual decision: checked manually",
        });
      }
    }
  });
});
