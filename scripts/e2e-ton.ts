// SPDX-License-Identifier: Apache-2.0
// End-to-end scenario on the TON testnet: invoice → payment → `paid` → event in the outbox. Real toncenter v3 calls
// (including the get_wallet_address startup check), real PostgreSQL, the production composition root.
//
//   replay (default, unattended): replays two recorded finalized testnet payments — a jetton transfer with a memo
//          and a GRAM transfer without one (matched by the unique-amount fallback). The clock is set shortly before
//          each payment so the invoices exist first. Uses TEST_DATABASE_URL and RESETS its schema.
//   live:  E2E_MODE=live NOCUSTODY_CONFIG=... — creates an invoice for the first asset and waits for your payment.
import pg from "pg";
import { migrate } from "../src/adapters/persistence/pg/migrate.ts";
import { loadConfigFile, parseConfig } from "../src/app/config.ts";
import { addressValidators, buildContainer, type Container, runCycle } from "../src/app/container.ts";
import { requireTestDatabase } from "./test-database.ts";

const noIntegrityCheck = { check: async () => ({ ok: true as const }) };

// Recorded payments (see src/adapters/chains/ton/fixtures/README.md).
const JETTON = {
  master: "0:F418A04CF196EBC959366844A6CDF53A6FD6FFF1EADAFC892F05210BBA31593E",
  owner: "0:326BCAF1F252CA9E3458FE73348566AFE805F7C5B40339277260BCB2FC8762B0",
  jettonWallet: "0:58594DDBF5AAE9EFF2BAF115DA69590BE38E07E89E79768915FDA3089C190F6B",
  now: 1792965972,
  memo: "586935205",
  price: "1.217528", // + one 0.01 step = 1.227528, the paid amount
};
const GRAM = {
  owner: "0:B35713E641A7AE5B0A4C7BA1DF1AFA8DD34184FBD4E12313BEE5C3E6820D20ED",
  now: 1792972614,
  price: "0.484836196", // + one 1-nanogram step = 0.484836197, the paid amount (no comment)
};

async function status(c: Container, id: string): Promise<string> {
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
      ton: {
        network: "ton:testnet",
        apiUrl: "https://testnet.toncenter.com",
        startFrom: new Date((JETTON.now - 120) * 1000).toISOString(),
      },
      assets: [
        {
          id: "usdt-ton-testnet",
          network: "ton:testnet",
          kind: "token",
          contract: JETTON.master,
          decimals: 6,
          symbol: "USDT",
          priceSymbol: "USDT",
          strategy: "memo",
          addresses: [{ address: JETTON.owner, status: "active", jettonWallet: JETTON.jettonWallet }],
          amounts: { step: "0.01", maxSlots: 99 },
        },
        {
          id: "gram-testnet",
          network: "ton:testnet",
          kind: "native",
          contract: null,
          decimals: 9,
          symbol: "GRAM",
          priceSymbol: "GRAM",
          strategy: "memo",
          addresses: [{ address: GRAM.owner, status: "active" }],
          amounts: { step: "0.000000001", maxSlots: 99 },
        },
      ],
      pricing: {},
    },
    addressValidators,
  );
  let now = (JETTON.now - 120) * 1000;
  const memos = [JETTON.memo, "GRAM2345"];
  const c = buildContainer({
    config,
    databaseUrl: url,
    integrity: noIntegrityCheck,
    slotStart: () => 0, // replays pay one recorded amount: the first slot, not a random one
    clock: { now: () => new Date(now) },
    memos: { newMemo: () => memos.shift() ?? "ZZZZ9999" },
  });
  try {
    await c.verifyStartup(); // live get_wallet_address on the pinned master
    console.log("startup check ok: pinned jetton-wallet matches get_wallet_address");
    const jetton = await c.createInvoice.execute({
      merchantOrderId: "e2e-ton-jetton",
      priceAmount: JETTON.price,
      priceCurrency: "USDT",
      assetId: "usdt-ton-testnet",
    });
    now = (GRAM.now - 120) * 1000;
    const gram = await c.createInvoice.execute({
      merchantOrderId: "e2e-ton-gram",
      priceAmount: GRAM.price,
      priceCurrency: "GRAM",
      assetId: "gram-testnet",
    });
    for (const { invoice } of [jetton, gram]) {
      const s = invoice.state;
      console.log(
        `pay ${s.instructions.amount.toDecimalString()} ${s.asset.symbol} to ${s.instructions.address.value} memo ${s.instructions.memo}`,
      );
    }
    for (let i = 0; i < 6; i++) {
      const r = await runCycle(c);
      console.log(
        JSON.stringify(
          r.results.map((x) => ({ ingest: x.ingest, verify: x.verify, settle: x.settle, screen: x.screen })),
        ),
      );
      const done = await c.pool.query(
        "SELECT count(*)::int AS n FROM invoices WHERE id = ANY($1) AND status = 'completed'",
        [[jetton.invoice.id, gram.invoice.id]],
      );
      if (done.rows[0].n === 2) break;
    }
    const audit = await c.pool.query<{ subject: string; reason: string }>(
      "SELECT subject, reason FROM audit_log WHERE actor = 'settlement' AND decision = 'matched' ORDER BY id",
    );
    for (const a of audit.rows) console.log(`  audit ${a.subject}: ${a.reason}`);
    const s1 = await status(c, jetton.invoice.id);
    const s2 = await status(c, gram.invoice.id);
    const byMemo = audit.rows.some((a) => a.reason.includes("by memo"));
    const byAmount = audit.rows.some((a) => a.reason.includes("by amount"));
    return s1 === "completed" && s2 === "completed" && byMemo && byAmount;
  } finally {
    await c.pool.end();
  }
}

async function live(): Promise<boolean> {
  const path = process.env.NOCUSTODY_CONFIG;
  const url = process.env.DATABASE_URL;
  if (!path || !url) throw new Error("live mode needs NOCUSTODY_CONFIG and DATABASE_URL");
  const config = loadConfigFile(path, addressValidators);
  const asset = config.assets.find((a) => a.asset.network.startsWith("ton:"));
  if (!asset) throw new Error("no TON asset configured");
  const admin = new pg.Pool({ connectionString: url });
  await migrate(admin);
  await admin.end();
  const c = buildContainer({ config, databaseUrl: url, integrity: noIntegrityCheck });
  try {
    await c.verifyStartup();
    const { invoice } = await c.createInvoice.execute({
      merchantOrderId: `e2e-ton-live-${Date.now()}`,
      priceAmount: process.env.E2E_AMOUNT ?? "1",
      priceCurrency: asset.priceSymbol,
      assetId: asset.asset.id,
    });
    const s = invoice.state;
    const uri = c.workers
      .find((w) => w.adapter.network === s.asset.network)
      ?.adapter.buildPaymentUri(s.instructions);
    console.log(
      `\nPay exactly ${s.instructions.amount.toDecimalString()} ${s.asset.symbol} to ${s.instructions.address.value}`,
    );
    console.log(`with comment ${s.instructions.memo}\n${uri}\nwaiting (Ctrl+C to stop)…\n`);
    while (Date.now() < s.graceUntil.getTime()) {
      await runCycle(c);
      const st = await status(c, invoice.id);
      if (["completed", "aml_hold", "underpaid", "paid_late"].includes(st)) return st === "completed";
      await new Promise((r) => setTimeout(r, 15_000));
    }
    return false;
  } finally {
    await c.pool.end();
  }
}

const ok = await (process.env.E2E_MODE === "live" ? live() : replay());
console.log(
  ok ? "\nE2E OK: invoices paid (by memo and by amount) and completed, events in the outbox" : "\nE2E FAILED",
);
process.exitCode = ok ? 0 : 1;
