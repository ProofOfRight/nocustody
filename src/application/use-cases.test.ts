// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { ManualRateTable } from "../adapters/pricing/manual-table.ts";
import { amountPolicy, STRICT_AMOUNT_POLICY, uniqueAmountPolicy } from "../domain/amount-policy.ts";
import { defineAsset } from "../domain/asset.ts";
import { chainAddress } from "../domain/chain-address.ts";
import { Money } from "../domain/money.ts";

import { TRON, USDT_TRON } from "../domain/test-fixtures.ts";
import { txRef, txRefKey } from "../domain/tx-ref.ts";
import { AssetCatalog, type AssetSettings } from "./catalog.ts";
import { ApplicationError } from "./errors.ts";
import type { AmlScreener, AmlVerdict, Clock, RateProvider, TransferCandidate } from "./ports.ts";
import { RateService } from "./rates.ts";
import { UniqueAmountStrategy } from "./strategies/unique-amount.ts";
import { FakeChain } from "./testing/fake-chain.ts";
import { InMemoryStore } from "./testing/in-memory.ts";
import { CreateInvoice } from "./use-cases/create-invoice.ts";
import { ExpireInvoices } from "./use-cases/expire-invoices.ts";
import { IngestTransfers } from "./use-cases/ingest-transfers.ts";
import { SettlePayments } from "./use-cases/settle-payments.ts";
import { VerifyTransfers } from "./use-cases/verify-transfers.ts";

const T0 = new Date("2026-10-26T12:00:00Z");
const MIN = 60_000;
const ADDR_A = chainAddress(TRON, "TAddrA111111111111111111111111111");
const ADDR_B = chainAddress(TRON, "TAddrB111111111111111111111111111");
const usdt = (d: string) => Money.parse(USDT_TRON, d);

class FakeClock implements Clock {
  t = T0.getTime();
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

class ScriptedAml implements AmlScreener {
  verdict: AmlVerdict = { verdict: "clear" };
  async screen(): Promise<AmlVerdict> {
    return this.verdict;
  }
}

function candidate(hash: string, amount: string, at: Date, to = ADDR_A): TransferCandidate {
  return { network: TRON, txHash: hash.padEnd(64, "0"), from: "TSenderX", to, amount: usdt(amount), at };
}

const verified = (c: TransferCandidate, index: bigint, amount: string, to = ADDR_A) => ({
  ref: txRef(TRON, c.txHash, index),
  from: c.from,
  to,
  amount: usdt(amount),
  at: c.at,
});

function settings(over: Partial<AssetSettings> = {}): AssetSettings {
  return {
    asset: USDT_TRON,
    priceSymbol: "USDT",
    addresses: [{ address: ADDR_A, status: "active" }],
    amountPolicy: STRICT_AMOUNT_POLICY,
    uniqueAmount: uniqueAmountPolicy({ stepUnits: 10_000n, maxSlots: 99 }),
    ttlMs: 30 * MIN,
    graceMs: 60 * MIN,
    ...over,
  };
}

const manual = (rates: Array<[string, string, string]>, ageMs = 0, maxAgeMs = 60 * MIN) =>
  new ManualRateTable(
    rates.map(([base, quote, rate]) => ({
      base,
      quote,
      rate,
      setAt: new Date(T0.getTime() - ageMs),
      maxAgeMs,
    })),
  );

function setup(opts: { assets?: AssetSettings[]; providers?: RateProvider[] } = {}) {
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const chain = new FakeChain(TRON);
  const aml = new ScriptedAml();
  const catalog = new AssetCatalog(opts.assets ?? [settings()]);
  const strategy = new UniqueAmountStrategy();
  const integrity = {
    ok: true,
    check: async () =>
      integrity.ok ? { ok: true as const } : { ok: false as const, reason: "pinned checksum mismatch" },
  };
  let n = 0;
  const create = new CreateInvoice({
    uow: store,
    catalog,
    pricing: { currencies: new Set(["USD", "JPY", "EUR"]), markupBps: new Map([["EUR", 100]]) },
    rates: new RateService(
      opts.providers ?? [
        manual([
          ["USD", "USDT", "1"],
          ["USD", "JPY", "150"],
          ["EUR", "USD", "1.1"],
        ]),
      ],
    ),
    strategy,
    clock,
    ids: { newId: () => `inv-${++n}` },
    integrity,
  });
  const ingest = new IngestTransfers({
    adapter: chain,
    catalog,
    strategy,
    uow: store,
    clock,
    pageSize: 2,
    maxPages: 5,
  });
  const verify = new VerifyTransfers({ adapter: chain, catalog, uow: store, clock, batchSize: 50 });
  const settle = new SettlePayments({
    network: TRON,
    catalog,
    strategy,
    aml,
    uow: store,
    clock,
    batchSize: 50,
  });
  const expire = new ExpireInvoices({ uow: store, clock, batchSize: 50 });
  const cycle = async () => {
    await ingest.execute();
    await verify.execute();
    return settle.execute();
  };
  const order = (id: string, amount = "10", cur = "USD") =>
    create.execute({ merchantOrderId: id, priceAmount: amount, priceCurrency: cur, assetId: "usdt-tron" });
  return { store, clock, chain, aml, create, ingest, verify, settle, expire, cycle, order, integrity };
}

const errCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof ApplicationError ? e.code : (e as Error).message;
  }
  return undefined;
};

describe("CreateInvoice", () => {
  it("allocates unique amounts per address and is idempotent by merchant order id", async () => {
    const s = setup();
    const a = await s.order("o1");
    const b = await s.order("o2");
    expect(a.invoice.state.instructions.amount.toDecimalString()).toBe("10.010000");
    expect(b.invoice.state.instructions.amount.toDecimalString()).toBe("10.020000");
    const again = await s.order("o1", "999");
    expect(again.created).toBe(false);
    expect(again.invoice.id).toBe(a.invoice.id);
    expect(s.store.data.outbox.map((e) => e.type)).toEqual(["invoice.created", "invoice.created"]);
  });

  it("locks the rate, source and cross-rate path", async () => {
    const s = setup();
    const { invoice } = await s.order("o1", "1500", "JPY");
    expect(invoice.state.expected.toDecimalString()).toBe("10.010000");
    expect(invoice.state.price?.rateSource).toBe("manual");
    expect(invoice.state.price?.ratePath).toBe("JPY → USD@150 → USDT@1");
  });

  it("applies per-currency markup", async () => {
    const s = setup();
    const { invoice } = await s.order("o1", "10", "EUR"); // 10 EUR * 1.1 * 1.01 = 11.11
    expect(invoice.state.expected.toDecimalString()).toBe("11.120000");
  });

  it("accepts prices already in the asset", async () => {
    const s = setup();
    const { invoice } = await s.order("o1", "5", "USDT");
    expect(invoice.state.expected.toDecimalString()).toBe("5.010000");
    expect(invoice.state.price).toBeNull();
  });

  it("refuses to issue payment instructions when the pinned config was tampered with", async () => {
    const s = setup();
    s.integrity.ok = false;
    expect(await errCode(s.order("o1"))).toBe("integrity.pin_violation");
    expect(s.store.data.invoices.size).toBe(0);
  });

  it("refuses disabled currencies and stale rates", async () => {
    expect(await errCode(setup().order("o1", "10", "RUB"))).toBe("pricing.currency_disabled");
    const stale = setup({ providers: [manual([["USD", "USDT", "1"]], 2 * 60 * MIN)] });
    expect(await errCode(stale.order("o1"))).toBe("pricing.no_rate");
  });

  it("falls back to the next provider when the first fails or is stale", async () => {
    const failing: RateProvider = {
      name: "down",
      quotes: async () => {
        throw new Error("timeout");
      },
    };
    const stale = manual([["USD", "USDT", "0.5"]], 2 * 60 * MIN);
    const s = setup({ providers: [failing, stale, manual([["USD", "USDT", "1"]])] });
    const { invoice } = await s.order("o1");
    expect(invoice.state.expected.toDecimalString()).toBe("10.010000");
  });

  it("moves to the next address when slots run out, then fails", async () => {
    const s = setup({
      assets: [
        settings({
          addresses: [
            { address: ADDR_A, status: "active" },
            { address: chainAddress(TRON, "TDrain1111111111111111111111111111"), status: "draining" },
            { address: ADDR_B, status: "active" },
          ],
          uniqueAmount: uniqueAmountPolicy({ stepUnits: 10_000n, maxSlots: 2 }),
        }),
      ],
    });
    const used = [];
    for (const id of ["o1", "o2", "o3", "o4"])
      used.push((await s.order(id)).invoice.state.instructions.address.value);
    expect(used).toEqual([ADDR_A.value, ADDR_A.value, ADDR_B.value, ADDR_B.value]);
    expect(await errCode(s.order("o5"))).toBe("allocation.no_free_slot");
    expect(s.store.data.invoices.size).toBe(4); // the failed creation rolled back
  });
});

describe("payment flow", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("invoice → transfer → verified → paid → completed, with outbox events and audit trail", async () => {
    const { invoice } = await s.order("o1");
    s.clock.advance(MIN);
    s.chain.pages = [[candidate("aa", "10.01", s.clock.now())]];
    const stats = await s.cycle();
    expect(stats).toMatchObject({ matched: 1, completed: 1 });
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("completed");
    expect(s.store.data.outbox.map((e) => e.type)).toEqual([
      "invoice.created",
      "invoice.transfer_detected",
      "invoice.paid",
      "invoice.aml_pending",
      "invoice.completed",
    ]);
    expect(s.store.data.audit.map((a) => `${a.actor}:${a.decision}`)).toEqual([
      "invoicing:created",
      "verifier:final",
      "settlement:matched",
      "aml:completed",
    ]);
  });

  it("is idempotent: the same transfer seen twice is credited once", async () => {
    await s.order("o1");
    s.clock.advance(MIN);
    const c = candidate("aa", "10.01", s.clock.now());
    s.chain.pages = [[c, c]];
    await s.cycle();
    s.store.data.cursors.clear(); // rescan from the start (overlap)
    await s.cycle();
    expect(s.store.data.candidates.size).toBe(1);
    expect(s.store.data.transfers.size).toBe(1);
    expect(s.store.data.outbox.filter((e) => e.type === "invoice.paid")).toHaveLength(1);
  });

  it("does not credit a transfer the verifier rejects (fake token, failed tx)", async () => {
    const { invoice } = await s.order("o1");
    s.clock.advance(MIN);
    const c = candidate("bb", "10.01", s.clock.now());
    s.chain.pages = [[c]];
    s.chain.verdicts.set(c.txHash, { status: "rejected", reason: "receipt result REVERT" });
    await s.cycle();
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("confirming");
    expect([...s.store.data.candidates.values()][0]?.status).toBe("rejected");
    expect(s.store.data.transfers.size).toBe(0);
    // the invoice still expires and its slot stays locked
    s.clock.advance(30 * MIN);
    expect(await s.expire.execute()).toBe(1);
  });

  it("keeps non-final and errored candidates for a later attempt", async () => {
    await s.order("o1");
    s.clock.advance(MIN);
    const c1 = candidate("cc", "10.01", s.clock.now());
    const c2 = candidate("dd", "10.01", s.clock.now());
    s.chain.pages = [[c1, c2]];
    s.chain.verdicts.set(c1.txHash, { status: "pending", reason: "not solidified" });
    s.chain.verdicts.set(c2.txHash, new Error("HTTP 503"));
    await s.cycle();
    const statuses = [...s.store.data.candidates.values()].map((t) => [t.status, t.attempts]);
    expect(statuses).toEqual([
      ["seen", 1],
      ["seen", 1],
    ]);
  });

  it("quarantines transfers that match no invoice", async () => {
    await s.order("o1");
    s.clock.advance(MIN);
    s.chain.pages = [[candidate("ee", "10.05", s.clock.now())]];
    expect(await s.cycle()).toMatchObject({ unmatched: 1, matched: 0 });
    expect(s.store.data.outbox.at(-1)?.type).toBe("transfer.unmatched");
  });

  it("several transfers in one transaction are separate payments; the hint is never credited", async () => {
    const { invoice } = await s.order("o1");
    const other = await s.order("o2");
    s.clock.advance(MIN);
    // the indexer says 10.01 to A; the finalized receipt has two Transfer logs: 10.02 (log 1) and 10.01 (log 4)
    const c = candidate("mm", "10.01", s.clock.now());
    s.chain.pages = [[c]];
    s.chain.verdicts.set(c.txHash, {
      status: "final",
      transfers: [verified(c, 1n, "10.02"), verified(c, 4n, "10.01")],
    });
    expect(await s.cycle()).toMatchObject({ matched: 2 });
    expect(s.store.data.invoices.get(invoice.id)?.payments[0]?.transferKey).toBe(
      txRefKey(txRef(TRON, c.txHash, 4n)),
    );
    expect(s.store.data.invoices.get(other.invoice.id)?.payments[0]?.transferKey).toBe(
      txRefKey(txRef(TRON, c.txHash, 1n)),
    );
  });

  it("credits the verified amount, not the indexer's claim", async () => {
    const { invoice } = await s.order("o1");
    s.clock.advance(MIN);
    const c = candidate("nn", "10.01", s.clock.now()); // indexer lies
    s.chain.pages = [[c]];
    s.chain.verdicts.set(c.txHash, { status: "final", transfers: [verified(c, 0n, "0.01")] });
    expect(await s.cycle()).toMatchObject({ unmatched: 1, matched: 0 });
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("confirming");
  });

  it("a final transaction without a transfer to us is rejected", async () => {
    await s.order("o1");
    const c = candidate("oo", "10.01", s.clock.now());
    s.chain.pages = [[c]];
    s.chain.verdicts.set(c.txHash, { status: "final", transfers: [] });
    await s.cycle();
    expect([...s.store.data.candidates.values()][0]?.status).toBe("rejected");
  });

  it("ignores dust and never verifies it", async () => {
    const d = setup({
      assets: [
        settings({ amountPolicy: amountPolicy({ ...STRICT_AMOUNT_POLICY, dustThresholdUnits: 100_000n }) }),
      ],
    });
    d.chain.pages = [[candidate("ff", "0.000001", d.clock.now())]];
    d.chain.verdicts.set("ff".padEnd(64, "0"), new Error("must not be called"));
    await d.cycle();
    expect([...d.store.data.candidates.values()][0]?.status).toBe("dust");
    expect(d.store.data.transfers.size).toBe(0);
  });

  it("does not advance the cursor when storing candidates fails", async () => {
    s.chain.pages = [[candidate("gg", "10.01", s.clock.now())]];
    const original = s.store.run.bind(s.store);
    s.store.run = async (work) =>
      original(async (repos) => {
        const broken = {
          ...repos,
          candidates: {
            ...repos.candidates,
            insert: async () => {
              throw new Error("disk full");
            },
          },
        };
        return work(broken);
      });
    await expect(s.ingest.execute()).rejects.toThrow("disk full");
    expect(s.store.data.cursors.size).toBe(0);
  });

  it("credits a late payment within grace as paid_late, even when verified after grace", async () => {
    const { invoice } = await s.order("o1");
    s.clock.advance(40 * MIN); // after expiry (30) but within grace (90)
    await s.expire.execute();
    const c = candidate("hh", "10.01", s.clock.now());
    s.chain.pages = [[c]];
    await s.ingest.execute();
    s.clock.advance(120 * MIN); // provider outage: verification only after grace
    await s.verify.execute();
    await s.settle.execute();
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("completed");
    expect(s.store.data.outbox.some((e) => e.type === "invoice.paid_late")).toBe(true);
  });

  it("a late payment for an expired invoice cannot pay a new invoice: the slot is not reused", async () => {
    await s.order("o1");
    s.clock.advance(40 * MIN);
    const second = await s.order("o2");
    expect(second.invoice.state.instructions.amount.toDecimalString()).toBe("10.020000");
  });

  it("AML hold stops completion; an unavailable screener defers it", async () => {
    const { invoice } = await s.order("o1");
    s.clock.advance(MIN);
    s.chain.pages = [[candidate("ii", "10.01", s.clock.now())]];
    s.aml.verdict = { verdict: "unavailable", reason: "timeout" };
    expect(await s.cycle()).toMatchObject({ amlDeferred: 1 });
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("aml_pending");
    s.aml.verdict = { verdict: "hold", reason: "high risk" };
    expect(await s.settle.execute()).toMatchObject({ held: 1 });
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("aml_hold");
  });

  it("records the transfer key in the invoice payment", async () => {
    const { invoice } = await s.order("o1");
    s.clock.advance(MIN);
    const c = candidate("jj", "10.01", s.clock.now());
    s.chain.pages = [[c]];
    await s.cycle();
    expect(s.store.data.invoices.get(invoice.id)?.payments[0]?.transferKey).toBe(
      txRefKey(txRef(TRON, c.txHash, 0n)),
    );
  });

  it("never stores transfers for other assets or addresses", async () => {
    const fake = defineAsset({ ...USDT_TRON, id: "fake", contract: "TFakeContract1111111111111111111111" });
    s.chain.pages = [
      [
        { ...candidate("kk", "10.01", s.clock.now()), amount: Money.parse(fake, "10.01") },
        candidate("ll", "10.01", s.clock.now(), chainAddress(TRON, "TStranger11111111111111111111111")),
      ],
    ];
    expect(await s.ingest.execute()).toMatchObject({ ignored: 2, inserted: 0 });
  });
});
