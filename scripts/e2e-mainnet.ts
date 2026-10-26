// SPDX-License-Identifier: Apache-2.0
// Read-only end-to-end check on TRON and TON **mainnet**: no funds, no keys, nothing is sent.
// For each network it picks a real finalized USDT transfer made 20–60 minutes ago to a low-traffic address, pins that
// address in the config, creates an invoice for exactly that amount (clock fixed shortly before the transfer) and runs
// the production scanner → finality verifier → settlement against the live providers. The invoice must complete.
// The transfer is chosen at run time, so no third-party addresses are kept in the repository.
// Uses TEST_DATABASE_URL and RESETS its schema. Optional: TRONGRID_API_KEY, TONCENTER_API_KEY,
// E2E_NETWORK=tron|ton (one network only), E2E_TON_FORWARD=0 (only a TON transfer without a notification).
import pg from "pg";
import { tronAddressFromHex } from "../src/adapters/chains/tron/address.ts";
import { migrate } from "../src/adapters/persistence/pg/migrate.ts";
import { parseConfig } from "../src/app/config.ts";
import { addressValidators, buildContainer, runCycle } from "../src/app/container.ts";

const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TON_USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const TRONGRID = "https://api.trongrid.io";
const TONCENTER = "https://toncenter.com";
// A unique-amount invoice is the base price plus one 0.01 step, so the transfer must be a multiple of 0.01 USDT.
const STEP_UNITS = 10_000n;
const noIntegrityCheck = { check: async () => ({ ok: true as const }) };

interface Pick {
  network: "tron:mainnet" | "ton:mainnet";
  tx: string;
  to: string;
  jettonWallet?: string;
  units: bigint;
  timeMs: number;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return res.json();
  }
  throw new Error(`rate limited by ${new URL(url).host}`);
}

function suitable(units: bigint): boolean {
  return units >= 1_000_000n && units <= 10_000_000_000n && units % STEP_UNITS === 0n;
}

function decimal(units: bigint): string {
  return `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")}`;
}

async function pickTron(): Promise<Pick> {
  const key = process.env.TRONGRID_API_KEY;
  const headers: Record<string, string> = key ? { "TRON-PRO-API-KEY": key } : {};
  const now = Date.now();
  const events = (await getJson(
    `${TRONGRID}/v1/contracts/${TRON_USDT}/events?event_name=Transfer&only_confirmed=true` +
      `&min_block_timestamp=${now - 60 * 60_000}&max_block_timestamp=${now - 20 * 60_000}&limit=200`,
    headers,
  )) as {
    data: { transaction_id: string; block_timestamp: number; result: { to: string; value: string } }[];
  };
  for (const e of events.data) {
    const units = BigInt(e.result.value);
    if (!suitable(units)) continue;
    const to = tronAddressFromHex(e.result.to);
    // Low traffic: the scanner reads everything since 5 minutes before the transfer, keep that small.
    const history = (await getJson(
      `${TRONGRID}/v1/accounts/${to}/transactions/trc20?only_confirmed=true&contract_address=${TRON_USDT}` +
        `&min_timestamp=${e.block_timestamp - 5 * 60_000}&limit=50`,
      headers,
    )) as { data: unknown[] };
    if (history.data.length < 20) {
      return { network: "tron:mainnet", tx: e.transaction_id, to, units, timeMs: e.block_timestamp };
    }
  }
  throw new Error("no suitable TRON transfer found, try again later");
}

async function pickTon(): Promise<Pick> {
  const key = process.env.TONCENTER_API_KEY;
  const headers: Record<string, string> = key ? { "X-API-Key": key } : {};
  const pause = () => new Promise((r) => setTimeout(r, key ? 200 : 1_100));
  const now = Math.floor(Date.now() / 1000);
  const list = (await getJson(
    `${TONCENTER}/api/v3/jetton/transfers?jetton_master=${TON_USDT}&start_utime=${now - 3600}` +
      `&end_utime=${now - 1200}&limit=100&sort=desc`,
    headers,
  )) as {
    jetton_transfers: {
      transaction_hash: string;
      transaction_now: number;
      transaction_aborted: boolean;
      destination: string;
      amount: string;
      forward_ton_amount: string;
      forward_payload: string | null;
    }[];
  };
  // Prefer a payment sent with forward_ton_amount = 0: the jetton wallet then sends the owner no notification at all,
  // which 0.1.0 missed. Fall back to an ordinary one.
  const ordered = [...list.jetton_transfers].sort(
    (a, b) => Number(a.forward_ton_amount !== "0") - Number(b.forward_ton_amount !== "0"),
  );
  const zeroOnly = process.env.E2E_TON_FORWARD === "0";
  for (const t of ordered) {
    if (zeroOnly && t.forward_ton_amount !== "0") continue;
    const units = BigInt(t.amount);
    if (t.transaction_aborted || t.forward_payload !== null || !suitable(units)) continue;
    await pause();
    const incoming = (await getJson(
      `${TONCENTER}/api/v3/jetton/transfers?owner_address=${t.destination}&jetton_master=${TON_USDT}` +
        `&direction=in&start_utime=${t.transaction_now - 300}&limit=50`,
      headers,
    )) as { jetton_transfers: unknown[] };
    if (incoming.jetton_transfers.length >= 10) continue;
    await pause();
    const wallets = (await getJson(
      `${TONCENTER}/api/v3/jetton/wallets?owner_address=${t.destination}&jetton_address=${TON_USDT}&limit=1`,
      headers,
    )) as { jetton_wallets: { address: string }[] };
    const jettonWallet = wallets.jetton_wallets[0]?.address;
    if (!jettonWallet) continue;
    console.log(`ton:mainnet: picked a transfer with forward_ton_amount = ${t.forward_ton_amount}`);
    return {
      network: "ton:mainnet",
      tx: t.transaction_hash,
      to: t.destination,
      jettonWallet,
      units,
      timeMs: t.transaction_now * 1000,
    };
  }
  throw new Error("no suitable TON transfer found, try again later");
}

async function replay(p: Pick, url: string): Promise<boolean> {
  const admin = new pg.Pool({ connectionString: url });
  await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(admin);
  await admin.end();

  const tron = p.network === "tron:mainnet";
  const startFrom = new Date(p.timeMs - 5 * 60_000).toISOString();
  const config = parseConfig(
    {
      database: { urlEnv: "TEST_DATABASE_URL" },
      ...(tron
        ? {
            tron: {
              network: p.network,
              apiUrl: TRONGRID,
              startFrom,
              ...(process.env.TRONGRID_API_KEY ? { apiKeyEnv: "TRONGRID_API_KEY" } : {}),
            },
          }
        : {
            ton: {
              network: p.network,
              apiUrl: TONCENTER,
              startFrom,
              ...(process.env.TONCENTER_API_KEY ? { apiKeyEnv: "TONCENTER_API_KEY" } : {}),
            },
          }),
      assets: [
        {
          id: "usdt",
          network: p.network,
          kind: "token",
          contract: tron ? TRON_USDT : TON_USDT,
          decimals: 6,
          symbol: "USDT",
          priceSymbol: "USDT",
          addresses: [
            { address: p.to, status: "active", ...(p.jettonWallet ? { jettonWallet: p.jettonWallet } : {}) },
          ],
          amounts: { step: "0.01", maxSlots: 99 },
        },
      ],
      pricing: {},
    },
    addressValidators,
  );
  const c = buildContainer({
    config,
    databaseUrl: url,
    integrity: noIntegrityCheck,
    clock: { now: () => new Date(p.timeMs - 2 * 60_000) },
  });
  try {
    await c.verifyStartup();
    const { invoice } = await c.createInvoice.execute({
      merchantOrderId: `e2e-mainnet-${p.network}`,
      priceAmount: decimal(p.units - STEP_UNITS),
      priceCurrency: "USDT",
      assetId: "usdt",
    });
    console.log(
      `${p.network}: transfer ${p.tx} of ${decimal(p.units)} USDT at ${new Date(p.timeMs).toISOString()};` +
        ` invoice expects ${invoice.state.instructions.amount.toDecimalString()}`,
    );
    for (let i = 0; i < 6; i++) {
      const r = await runCycle(c);
      console.log(
        `  cycle ${i + 1}: ${JSON.stringify(r.results.map((x) => ({ ingest: x.ingest, verify: x.verify, settle: x.settle })))}`,
      );
      const inv = await c.uow.run((repo) => repo.invoices.findById(invoice.id));
      if (inv?.status === "completed") break;
    }
    const inv = await c.uow.run((repo) => repo.invoices.findById(invoice.id));
    const audit = await c.pool.query<{ decision: string; reason: string }>(
      "SELECT decision, reason FROM audit_log WHERE actor IN ('verifier', 'settlement') ORDER BY id",
    );
    for (const a of audit.rows) console.log(`  audit ${a.decision}: ${a.reason}`);
    const paid = await c.pool.query(
      "SELECT 1 FROM outbox WHERE aggregate_id = $1 AND type = 'invoice.paid'",
      [invoice.id],
    );
    console.log(`  invoice ${invoice.id}: ${inv?.status}`);
    return inv?.status === "completed" && paid.rowCount === 1;
  } finally {
    await c.pool.end();
  }
}

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const only = process.env.E2E_NETWORK; // "tron" | "ton" | undefined (both)
const results: boolean[] = [];
if (only !== "ton") results.push(await replay(await pickTron(), url));
if (only !== "tron") results.push(await replay(await pickTon(), url));
const ok = results.length > 0 && results.every(Boolean);
console.log(
  ok ? "\nE2E MAINNET OK: real finalized transfers verified and settled (read-only)" : "\nE2E MAINNET FAILED",
);
process.exitCode = ok ? 0 : 1;
