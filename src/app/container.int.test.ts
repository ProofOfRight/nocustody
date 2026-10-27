// SPDX-License-Identifier: Apache-2.0
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../adapters/persistence/pg/migrate.ts";
import { parseConfig } from "./config.ts";
import { addressValidators, buildContainer } from "./container.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required for integration tests");
const pool = new pg.Pool({ connectionString: url, max: 2 });

const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const OLD = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const NEW = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
const integrity = { check: async () => ({ ok: true as const }) };

const config = (addresses: { address: string; status: string }[]) =>
  parseConfig(
    {
      database: {},
      tron: { network: "tron:mainnet", apiUrl: "https://api.trongrid.io", startFrom: "2026-10-26T00:00:00Z" },
      assets: [
        {
          id: "usdt-tron",
          network: "tron:mainnet",
          kind: "token",
          contract: TRON_USDT,
          decimals: 6,
          symbol: "USDT",
          priceSymbol: "USDT",
          addresses,
          amounts: { step: "0.01", maxSlots: 99 },
        },
      ],
      pricing: { currencies: ["USD"], manualRates: [] },
    },
    addressValidators,
  );

async function startupError(addresses: { address: string; status: string }[]): Promise<string | null> {
  const c = buildContainer({ config: config(addresses), databaseUrl: url as string, integrity, env: {} });
  try {
    await c.verifyStartup();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await c.pool.end();
  }
}

afterAll(async () => {
  await pool.end();
});

describe("start-up check of stored invoice addresses (ADR-0037)", () => {
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    const c = buildContainer({
      config: config([{ address: OLD, status: "active" }]),
      databaseUrl: url as string,
      integrity,
      env: {},
    });
    try {
      await c.createInvoice.execute({
        merchantOrderId: "o1",
        priceAmount: "10",
        priceCurrency: "USDT",
        assetId: "usdt-tron",
      });
    } finally {
      await c.pool.end();
    }
  });

  it("refuses to start while an open invoice points at an address removed from the config", async () => {
    const message = await startupError([{ address: NEW, status: "active" }]);
    expect(message).toContain(`1 open invoice(s) on ${OLD}`);
  });

  it("starts when the address is kept as draining or retired", async () => {
    for (const status of ["draining", "retired"]) {
      expect(
        await startupError([
          { address: NEW, status: "active" },
          { address: OLD, status },
        ]),
      ).toBeNull();
    }
  });

  it("starts when only closed invoices are left on the removed address", async () => {
    await pool.query(
      `UPDATE invoices SET status = 'expired', created_at = now() - interval '3 hours',
         expires_at = now() - interval '2 hours', grace_until = now() - interval '1 hour'`,
    );
    expect(await startupError([{ address: NEW, status: "active" }])).toBeNull();
  });
});
