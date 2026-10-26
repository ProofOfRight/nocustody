// SPDX-License-Identifier: Apache-2.0
// End-to-end scenario on the TRON Nile testnet: invoice → payment → `paid` → event in the outbox.
// Real TronGrid + /walletsolidity calls, real PostgreSQL, the production composition root. See docs/testnet.md.
//
//   replay (default, unattended): replays a recorded solidified Nile USDT payment. The clock is fixed shortly before
//          that block so the invoice exists before the payment; everything else is live. Uses TEST_DATABASE_URL
//          and RESETS its schema.
//   live:  E2E_MODE=live NOCUSTODY_CONFIG=... — creates an invoice on your own Nile address and waits until you pay
//          it (TronLink on Nile). Uses DATABASE_URL.
import pg from "pg";
import { migrate } from "../src/adapters/persistence/pg/migrate.ts";
import { loadConfigFile, parseConfig } from "../src/app/config.ts";
import { addressValidators, buildContainer, type Container, runCycle } from "../src/app/container.ts";
import { requireTestDatabase } from "./test-database.ts";

const NILE_USDT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
// Recorded payment: 1 USDT to TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq, solidified (see fixtures/README.md of the adapter).
const REPLAY = {
  tx: "320a48d17dee9e25a1a56c48bd207b4dda550c2fb2e0c76e3e7b9f49fd70262c",
  to: "TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq",
  blockTime: 1792970475000,
};
const noIntegrityCheck = { check: async () => ({ ok: true as const }) };

async function showInvoice(c: Container, id: string): Promise<string> {
  const inv = await c.uow.run((r) => r.invoices.findById(id));
  const events = await c.pool.query<{ type: string; payload: unknown }>(
    "SELECT type, payload FROM outbox WHERE aggregate_id = $1 ORDER BY id",
    [id],
  );
  console.log(`invoice ${id}: ${inv?.status}`);
  for (const e of events.rows) console.log(`  outbox ${e.type} ${JSON.stringify(e.payload)}`);
  return inv?.status ?? "missing";
}

async function replay(): Promise<boolean> {
  const url = requireTestDatabase(process.env.TEST_DATABASE_URL);
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
        startFrom: new Date(REPLAY.blockTime - 5 * 60_000).toISOString(),
      },
      assets: [
        {
          id: "usdt-nile",
          network: "tron:nile",
          kind: "token",
          contract: NILE_USDT,
          decimals: 6,
          symbol: "USDT",
          priceSymbol: "USDT",
          addresses: [{ address: REPLAY.to, status: "active" }],
          amounts: { step: "0.01", maxSlots: 99 },
        },
      ],
      pricing: {},
    },
    addressValidators,
  );
  const now = REPLAY.blockTime - 2 * 60_000;
  const c = buildContainer({
    config,
    databaseUrl: url,
    integrity: noIntegrityCheck,
    slotStart: () => 0, // replays pay one recorded amount: the first slot, not a random one
    clock: { now: () => new Date(now) },
  });
  try {
    // 0.99 + one 0.01 step = 1.00 USDT, the amount of the recorded payment.
    const { invoice } = await c.createInvoice.execute({
      merchantOrderId: "e2e-replay",
      priceAmount: "0.99",
      priceCurrency: "USDT",
      assetId: "usdt-nile",
    });
    console.log(
      `pay ${invoice.state.instructions.amount.toDecimalString()} USDT to ${invoice.state.instructions.address.value}`,
    );
    for (let i = 0; i < 3; i++) console.log(JSON.stringify(await runCycle(c)));
    const transfer = await c.pool.query(
      "SELECT tx_hash, log_index, status, invoice_id FROM observed_transfers WHERE tx_hash = $1",
      [REPLAY.tx],
    );
    console.log("transfer", JSON.stringify(transfer.rows));
    const status = await showInvoice(c, invoice.id);
    const paid = await c.pool.query(
      "SELECT 1 FROM outbox WHERE aggregate_id = $1 AND type = 'invoice.paid'",
      [invoice.id],
    );
    return status === "completed" && paid.rowCount === 1;
  } finally {
    await c.pool.end();
  }
}

async function live(): Promise<boolean> {
  const path = process.env.NOCUSTODY_CONFIG;
  const url = process.env.DATABASE_URL;
  if (!path || !url) throw new Error("live mode needs NOCUSTODY_CONFIG and DATABASE_URL");
  const config = loadConfigFile(path, addressValidators);
  const asset = config.assets[0];
  if (!asset) throw new Error("no asset configured");
  const admin = new pg.Pool({ connectionString: url });
  await migrate(admin);
  await admin.end();
  const c = buildContainer({ config, databaseUrl: url, integrity: noIntegrityCheck });
  try {
    const { invoice } = await c.createInvoice.execute({
      merchantOrderId: `e2e-live-${Date.now()}`,
      priceAmount: process.env.E2E_AMOUNT ?? "1",
      priceCurrency: asset.priceSymbol,
      assetId: asset.asset.id,
    });
    const s = invoice.state;
    console.log(
      `\nPay exactly ${s.instructions.amount.toDecimalString()} USDT (Nile) to ${s.instructions.address.value}`,
    );
    console.log(`before ${s.expiresAt.toISOString()}; waiting (Ctrl+C to stop)…\n`);
    const deadline = s.graceUntil.getTime();
    while (Date.now() < deadline) {
      await runCycle(c);
      const status = await showInvoice(c, invoice.id);
      if (["completed", "aml_hold", "underpaid", "paid_late"].includes(status)) return status === "completed";
      await new Promise((r) => setTimeout(r, 15_000));
    }
    return false;
  } finally {
    await c.pool.end();
  }
}

const ok = await (process.env.E2E_MODE === "live" ? live() : replay());
console.log(ok ? "\nE2E OK: invoice paid and completed, events in the outbox" : "\nE2E FAILED");
process.exitCode = ok ? 0 : 1;
