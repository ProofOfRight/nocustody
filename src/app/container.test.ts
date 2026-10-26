// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { addressValidators, buildContainer } from "./container.ts";

const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const ADDRESS = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

function config(extra: Record<string, unknown> = {}) {
  return parseConfig(
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
          addresses: [{ address: ADDRESS, status: "active" }],
          amounts: { step: "0.01", maxSlots: 99 },
        },
      ],
      pricing: {
        currencies: ["USD"],
        manualRates: [
          { base: "USD", quote: "USDT", rate: "1", setAt: "2026-10-26T00:00:00Z", maxAge: "365d" },
        ],
      },
      ...extra,
    },
    addressValidators,
  );
}

// The pool never connects in these tests: pg opens connections lazily, on the first query.
const DB = "postgres://nocustody:nocustody@127.0.0.1:1/nocustody";
const integrity = { check: async () => ({ ok: true as const }) };

describe("composition root", () => {
  it("wires every configured network and no other", async () => {
    const c = buildContainer({ config: config(), databaseUrl: DB, integrity, env: {} });
    try {
      expect(c.workers.map((w) => w.adapter.network)).toEqual(["tron:mainnet"]);
      expect(c.dispatcher).toBeNull();
      expect(c.monitorIntervals).toEqual({
        healthMs: 60_000,
        reconcileMs: null,
        depegMs: null,
        pruneMs: null,
      });
    } finally {
      await c.pool.end();
    }
  });

  it("wires TRON and TON side by side, each with its own poll interval", async () => {
    const base = config();
    const c = buildContainer({
      config: parseConfig(
        {
          ...base.raw,
          tron: { ...base.raw.tron, pollInterval: "7s" },
          ton: {
            network: "ton:testnet",
            apiUrl: "https://testnet.toncenter.com",
            startFrom: "2026-10-26T00:00:00Z",
            pollInterval: "15s",
          },
          assets: [
            ...(base.raw.assets as unknown[]),
            {
              id: "gram-testnet",
              network: "ton:testnet",
              kind: "native",
              contract: null,
              decimals: 9,
              symbol: "GRAM",
              priceSymbol: "GRAM",
              strategy: "memo",
              addresses: [
                {
                  address: "0:326bcaf1f252ca9e3458fe73348566afe805f7c5b40339277260bcb2fc8762b0",
                  status: "active",
                },
              ],
              amounts: { step: "0.001", maxSlots: 99 },
            },
          ],
        },
        addressValidators,
      ),
      databaseUrl: DB,
      integrity,
      env: {},
    });
    try {
      expect(c.workers.map((w) => [w.adapter.network, w.pollIntervalMs])).toEqual([
        ["tron:mainnet", 7_000],
        ["ton:testnet", 15_000],
      ]);
      // the screening step is shared, not built per network
      expect(c.workers[0]?.screen).toBe(c.workers[1]?.screen);
    } finally {
      await c.pool.end();
    }
  });

  it("refuses an asset whose network has no provider section", () => {
    expect(() =>
      buildContainer({
        config: config({ tron: undefined, ton: undefined }),
        databaseUrl: DB,
        integrity,
        env: {},
      }),
    ).toThrow(/no provider configured|is required/);
  });

  it("a connection error on an idle database client is logged, not thrown", async () => {
    const c = buildContainer({ config: config(), databaseUrl: DB, integrity, env: {} });
    try {
      // pg-pool emits this when PostgreSQL closes an idle connection (restart, failover). Without a listener Node
      // treats it as an uncaught exception and the process exits.
      expect(() =>
        c.pool.emit("error", new Error("terminating connection due to administrator command")),
      ).not.toThrow();
      expect(c.pool.listenerCount("error")).toBe(1);
    } finally {
      await c.pool.end();
    }
  });
});
