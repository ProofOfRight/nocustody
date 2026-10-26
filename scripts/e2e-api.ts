// SPDX-License-Identifier: Apache-2.0
// End to end through the merchant API: create an API key, create an invoice over HTTP, replay the recorded Nile
// payment (see e2e-nile.ts), then the dispatcher delivers signed webhooks to E2E_WEBHOOK_URL (the PHP receiver in
// examples/php, started by scripts/e2e-api.sh). Uses TEST_DATABASE_URL and RESETS its schema.
import pg from "pg";
import { newApiKey } from "../src/adapters/api/keys.ts";
import { migrate } from "../src/adapters/persistence/pg/migrate.ts";
import { parseConfig } from "../src/app/config.ts";
import { addressValidators, buildContainer, runCycle } from "../src/app/container.ts";
import { requireTestDatabase } from "./test-database.ts";

const REPLAY = { to: "TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq", blockTime: 1792970475000 };
const url = requireTestDatabase(process.env.TEST_DATABASE_URL);
const webhookUrl = process.env.E2E_WEBHOOK_URL;
const secret = process.env.E2E_WEBHOOK_SECRET;
if (!webhookUrl || !secret) throw new Error("E2E_WEBHOOK_URL and E2E_WEBHOOK_SECRET are required");

const admin = new pg.Pool({ connectionString: url });
await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await migrate(admin);
await admin.end();

const config = parseConfig(
  {
    database: { urlEnv: "TEST_DATABASE_URL" },
    tron: {
      network: "tron:nile",
      apiUrl: "https://nile.trongrid.io",
      startFrom: new Date(REPLAY.blockTime - 300_000).toISOString(),
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
        addresses: [{ address: REPLAY.to, status: "active" }],
        amounts: { step: "0.01", maxSlots: 99 },
      },
    ],
    pricing: {
      currencies: ["USD"],
      manualRates: [{ base: "USD", quote: "USDT", rate: "1", setAt: "2026-10-25T00:00:00Z", maxAge: "30d" }],
    },
    // The receiver runs in a container on the private docker network, over plain http: both need explicit opt-in.
    webhooks: {
      url: webhookUrl,
      secretEnv: "E2E_WEBHOOK_SECRET",
      allowPrivateNetworks: true,
      allowHttp: true,
      baseDelay: "1s",
    },
  },
  addressValidators,
);
const c = buildContainer({
  config,
  databaseUrl: url,
  integrity: { check: async () => ({ ok: true }) },
  slotStart: () => 0, // replays pay one recorded amount: the first slot, not a random one
  clock: { now: () => new Date(REPLAY.blockTime - 120_000) },
});
const api = c.api((e) => console.error("api error", e));
let ok = false;
try {
  const { port } = await api.listen("127.0.0.1", 0);
  const base = `http://127.0.0.1:${port}`;
  const { record, token } = newApiKey("e2e", ["invoices:read", "invoices:write"]);
  await c.uow.run((r) => r.apiKeys.insert(record));
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  // USD 0.99 → 0.99 USDT + one 0.01 step = 1.00 USDT, the recorded payment.
  const res = await fetch(`${base}/v1/invoices`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "e2e-order-1" },
    body: JSON.stringify({
      merchant_order_id: "e2e-order-1",
      price: { amount: "0.99", currency: "USD" },
      asset: "usdt-nile",
    }),
  });
  const invoice = (await res.json()) as { id: string; payment: { address: string; amount: string } };
  console.log(
    `POST /v1/invoices → ${res.status}: pay ${invoice.payment.amount} USDT to ${invoice.payment.address}`,
  );

  let status = "";
  for (let i = 0; i < 5 && status !== "completed"; i++) {
    await runCycle(c);
    status = (
      (await (await fetch(`${base}/v1/invoices/${invoice.id}`, { headers })).json()) as { status: string }
    ).status;
  }
  console.log(`GET /v1/invoices/${invoice.id} → ${status}`);

  let delivered = 0;
  for (let i = 0; i < 5; i++) {
    const d = await c.dispatcher?.execute();
    delivered += d?.delivered ?? 0;
    console.log("dispatch", JSON.stringify(d));
    if (d && d.failed === 0 && d.delivered === 0) break;
    await new Promise((r) => setTimeout(r, 1_200));
  }
  const pending = await c.pool.query("SELECT count(*)::int AS n FROM outbox WHERE delivered_at IS NULL");
  console.log(`webhooks delivered: ${delivered}, undelivered: ${pending.rows[0].n}`);
  ok = status === "completed" && delivered >= 5 && pending.rows[0].n === 0;
} finally {
  await api.close();
  await c.pool.end();
}
console.log(ok ? "E2E API OK" : "E2E API FAILED");
process.exitCode = ok ? 0 : 1;
