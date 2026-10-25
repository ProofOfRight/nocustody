// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chainAddress } from "../domain/chain-address.ts";
import type { NetworkId } from "../domain/network.ts";
import { type AddressValidators, assertPinned, ConfigError, parseConfig } from "./config.ts";
import { parseDuration } from "./duration.ts";
import { ConfigFilePinGuard } from "./integrity.ts";

const validators: AddressValidators = new Map([
  [
    "tron",
    (network: NetworkId, raw: string) => {
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(raw)) throw new Error(`invalid TRON address ${raw}`);
      return chainAddress(network, raw);
    },
  ],
]);

const A1 = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const A2 = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
const CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

function base(): Record<string, unknown> {
  return {
    database: {},
    assets: [
      {
        id: "usdt-tron",
        network: "tron:mainnet",
        kind: "token",
        contract: CONTRACT,
        decimals: 6,
        symbol: "USDT",
        priceSymbol: "USDT",
        addresses: [
          { address: A1, status: "active" },
          { address: A2, status: "draining" },
        ],
        amounts: { step: "0.01", maxSlots: 99, dustThreshold: "0.1" },
      },
    ],
    pricing: {
      currencies: ["USD", "JPY"],
      manualRates: [{ base: "USD", quote: "USDT", rate: "1", setAt: "2026-10-26T00:00:00Z", maxAge: "365d" }],
    },
  };
}

const withAsset = (patch: Record<string, unknown>) => {
  const c = base();
  c.assets = [{ ...(c.assets as Record<string, unknown>[])[0], ...patch }];
  return c;
};

describe("config", () => {
  it("parses into asset settings with exact amounts", () => {
    const cfg = parseConfig(base(), validators);
    const s = cfg.assets[0];
    expect(s?.uniqueAmount.stepUnits).toBe(10_000n);
    expect(s?.amountPolicy.dustThresholdUnits).toBe(100_000n);
    expect(s?.ttlMs).toBe(30 * 60_000);
    expect(cfg.manualRates[0]?.maxAgeMs).toBe(365 * 86_400_000);
  });

  it("rejects unknown keys, bad addresses, plain-http providers and non-ISO currencies", () => {
    expect(() => parseConfig({ ...base(), adminApi: true }, validators)).toThrow(ConfigError);
    expect(() =>
      parseConfig(withAsset({ addresses: [{ address: "0xdeadbeef", status: "active" }] }), validators),
    ).toThrow("invalid TRON address");
    const http = {
      ...base(),
      tron: { network: "tron:mainnet", apiUrl: "http://api.trongrid.io", startFrom: "2026-10-26T00:00:00Z" },
    };
    expect(() => parseConfig(http, validators)).toThrow("only https");
    const cur = base();
    (cur.pricing as Record<string, unknown>).currencies = ["USDT"];
    expect(() => parseConfig(cur, validators)).toThrow("not an ISO 4217");
  });

  it("requires an active address and no duplicates", () => {
    expect(() =>
      parseConfig(withAsset({ addresses: [{ address: A1, status: "draining" }] }), validators),
    ).toThrow("no active address");
    expect(() =>
      parseConfig(
        withAsset({
          addresses: [
            { address: A1, status: "active" },
            { address: A1, status: "draining" },
          ],
        }),
        validators,
      ),
    ).toThrow("duplicate address");
  });

  it("pinned checksum ignores ordering but changes with any address, status, contract or decimals", () => {
    const sum = parseConfig(base(), validators).pinnedChecksum;
    const reordered = withAsset({
      addresses: [
        { address: A2, status: "draining" },
        { address: A1, status: "active" },
      ],
    });
    expect(parseConfig(reordered, validators).pinnedChecksum).toBe(sum);
    const variants = [
      withAsset({ addresses: [{ address: A2, status: "active" }] }),
      withAsset({
        addresses: [
          { address: A1, status: "active" },
          { address: A2, status: "active" },
        ],
      }),
      withAsset({ contract: A1 }),
      withAsset({ decimals: 18 }),
    ];
    for (const v of variants) expect(parseConfig(v, validators).pinnedChecksum).not.toBe(sum);
    // policies are not pinned: changing the TTL keeps the checksum
    expect(parseConfig(withAsset({ ttl: "15m" }), validators).pinnedChecksum).toBe(sum);
  });

  it("refuses to start without the separately supplied checksum or on mismatch", () => {
    const cfg = parseConfig(base(), validators);
    expect(() => assertPinned(cfg, undefined)).toThrow("NOCUSTODY_PINNED_SHA256 is not set");
    expect(() => assertPinned(cfg, "0".repeat(64))).toThrow("refusing to start");
    expect(() => assertPinned(cfg, cfg.pinnedChecksum)).not.toThrow();
  });

  it("the guard notices a config file changed on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(base()));
    const expected = parseConfig(base(), validators).pinnedChecksum;
    const alerts: string[] = [];
    const guard = new ConfigFilePinGuard(path, expected, validators, (r) => alerts.push(r));
    expect(await guard.check()).toEqual({ ok: true });
    writeFileSync(path, JSON.stringify(withAsset({ addresses: [{ address: A2, status: "active" }] })));
    expect((await guard.check()).ok).toBe(false);
    writeFileSync(path, "{ not json");
    expect((await guard.check()).ok).toBe(false);
    expect(alerts).toHaveLength(2);
  });

  it("parses durations", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(() => parseDuration("1.5h")).toThrow();
    expect(() => parseDuration("10")).toThrow();
  });
});
