// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { ManualRateTable } from "../adapters/pricing/manual-table.ts";
import { amountPolicy, STRICT_AMOUNT_POLICY, uniqueAmountPolicy } from "../domain/amount-policy.ts";
import { defineAsset } from "../domain/asset.ts";
import { chainAddress } from "../domain/chain-address.ts";
import type { InvoiceState } from "../domain/invoice.ts";
import { Money } from "../domain/money.ts";

import { TRON, USDT_TRON } from "../domain/test-fixtures.ts";
import { txRef, txRefKey } from "../domain/tx-ref.ts";
import { AssetCatalog, type AssetSettings } from "./catalog.ts";
import { ApplicationError } from "./errors.ts";
import type { Alert, AmlScreener, AmlVerdict, Clock, RateProvider, TransferCandidate } from "./ports.ts";
import { RateService } from "./rates.ts";
import { MemoStrategy } from "./strategies/memo.ts";
import { UniqueAmountStrategy } from "./strategies/unique-amount.ts";
import { FakeChain } from "./testing/fake-chain.ts";
import { InMemoryStore } from "./testing/in-memory.ts";
import { CreateInvoice } from "./use-cases/create-invoice.ts";
import { ExpireInvoices } from "./use-cases/expire-invoices.ts";
import { IngestTransfers } from "./use-cases/ingest-transfers.ts";
import { ScreenPayments } from "./use-cases/screen-payments.ts";
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
  return {
    network: TRON,
    txHash: hash.padEnd(64, "0"),
    from: "TSenderX",
    to,
    amount: usdt(amount),
    at,
    memo: null,
  };
}

const verified = (c: TransferCandidate, index: bigint, amount: string, to = ADDR_A) => ({
  ref: txRef(TRON, c.txHash, index),
  from: c.from,
  to,
  amount: usdt(amount),
  at: c.at,
  memo: c.memo,
});

function settings(over: Partial<AssetSettings> = {}): AssetSettings {
  return {
    asset: USDT_TRON,
    priceSymbol: "USDT",
    strategy: "unique-amount",
    addresses: [{ address: ADDR_A, status: "active", tokenAccount: null }],
    amountPolicy: STRICT_AMOUNT_POLICY,
    uniqueAmount: uniqueAmountPolicy({ stepUnits: 10_000n, maxSlots: 99 }),
    ttlMs: 30 * MIN,
    graceMs: 60 * MIN,
    amlThresholdUnits: 0n,
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

function setup(
  opts: {
    assets?: AssetSettings[];
    providers?: RateProvider[];
    memos?: string[];
    slotStart?: (n: number) => number;
    depeg?: { symbol: string; maxGuardAgeMs: number };
  } = {},
) {
  const clock = new FakeClock();
  const store = new InMemoryStore(() => clock.now());
  const chain = new FakeChain(TRON);
  const aml = new ScriptedAml();
  const catalog = new AssetCatalog(opts.assets ?? [settings()]);
  const uniqueAmount = new UniqueAmountStrategy(opts.slotStart);
  const memoQueue = [...(opts.memos ?? [])];
  const memo = new MemoStrategy({ newMemo: () => memoQueue.shift() ?? "ZZZZ9999" }, opts.slotStart);
  const strategies = (s: AssetSettings) => (s.strategy === "memo" ? memo : uniqueAmount);
  const integrity = {
    ok: true,
    reason: "pinned checksum mismatch",
    check: async () =>
      integrity.ok ? { ok: true as const } : { ok: false as const, reason: integrity.reason },
  };
  let n = 0;
  const alerts: Alert[] = [];
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
    strategies,
    clock,
    ids: { newId: () => `inv-${++n}` },
    integrity,
    depeg: opts.depeg ?? null,
    alerts: { send: async (a) => void alerts.push(a) },
  });
  const ingest = new IngestTransfers({
    adapter: chain,
    catalog,
    strategies,
    uow: store,
    clock,
    pageSize: 2,
    maxScans: 5,
    alerts: { send: async (a) => void alerts.push(a) },
  });
  const verify = new VerifyTransfers({ adapter: chain, catalog, uow: store, clock, batchSize: 50 });
  const settle = new SettlePayments({
    network: TRON,
    catalog,
    strategies,
    uow: store,
    clock,
    batchSize: 50,
  });
  const screen = new ScreenPayments({ catalog, aml, uow: store, clock, batchSize: 50 });
  const expire = new ExpireInvoices({ uow: store, clock, batchSize: 50 });
  const cycle = async () => {
    await ingest.execute();
    await verify.execute();
    const settled = await settle.execute();
    const screened = await screen.execute();
    return { ...settled, ...screened, errors: settled.errors + screened.errors };
  };
  const order = (
    id: string,
    amount = "10",
    cur = "USD",
    urls: { successUrl?: string; cancelUrl?: string } = {},
  ) =>
    create.execute({
      merchantOrderId: id,
      priceAmount: amount,
      priceCurrency: cur,
      assetId: "usdt-tron",
      ...urls,
    });
  return {
    store,
    clock,
    chain,
    aml,
    create,
    ingest,
    verify,
    settle,
    screen,
    expire,
    cycle,
    order,
    integrity,
    alerts,
  };
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
    const again = await s.order("o1", "10.00");
    expect(again.created).toBe(false);
    expect(again.invoice.id).toBe(a.invoice.id);
    expect(s.store.data.outbox.map((e) => e.type)).toEqual(["invoice.created", "invoice.created"]);
  });

  it("starts at a chosen slot and wraps around, so a just-freed pair is not the next one handed out", async () => {
    const starts = [5, 98, 0];
    const s = setup({ slotStart: () => starts.shift() ?? 0 });
    expect((await s.order("o1")).invoice.state.instructions.amount.toDecimalString()).toBe("10.060000");
    expect((await s.order("o2")).invoice.state.instructions.amount.toDecimalString()).toBe("10.990000");
    expect((await s.order("o3")).invoice.state.instructions.amount.toDecimalString()).toBe("10.010000");
    // the wrap-around finds the free slots before the start when the ones after it are taken
    const wrap = setup({ slotStart: () => 98 });
    await wrap.order("a");
    expect((await wrap.order("b")).invoice.state.instructions.amount.toDecimalString()).toBe("10.010000");
  });

  it("with depeg protection configured, a missing or stale guard reading blocks new invoices (fail closed)", async () => {
    const s = setup({ depeg: { symbol: "USDT", maxGuardAgeMs: 15 * MIN } });
    expect(await errCode(s.order("o1"))).toBe("pricing.depeg_block"); // no reading yet
    await s.store.run((r) => r.guards.set("depeg:USDT", false, "within 150 bps", s.clock.now()));
    expect((await s.order("o1")).created).toBe(true);
    s.clock.advance(16 * MIN); // the monitor stopped writing
    expect(await errCode(s.order("o2"))).toBe("pricing.depeg_block");
    await s.store.run((r) => r.guards.set("depeg:USDT", true, "off the peg", s.clock.now()));
    expect(await errCode(s.order("o3"))).toBe("pricing.depeg_block");
    // not configured: only an explicit block counts (nothing to be stale)
    const plain = setup();
    expect((await plain.order("o1")).created).toBe(true);
  });

  it("refuses the same merchant order with another price, currency or asset", async () => {
    const s = setup();
    await s.order("o1");
    expect(await errCode(s.order("o1", "999"))).toBe("invoice.order_mismatch");
    expect(await errCode(s.order("o1", "10", "JPY"))).toBe("invoice.order_mismatch");
    // Priced in the asset itself: the price is kept as given and compared exactly, in minimal units.
    const direct = await s.order("o2", "10", "USDT");
    expect(direct.invoice.state.instructions.amount.toDecimalString()).toBe("10.020000");
    expect((await s.order("o2", "10.00", "USDT")).created).toBe(false);
    expect(await errCode(s.order("o2", "11", "USDT"))).toBe("invoice.order_mismatch");
    // within the unique-amount steps of the invoice amount, but not the same price
    expect(await errCode(s.order("o2", "10.01", "USDT"))).toBe("invoice.order_mismatch");
    expect(await errCode(s.order("o2", "10", "USD"))).toBe("invoice.order_mismatch");
  });

  it("keeps a price in the asset's own symbol as given, without a rate", async () => {
    const s = setup();
    const { invoice } = await s.order("o1", "3.00", "USDT");
    expect(invoice.state.price).toEqual({
      amount: "3.00",
      currency: "USDT",
      rate: null,
      rateSource: null,
      rateAt: null,
      ratePath: null,
    });
    expect((s.store.data.invoices.get(invoice.id) as InvoiceState).price?.amount).toBe("3.00");
  });

  it("still matches an invoice priced in the asset before 0.5.0 (no stored price) by its amount", async () => {
    const s = setup();
    const { invoice } = await s.order("o1", "10", "USDT");
    const stored = s.store.data.invoices.get(invoice.id) as InvoiceState;
    s.store.data.invoices.set(invoice.id, { ...stored, price: null });
    expect((await s.order("o1", "10", "USDT")).created).toBe(false);
    expect(await errCode(s.order("o1", "11", "USDT"))).toBe("invoice.order_mismatch");
  });

  it("stores the return URLs; a retry with other URLs gets the invoice as it was created", async () => {
    const s = setup();
    const urls = { successUrl: "https://shop.example/ok", cancelUrl: "https://shop.example/back" };
    const a = await s.order("o1", "10", "USD", urls);
    expect(a.invoice.state).toMatchObject(urls);
    const again = await s.order("o1", "10", "USD", { successUrl: "https://shop.example/other" });
    expect(again.created).toBe(false);
    expect(again.invoice.state).toMatchObject(urls);
    expect((await s.order("o2")).invoice.state).toMatchObject({ successUrl: null, cancelUrl: null });
  });

  it("a concurrent create for the same order answers with the invoice that won", async () => {
    const s = setup();
    const first = await s.order("o1");
    // Simulate the race: the duplicate check passes, the insert then hits the unique constraint.
    const run = s.store.run.bind(s.store);
    let armed = true;
    s.store.run = async (work) =>
      run(async (repos) => {
        if (!armed) return work(repos);
        armed = false;
        return work({
          ...repos,
          invoices: { ...repos.invoices, findByMerchantOrderId: async () => null },
        });
      });
    const again = await s.order("o1");
    expect(again.created).toBe(false);
    expect(again.invoice.id).toBe(first.invoice.id);
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
    expect(invoice.state.price).toMatchObject({ amount: "5", currency: "USDT", rate: null });
  });

  it("refuses to issue payment instructions when the pinned config was tampered with", async () => {
    const s = setup();
    s.integrity.ok = false;
    expect(await errCode(s.order("o1"))).toBe("integrity.pin_violation");
    expect(s.store.data.invoices.size).toBe(0);
  });

  it("the integrity reason stays with the operator: the API caller never sees a config path or file fragment", async () => {
    const s = setup();
    s.integrity.ok = false;
    s.integrity.reason =
      'config unreadable: cannot read config /etc/nocustody/config.json: Unexpected token "x"';
    const message = await s.order("o1").then(
      () => "",
      (e: Error) => e.message,
    );
    expect(message).not.toContain("/etc/");
    expect(message).not.toContain("Unexpected token");
    expect(message).toContain("blocked");
  });

  it("answers an existing order before quoting: a stale rate or a depeg block does not hide it", async () => {
    const s = setup({ providers: [manual([["USD", "USDT", "1"]], 0, 60 * MIN)] });
    const first = await s.order("o1");
    s.clock.advance(2 * 60 * MIN); // the only rate is now stale
    expect(await errCode(s.order("o2"))).toBe("pricing.no_rate");
    const again = await s.order("o1");
    expect(again.created).toBe(false);
    expect(again.invoice.id).toBe(first.invoice.id);
    await s.store.run((r) => r.guards.set("depeg:USDT", true, "off the peg", s.clock.now()));
    expect((await s.order("o1")).created).toBe(false);
    expect(await errCode(s.order("o3", "10", "USDT"))).toBe("pricing.depeg_block");
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
            { address: ADDR_A, status: "active", tokenAccount: null },
            {
              address: chainAddress(TRON, "TDrain1111111111111111111111111111"),
              status: "draining",
              tokenAccount: null,
            },
            { address: ADDR_B, status: "active", tokenAccount: null },
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
    expect(s.alerts.at(-1)).toMatchObject({ key: "slots-exhausted:usdt-tron", severity: "critical" });
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

  it("one candidate whose result cannot be stored does not stop the others or the settlement", async () => {
    const a = await s.order("o1");
    const b = await s.order("o2");
    s.clock.advance(MIN);
    const bad = candidate("c1", "10.01", s.clock.now());
    const good = candidate("c2", "10.02", s.clock.now());
    s.chain.pages = [[bad, good]];
    // PostgreSQL refuses some values (e.g. U+0000 in text): emulate a failing insert for one transfer only.
    const run = s.store.run.bind(s.store);
    s.store.run = async (work) =>
      run((repos) =>
        work({
          ...repos,
          transfers: {
            ...repos.transfers,
            insert: async (t, status, reason) => {
              if (t.ref.txHash === bad.txHash)
                throw new Error("invalid byte sequence for encoding UTF8: 0x00");
              return repos.transfers.insert(t, status, reason);
            },
          },
        }),
      );
    expect(await s.cycle()).toMatchObject({ matched: 1 });
    expect(s.store.data.invoices.get(b.invoice.id)?.status).toBe("completed");
    expect(s.store.data.invoices.get(a.invoice.id)?.status).toBe("confirming");
    const stored = s.store.data.candidates.get(`${TRON}/${bad.txHash}/${USDT_TRON.id}`);
    expect(stored).toMatchObject({ status: "seen", attempts: 1 });
    expect(stored?.reason).toContain("store error");
    expect(s.store.data.candidates.get(`${TRON}/${good.txHash}/${USDT_TRON.id}`)?.status).toBe("verified");
  });

  it("rejects a transfer the adapter returns for a foreign address or another asset", async () => {
    await s.order("o1");
    s.clock.advance(MIN);
    const c = candidate("c3", "10.01", s.clock.now());
    s.chain.pages = [[c]];
    s.chain.verdicts.set(c.txHash, { status: "final", transfers: [verified(c, 0n, "10.01", ADDR_B)] });
    expect(await s.cycle()).toMatchObject({ matched: 0, unmatched: 0 });
    const stored = s.store.data.candidates.get(`${TRON}/${c.txHash}/${USDT_TRON.id}`);
    expect(stored?.status).toBe("rejected");
    expect(stored?.reason).toContain(ADDR_B.value);
    expect(s.store.data.transfers.size).toBe(0);
  });

  it("a transfer settled by another worker between list and write is recorded once", async () => {
    const { invoice } = await s.order("o1");
    s.clock.advance(MIN);
    const matched = candidate("w1", "10.01", s.clock.now());
    const stray = candidate("w2", "10.05", s.clock.now());
    s.chain.pages = [[matched, stray]];
    await s.ingest.execute();
    await s.verify.execute();
    // Emulate the other worker's commit landing between listVerified and this worker's write: the row is no
    // longer "verified" by the time markMatched / markUnmatched runs, so they must report false and nothing more
    // may be recorded for the transfer.
    const run = s.store.run.bind(s.store);
    const taken = (ref: { txHash: string }, status: "matched" | "unmatched") => {
      const key = txRefKey(txRef(TRON, ref.txHash, 0n));
      const cur = s.store.data.transfers.get(key);
      if (cur) s.store.data.transfers.set(key, { ...cur, status });
    };
    s.store.run = async (work) =>
      run((repos) =>
        work({
          ...repos,
          transfers: {
            ...repos.transfers,
            markMatched: async (ref, invoiceId) => {
              taken(ref, "matched");
              return repos.transfers.markMatched(ref, invoiceId);
            },
            markUnmatched: async (ref, reason) => {
              taken(ref, "unmatched");
              return repos.transfers.markUnmatched(ref, reason);
            },
          },
        }),
      );
    const outboxBefore = s.store.data.outbox.length;
    const auditBefore = s.store.data.audit.length;
    expect(await s.settle.execute()).toMatchObject({ matched: 0, unmatched: 0, errors: 0 });
    expect(s.store.data.outbox.length).toBe(outboxBefore); // no second transfer.unmatched, no second credit
    expect(s.store.data.audit.length).toBe(auditBefore);
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("confirming");
  });

  it("a transfer that landed before the invoice existed is never claimed by it (someone else's money)", async () => {
    // ADR-0030: an attacker watches the address, sees an unmatched 10.01 USDT land at T and opens an invoice for
    // 10 USD (→ 10.01) 20 s later, inside the old 30 s skew. The transfer must stay unmatched.
    const c = candidate("at", "10.01", s.clock.now());
    s.clock.advance(20_000);
    const { invoice } = await s.order("o1");
    s.chain.pages = [[c]];
    expect(await s.cycle()).toMatchObject({ matched: 0, unmatched: 1 });
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("awaiting_payment");
    expect(s.store.data.outbox.at(-1)?.type).toBe("transfer.unmatched");
    // a genuine payment seconds after the invoice, with the gateway's clock 3 s ahead of the chain, is credited
    const late = candidate("ok", "10.01", new Date(s.clock.now().getTime() - 3_000));
    s.chain.pages.push([late]); // the fake's cursor is at page 1 now
    expect(await s.cycle()).toMatchObject({ matched: 1 });
  });

  it("a dust hint does not bury a real payment: a later non-dust hint for the same transaction re-queues it", async () => {
    const dusty = setup({
      assets: [
        settings({ amountPolicy: amountPolicy({ ...STRICT_AMOUNT_POLICY, dustThresholdUnits: 100_000n }) }),
      ],
    });
    const { invoice } = await dusty.order("o1");
    dusty.clock.advance(MIN);
    const tx = candidate("dd1", "0.05", dusty.clock.now()); // the indexer's first row: a dust transfer of the tx
    dusty.chain.pages = [[tx]];
    await dusty.cycle();
    expect(dusty.store.data.candidates.get(`${TRON}/${tx.txHash}/${USDT_TRON.id}`)?.status).toBe("dust");
    // the second source (or a later page) reports the real transfer of the same transaction
    dusty.chain.pages.push([{ ...tx, amount: usdt("10.01") }]);
    expect(await dusty.cycle()).toMatchObject({ matched: 1 });
    expect(dusty.store.data.invoices.get(invoice.id)?.status).toBe("completed");
    expect(dusty.store.data.candidates.get(`${TRON}/${tx.txHash}/${USDT_TRON.id}`)?.status).toBe("verified");
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

  it("alerts when rows are still unread after every scan of the cycle: the scanner lags behind the chain", async () => {
    s.chain.alwaysMore = true;
    s.chain.pages = [[]];
    expect(await s.ingest.execute()).toMatchObject({ exhausted: 1 });
    expect(s.chain.fetches).toBe(5);
    expect(s.alerts.at(-1)).toMatchObject({ key: "scanner-budget:usdt-tron", severity: "warning" });
  });

  it("follows `more` from one stored cursor to the next and stops when the adapter has caught up", async () => {
    s.chain.pages = [[candidate("p1", "1", s.clock.now())], [], [candidate("p3", "2", s.clock.now())]];
    expect(await s.ingest.execute()).toMatchObject({ fetched: 2, inserted: 2, exhausted: 0 });
    expect(s.chain.fetches).toBe(3);
    expect(await s.store.run((r) => r.cursors.get(TRON, "usdt-tron"))).toBe("3");
    expect(s.alerts.some((a) => a.key.startsWith("scanner-budget"))).toBe(false);
  });

  it("does not re-read the indexer because a fully read scan returned many candidates", async () => {
    // pageSize is 2: before `more`, a result of ≥ 2 candidates was taken for "there is another page"
    s.chain.pages = [["q1", "q2", "q3"].map((h) => candidate(h, "1", s.clock.now()))];
    expect(await s.ingest.execute()).toMatchObject({ inserted: 3, duplicates: 0 });
    expect(s.chain.fetches).toBe(1);
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
    await s.screen.execute();
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
    expect(await s.cycle()).toMatchObject({ deferred: 1 });
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("aml_pending");
    s.aml.verdict = { verdict: "hold", reason: "high risk" };
    expect(await s.screen.execute()).toMatchObject({ held: 1 });
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

describe("memo strategy (one wallet, comment identifies the invoice)", () => {
  const memoAsset = (over: Partial<AssetSettings> = {}) => settings({ strategy: "memo", ...over });
  const withMemo = (c: TransferCandidate, memo: string | null): TransferCandidate => ({ ...c, memo });

  it("allocates a unique memo plus a fallback unique amount; memos are never reused", async () => {
    const s = setup({ assets: [memoAsset()], memos: ["AAAA2222", "AAAA2222", "BBBB3333"] });
    const a = await s.order("o1");
    const b = await s.order("o2"); // first candidate collides, the next one is used
    expect(a.invoice.state.instructions).toMatchObject({ memo: "AAAA2222" });
    expect(a.invoice.state.instructions.amount.toDecimalString()).toBe("10.010000");
    expect(b.invoice.state.instructions.memo).toBe("BBBB3333");
    expect(b.invoice.state.instructions.amount.toDecimalString()).toBe("10.020000");
  });

  it("issues memo-only invoices when amount slots are exhausted", async () => {
    const s = setup({
      assets: [memoAsset({ uniqueAmount: uniqueAmountPolicy({ stepUnits: 10_000n, maxSlots: 1 }) })],
      memos: ["AAAA2222", "BBBB3333"],
    });
    await s.order("o1");
    const b = await s.order("o2");
    expect(b.invoice.state.instructions.memo).toBe("BBBB3333");
    expect(b.invoice.state.instructions.amount.toDecimalString()).toBe("10.000000"); // base price, no slot
  });

  it("matches by memo regardless of case and surrounding spaces", async () => {
    const s = setup({ assets: [memoAsset()], memos: ["AAAA2222"] });
    const { invoice } = await s.order("o1");
    s.clock.advance(MIN);
    s.chain.pages = [[withMemo(candidate("m1", "10.01", s.clock.now()), "  aaaa2222 ")]];
    expect(await s.cycle()).toMatchObject({ matched: 1, completed: 1 });
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("completed");
    expect(s.store.data.audit.find((a) => a.decision === "matched")?.data?.by).toBe("memo");
  });

  it("with a memo the amount may differ: underpaid, then topped up with the same memo", async () => {
    const s = setup({ assets: [memoAsset()], memos: ["AAAA2222"] });
    const { invoice } = await s.order("o1");
    s.clock.advance(MIN);
    s.chain.pages = [[withMemo(candidate("m2", "10", s.clock.now()), "AAAA2222")]];
    await s.cycle();
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("underpaid");
    s.chain.pages = [...s.chain.pages, [withMemo(candidate("m3", "0.01", s.clock.now()), "AAAA2222")]];
    await s.cycle();
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("completed");
  });

  it("a payer who forgot the memo is matched by the unique amount", async () => {
    const s = setup({ assets: [memoAsset()], memos: ["AAAA2222"] });
    const { invoice } = await s.order("o1");
    s.clock.advance(MIN);
    s.chain.pages = [[withMemo(candidate("m4", "10.01", s.clock.now()), null)]];
    await s.cycle();
    expect(s.store.data.invoices.get(invoice.id)?.status).toBe("completed");
    expect(s.store.data.audit.find((a) => a.decision === "matched")?.data?.by).toBe("amount");
  });

  it("an unknown memo with a non-matching amount is quarantined; free text never matches", async () => {
    const s = setup({ assets: [memoAsset()], memos: ["AAAA2222"] });
    await s.order("o1");
    s.clock.advance(MIN);
    s.chain.pages = [
      [
        withMemo(candidate("m5", "3", s.clock.now()), "ZZZZ8888"),
        withMemo(candidate("m6", "3", s.clock.now()), "thanks for the coffee, AAAA2222"),
      ],
    ];
    expect(await s.cycle()).toMatchObject({ unmatched: 2, matched: 0 });
  });

  it("a memo only matches payments to its own address", async () => {
    const s = setup({
      assets: [
        memoAsset({
          addresses: [
            { address: ADDR_A, status: "active", tokenAccount: null },
            { address: ADDR_B, status: "draining", tokenAccount: null },
          ],
        }),
      ],
      memos: ["AAAA2222"],
    });
    await s.order("o1");
    s.clock.advance(MIN);
    s.chain.pages = [[withMemo(candidate("m7", "5", s.clock.now(), ADDR_B), "AAAA2222")]];
    expect(await s.cycle()).toMatchObject({ unmatched: 1 });
  });
});
