// SPDX-License-Identifier: Apache-2.0
// Integration tests against PostgreSQL (TEST_DATABASE_URL, provided by docker compose and CI).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AssetCatalog } from "../../../application/catalog.ts";
import { ConcurrencyError } from "../../../application/errors.ts";
import { RateService } from "../../../application/rates.ts";
import { UniqueAmountStrategy } from "../../../application/strategies/unique-amount.ts";
import { FakeChain } from "../../../application/testing/fake-chain.ts";
import { CreateInvoice } from "../../../application/use-cases/create-invoice.ts";
import { IngestTransfers } from "../../../application/use-cases/ingest-transfers.ts";
import { SettlePayments } from "../../../application/use-cases/settle-payments.ts";
import { VerifyTransfers } from "../../../application/use-cases/verify-transfers.ts";
import { STRICT_AMOUNT_POLICY, uniqueAmountPolicy } from "../../../domain/amount-policy.ts";
import { amountSlot } from "../../../domain/amount-slot.ts";
import { chainAddress } from "../../../domain/chain-address.ts";
import { Money } from "../../../domain/money.ts";
import { TRON, USDT_TRON } from "../../../domain/test-fixtures.ts";
import { txRef } from "../../../domain/tx-ref.ts";
import { NoopAmlScreener } from "../../aml/noop.ts";
import { ManualRateTable } from "../../pricing/manual-table.ts";
import { migrate } from "./migrate.ts";
import { PgUnitOfWork } from "./unit-of-work.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required for integration tests");

const pool = new pg.Pool({ connectionString: url, max: 5 });
const MIN = 60_000;
const ADDR = chainAddress(TRON, "TAddrA111111111111111111111111111");
const usdt = (d: string) => Money.parse(USDT_TRON, d);
const assets = new Map([[USDT_TRON.id, USDT_TRON]]);

async function resetSchema(): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool);
}

afterAll(async () => {
  await pool.end();
});

describe("migrations", () => {
  beforeEach(resetSchema);

  it("are idempotent", async () => {
    expect((await migrate(pool)).applied).toEqual([]);
  });

  it("refuse to run when an applied migration was modified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    const original = readFileSync(join(import.meta.dirname, "migrations", "0001_initial.sql"), "utf8");
    writeFileSync(join(dir, "0001_initial.sql"), `${original}\n-- edited`);
    await expect(migrate(pool, dir)).rejects.toThrow("was modified");
  });
});

describe("PostgreSQL repositories", () => {
  beforeEach(resetSchema);
  const uow = new PgUnitOfWork(pool, assets);
  const T0 = new Date("2026-10-26T12:00:00Z");

  it("the database refuses overlapping amount slots for the same pair", async () => {
    const slot = (id: string, fromMs: number, untilMs: number) =>
      amountSlot({
        invoiceId: id,
        address: ADDR,
        amount: usdt("10.01"),
        from: new Date(T0.getTime() + fromMs),
        until: new Date(T0.getTime() + untilMs),
      });
    // FK to invoices is deferred to commit time: insert slots only, then roll back.
    await expect(
      uow.run(async (r) => {
        expect(await r.slots.tryInsert(slot("a", 0, 90 * MIN))).toBe(true);
        expect(await r.slots.tryInsert(slot("b", 60 * MIN, 150 * MIN))).toBe(false); // overlaps
        expect(await r.slots.tryInsert(slot("c", 90 * MIN + 10_000, 150 * MIN))).toBe(false); // within skew margin
        expect(await r.slots.tryInsert(slot("d", 91 * MIN, 150 * MIN))).toBe(true);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
  });

  it("stores each candidate tx once and each transfer once: UNIQUE(network, tx_hash, log_index)", async () => {
    const hash = "a".repeat(64);
    const c = {
      network: TRON,
      txHash: hash,
      from: "TSender",
      to: ADDR,
      amount: usdt("10.01"),
      at: T0,
      memo: null,
    };
    const t = {
      ref: txRef(TRON, hash, 0n),
      from: "TSender",
      to: ADDR,
      amount: usdt("10.01"),
      at: T0,
      memo: "ABCD2345",
    };
    await uow.run(async (r) => {
      expect(await r.candidates.insert(c, "seen", null)).toBe("inserted");
      expect(await r.candidates.insert(c, "seen", null)).toBe("duplicate");
      expect(await r.transfers.insert(t, "verified", null)).toBe("inserted");
      expect(await r.transfers.insert(t, "verified", null)).toBe("duplicate");
      expect(await r.transfers.insert({ ...t, ref: txRef(TRON, hash, 1n) }, "verified", null)).toBe(
        "inserted",
      );
      // settling is conditional on status = 'verified': a second worker that lists the same row loses
      expect(await r.transfers.markUnmatched(t.ref, "no slot")).toBe(true);
      expect(await r.transfers.markUnmatched(t.ref, "no slot")).toBe(false);
      expect(await r.transfers.markUnmatched(txRef(TRON, hash, 1n), "no slot")).toBe(true);
      expect(await r.transfers.markUnmatched(txRef(TRON, hash, 1n), "again")).toBe(false);
    });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM observed_transfers");
    expect(rows[0].n).toBe(2);
  });

  it("memos are unique per network forever", async () => {
    await expect(
      uow.run(async (r) => {
        expect(await r.memos.tryInsert(TRON, "ABCD2345", "inv-a", ADDR, "usdt-tron")).toBe(true);
        expect(await r.memos.tryInsert(TRON, "ABCD2345", "inv-b", ADDR, "usdt-tron")).toBe(false);
        expect(await r.memos.find(TRON, "ABCD2345")).toEqual({
          invoiceId: "inv-a",
          address: ADDR,
          assetId: "usdt-tron",
        });
        expect(await r.memos.find(TRON, "NOPE2345")).toBeNull();
        throw new Error("rollback"); // deferred FK to invoices
      }),
    ).rejects.toThrow("rollback");
  });

  it("outbox delivery: parallel claims never return the same event; leases, failures, dead-letter", async () => {
    await uow.run((r) =>
      r.outbox.append(
        Array.from({ length: 6 }, (_, i) => ({
          type: "invoice.paid",
          aggregateId: `inv-${i}`,
          occurredAt: T0,
          data: { i },
        })),
      ),
    );
    const [a, b] = await Promise.all([
      uow.run((r) => r.delivery.claim(T0, 60_000, 4)),
      uow.run((r) => r.delivery.claim(T0, 60_000, 4)),
    ]);
    const ids = [...(a ?? []), ...(b ?? [])].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
    expect(await uow.run((r) => r.delivery.claim(T0, 60_000, 10))).toEqual([]); // all leased
    const first = a?.[0] ?? b?.[0];
    if (!first) throw new Error("nothing claimed");
    expect(first.eventId).toMatch(/^[0-9a-f-]{36}$/);
    await uow.run((r) => r.delivery.markFailed(first.id, new Date(T0.getTime() + 1_000), "HTTP 503"));
    const later = await uow.run((r) => r.delivery.claim(new Date(T0.getTime() + 2_000), 60_000, 10));
    expect(later.map((m) => [m.id, m.attempts])).toEqual([[first.id, 1]]);
    await uow.run((r) => r.delivery.markDead(first.id, T0, "gave up"));
    await uow.run((r) => r.delivery.markDelivered(ids[1] ?? "", T0));
    const { rows } = await pool.query(
      "SELECT count(*) FILTER (WHERE dead_at IS NOT NULL)::int AS dead, count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered FROM outbox",
    );
    expect(rows[0]).toEqual({ dead: 1, delivered: 1 });
  });

  it("api keys and idempotency keys", async () => {
    const key = {
      id: "0123456789ab",
      name: "shop",
      secretSha256: "a".repeat(64),
      scopes: ["invoices:read" as const],
      revokedAt: null,
    };
    await uow.run((r) => r.apiKeys.insert(key));
    expect(await uow.run((r) => r.apiKeys.findById(key.id))).toEqual(key);
    expect(await uow.run((r) => r.apiKeys.revoke(key.id, T0))).toBe(true);
    expect(await uow.run((r) => r.apiKeys.revoke(key.id, T0))).toBe(false);
    expect((await uow.run((r) => r.apiKeys.findById(key.id)))?.revokedAt).toEqual(T0);
  });

  it("ops: heartbeats, guards, dead-letter revival, verified candidates for reconciliation", async () => {
    await uow.run(async (r) => {
      await r.heartbeats.ok("scanner:tron:mainnet", T0);
      await r.heartbeats.error("scanner:tron:mainnet", T0, "HTTP 503");
      await r.guards.set("depeg:USDT", true, "off peg", T0);
      await r.outbox.append([{ type: "x", aggregateId: "a", occurredAt: T0, data: {} }]);
    });
    expect(await uow.run((r) => r.heartbeats.list())).toEqual([
      { role: "scanner:tron:mainnet", lastOkAt: T0, lastErrorAt: T0, lastError: "HTTP 503" },
    ]);
    expect(await uow.run((r) => r.guards.get("depeg:USDT"))).toEqual({
      blocked: true,
      reason: "off peg",
      updatedAt: T0,
    });
    const [m] = await uow.run((r) => r.delivery.claim(T0, 1_000, 10));
    await uow.run((r) => r.delivery.markDead(m?.id ?? "", T0, "gave up"));
    expect(await uow.run((r) => r.delivery.countDead())).toBe(1);
    expect(await uow.run((r) => r.delivery.reviveDead(T0))).toBe(1);
    expect(await uow.run((r) => r.delivery.countDead())).toBe(0);
    const c = {
      network: TRON,
      txHash: "d".repeat(64),
      from: "TSender",
      to: ADDR,
      amount: usdt("1"),
      at: T0,
      memo: null,
    };
    await uow.run(async (r) => {
      await r.candidates.insert(c, "seen", null);
      await r.candidates.markVerified(TRON, c.txHash);
    });
    expect(
      await uow.run((r) => r.candidates.listVerified(TRON, ADDR, new Date(T0.getTime() - 1), T0)),
    ).toEqual([c.txHash]);
  });

  it("rolls back state, outbox and cursor together", async () => {
    await expect(
      uow.run(async (r) => {
        await r.outbox.append([{ type: "x", aggregateId: "a", occurredAt: T0, data: {} }]);
        await r.cursors.set(TRON, "usdt-tron", "c1");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const { rows } = await pool.query(
      "SELECT (SELECT count(*) FROM outbox)::int AS o, (SELECT count(*) FROM scan_cursors)::int AS c",
    );
    expect(rows[0]).toEqual({ o: 0, c: 0 });
  });

  it("full flow on PostgreSQL: invoice → transfer → completed, outbox written, invoice round-trips", async () => {
    let now = T0.getTime();
    const clock = { now: () => new Date(now) };
    const catalog = new AssetCatalog([
      {
        asset: USDT_TRON,
        priceSymbol: "USDT",
        strategy: "unique-amount",
        addresses: [{ address: ADDR, status: "active", tokenAccount: null }],
        amountPolicy: STRICT_AMOUNT_POLICY,
        uniqueAmount: uniqueAmountPolicy({ stepUnits: 10_000n, maxSlots: 99 }),
        ttlMs: 30 * MIN,
        graceMs: 60 * MIN,
        amlThresholdUnits: 0n,
      },
    ]);
    const uniqueAmount = new UniqueAmountStrategy();
    const strategies = () => uniqueAmount;
    const chain = new FakeChain(TRON);
    let n = 0;
    const create = new CreateInvoice({
      uow,
      catalog,
      pricing: { currencies: new Set(["USD"]), markupBps: new Map() },
      rates: new RateService([
        new ManualRateTable([{ base: "USD", quote: "USDT", rate: "1", setAt: T0, maxAgeMs: 60 * MIN }]),
      ]),
      strategies,
      clock,
      ids: { newId: () => `00000000-0000-4000-8000-00000000000${++n}` },
      integrity: { check: async () => ({ ok: true }) },
    });
    const a = await create.execute({
      merchantOrderId: "o1",
      priceAmount: "10",
      priceCurrency: "USD",
      assetId: "usdt-tron",
    });
    const b = await create.execute({
      merchantOrderId: "o2",
      priceAmount: "10",
      priceCurrency: "USD",
      assetId: "usdt-tron",
    });
    expect(b.invoice.state.instructions.amount.toDecimalString()).toBe("10.020000");
    expect(
      (
        await create.execute({
          merchantOrderId: "o1",
          priceAmount: "10",
          priceCurrency: "USD",
          assetId: "usdt-tron",
        })
      ).created,
    ).toBe(false);

    now += MIN;
    const c = {
      network: TRON,
      txHash: "b".repeat(64),
      from: "TSender",
      to: ADDR,
      amount: usdt("10.01"),
      at: clock.now(),
      memo: null,
    };
    chain.pages = [[c]];
    chain.verdicts.set(c.txHash, { status: "final", transfers: [{ ...c, ref: txRef(TRON, c.txHash, 3n) }] });
    await new IngestTransfers({
      adapter: chain,
      catalog,
      strategies,
      uow,
      clock,
      pageSize: 10,
      maxPages: 2,
    }).execute();
    await new VerifyTransfers({ adapter: chain, catalog, uow, clock, batchSize: 10 }).execute();
    const stats = await new SettlePayments({
      network: TRON,
      catalog,
      strategies,
      aml: new NoopAmlScreener(),
      uow,
      clock,
      batchSize: 10,
    }).execute();
    expect(stats).toMatchObject({ matched: 1, completed: 1 });

    const stored = await uow.run((r) => r.invoices.findById(a.invoice.id));
    expect(stored?.status).toBe("completed");
    expect(stored?.state.payments.map((p) => [p.transferKey, p.amount.units])).toEqual([
      [`tron:mainnet/${"b".repeat(64)}/3`, 10_010_000n],
    ]);
    expect(stored?.state.price?.rateAt).toEqual(T0);
    const outbox = await pool.query<{ type: string }>("SELECT type FROM outbox ORDER BY id");
    expect(outbox.rows.map((r) => r.type)).toEqual([
      "invoice.created",
      "invoice.created",
      "invoice.transfer_detected",
      "invoice.paid",
      "invoice.aml_pending",
      "invoice.completed",
    ]);
    const cursor = await uow.run((r) => r.cursors.get(TRON, "usdt-tron"));
    expect(cursor).toBe("1");
  });

  it("detects concurrent modification of an invoice", async () => {
    const uniqueAmount = new UniqueAmountStrategy();
    const strategies = () => uniqueAmount;
    const catalog = new AssetCatalog([
      {
        asset: USDT_TRON,
        priceSymbol: "USDT",
        strategy: "unique-amount",
        addresses: [{ address: ADDR, status: "active", tokenAccount: null }],
        amountPolicy: STRICT_AMOUNT_POLICY,
        uniqueAmount: uniqueAmountPolicy({ stepUnits: 10_000n, maxSlots: 9 }),
        ttlMs: 30 * MIN,
        graceMs: 60 * MIN,
        amlThresholdUnits: 0n,
      },
    ]);
    const clock = { now: () => T0 };
    const create = new CreateInvoice({
      uow,
      catalog,
      pricing: { currencies: new Set(), markupBps: new Map() },
      rates: new RateService([]),
      strategies,
      clock,
      ids: { newId: () => "inv-x" },
      integrity: { check: async () => ({ ok: true }) },
    });
    await create.execute({
      merchantOrderId: "o1",
      priceAmount: "1",
      priceCurrency: "USDT",
      assetId: "usdt-tron",
    });
    const first = await uow.run((r) => r.invoices.findById("inv-x"));
    const second = await uow.run((r) => r.invoices.findById("inv-x"));
    first?.cancel(T0);
    second?.cancel(T0);
    await uow.run((r) => r.invoices.update(first as NonNullable<typeof first>));
    await expect(
      uow.run((r) => r.invoices.update(second as NonNullable<typeof second>)),
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });
});
