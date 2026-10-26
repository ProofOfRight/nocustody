// SPDX-License-Identifier: Apache-2.0
// Operations end to end, live: reconciliation heals a payment the primary scanner "missed". The primary ingest is
// never run here; a second source (Tronscan on Nile, tonapi on the TON testnet) reports the recorded payments, they
// become candidates, and the normal verifier confirms them through finalized queries (walletsolidity / toncenter).
// Also checks depeg protection against Kraken and Coinbase and the scanner heartbeat. RESETS TEST_DATABASE_URL.
import pg from "pg";
import { migrate } from "../src/adapters/persistence/pg/migrate.ts";
import { parseConfig } from "../src/app/config.ts";
import { addressValidators, buildContainer } from "../src/app/container.ts";
import { requireTestDatabase } from "./test-database.ts";

const url = requireTestDatabase(process.env.TEST_DATABASE_URL);
const admin = new pg.Pool({ connectionString: url });
await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await migrate(admin);
await admin.end();

const TRON_PAYMENT = { to: "TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq", at: 1792970475000, price: "0.99" }; // 1.00 USDT
const TON_PAYMENT = { at: 1792965972000, memo: "586935205", price: "1.217528" }; // 1.227528 test USDT, by memo
const config = parseConfig(
  {
    database: { urlEnv: "TEST_DATABASE_URL" },
    tron: { network: "tron:nile", apiUrl: "https://nile.trongrid.io", startFrom: "2026-10-25T00:00:00Z" },
    ton: {
      network: "ton:testnet",
      apiUrl: "https://testnet.toncenter.com",
      startFrom: "2026-10-25T00:00:00Z",
    },
    assets: [
      {
        id: "usdt-nile",
        network: "tron:nile",
        kind: "token",
        contract: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
        decimals: 6,
        symbol: "USDT",
        priceSymbol: "USDT",
        addresses: [{ address: TRON_PAYMENT.to, status: "active" }],
        amounts: { step: "0.01", maxSlots: 99 },
      },
      {
        id: "usdt-ton-testnet",
        network: "ton:testnet",
        kind: "token",
        contract: "0:F418A04CF196EBC959366844A6CDF53A6FD6FFF1EADAFC892F05210BBA31593E",
        decimals: 6,
        symbol: "USDT",
        priceSymbol: "USDT",
        strategy: "memo",
        addresses: [
          {
            address: "0:326BCAF1F252CA9E3458FE73348566AFE805F7C5B40339277260BCB2FC8762B0",
            status: "active",
            jettonWallet: "0:58594DDBF5AAE9EFF2BAF115DA69590BE38E07E89E79768915FDA3089C190F6B",
          },
        ],
        amounts: { step: "0.01", maxSlots: 99 },
      },
    ],
    pricing: {},
    ops: {
      reconcile: {
        lookback: "15m",
        settleDelay: "1m",
        tron: { apiUrl: "https://nileapi.tronscan.org" },
        ton: { apiUrl: "https://testnet.tonapi.io" },
      },
      depeg: { maxDeviationBps: 150 },
    },
  },
  addressValidators,
);
let now = 0;
const memos = [TON_PAYMENT.memo];
const c = buildContainer({
  config,
  databaseUrl: url,
  integrity: { check: async () => ({ ok: true }) },
  clock: { now: () => new Date(now) },
  memos: { newMemo: () => memos.shift() ?? "ZZZZ9999" },
});
let ok = true;
const check = (cond: boolean, what: string) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  ok &&= cond;
};
try {
  // Live depeg check (Kraken + Coinbase).
  now = Date.now();
  const depeg = await c.monitor.checkDepeg();
  console.log(`depeg: ${JSON.stringify(depeg)}`);
  check(depeg?.blocked === false, "USDT/USD within 150 bps at Kraken and Coinbase, invoices allowed");

  // Invoices created shortly before the recorded payments.
  now = TRON_PAYMENT.at - 120_000;
  const tronInv = await c.createInvoice.execute({
    merchantOrderId: "ops-tron",
    priceAmount: TRON_PAYMENT.price,
    priceCurrency: "USDT",
    assetId: "usdt-nile",
  });
  now = TON_PAYMENT.at - 120_000;
  const tonInv = await c.createInvoice.execute({
    merchantOrderId: "ops-ton",
    priceAmount: TON_PAYMENT.price,
    priceCurrency: "USDT",
    assetId: "usdt-ton-testnet",
  });

  // Heartbeat: nothing has scanned yet, the monitor must complain.
  const health = await c.monitor.checkHealth();
  check(
    health.some((p) => p.includes("tron:nile")) && health.some((p) => p.includes("ton:testnet")),
    "monitor reports scanners that never ran",
  );

  // Reconcile shortly after each payment: the primary ingest never ran, so every reported transfer is "missed".
  let missed = 0;
  for (const at of [TRON_PAYMENT.at, TON_PAYMENT.at]) {
    now = at + 5 * 60_000;
    const stats = await c.monitor.reconcile();
    console.log(`reconcile @${new Date(at).toISOString()}: ${JSON.stringify(stats)}`);
    missed += stats.missedByPrimary;
  }
  check(missed >= 2, "second sources reported the payments the primary scanner never saw");

  // The normal verifier and settlement take it from here (truth = finalized queries of the primary providers).
  now = TRON_PAYMENT.at + 10 * 60_000;
  for (const w of c.workers) {
    for (let i = 0; i < 3; i++) {
      await w.verify.execute();
      await w.settle.execute();
    }
  }
  const status = async (id: string) => (await c.uow.run((r) => r.invoices.findById(id)))?.status;
  check((await status(tronInv.invoice.id)) === "completed", "TRON invoice completed via reconciliation");
  check(
    (await status(tonInv.invoice.id)) === "completed",
    "TON invoice completed via reconciliation (by memo)",
  );
  const audit = await c.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE decision = 'reconciled'");
  console.log(`audit 'reconciled' entries: ${audit.rows[0].n}`);
} finally {
  await c.pool.end();
}
console.log(ok ? "E2E OPS OK" : "E2E OPS FAILED");
process.exitCode = ok ? 0 : 1;
