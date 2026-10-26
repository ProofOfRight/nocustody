// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chainAddress } from "../domain/chain-address.ts";
import type { NetworkId } from "../domain/network.ts";
import { type AddressValidators, assertPinned, ConfigError, parseConfig } from "./config.ts";
import { addressValidators } from "./container.ts";
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
  });

  it("pins what decides money (ADR-0031): policies, providers, pricing, AML, depeg and the webhook URL; not operational knobs", () => {
    const sum = parseConfig(base(), validators).pinnedChecksum;
    const tron = {
      network: "tron:mainnet",
      apiUrl: "https://api.trongrid.io",
      startFrom: "2026-10-26T00:00:00Z",
    };
    const changesIt: Record<string, unknown>[] = [
      withAsset({ ttl: "15m" }),
      withAsset({ grace: "10m" }),
      withAsset({
        amounts: { step: "0.01", maxSlots: 99, dustThreshold: "0.1", underpaymentToleranceBps: 50 },
      }),
      withAsset({ amounts: { step: "0.02", maxSlots: 99, dustThreshold: "0.1" } }),
      withAsset({ amlThreshold: "500" }),
      withAsset({ strategy: "memo" }),
      withAsset({ priceSymbol: "USDC" }),
      { ...base(), tron },
      { ...base(), pricing: { ...(base().pricing as object), currencies: ["USD", "JPY", "EUR"] } },
      { ...base(), pricing: { ...(base().pricing as object), markupBps: { USD: 100 } } },
      { ...base(), ops: { aml: { provider: "blocklist", blocklistFile: "/etc/nocustody/aml.txt" } } },
      { ...base(), ops: { depeg: { maxDeviationBps: 300 } } },
      { ...base(), webhooks: { url: "https://shop.example/hook", secretEnv: "WH" } },
    ];
    for (const c of changesIt)
      expect(parseConfig(c, validators).pinnedChecksum, JSON.stringify(c)).not.toBe(sum);
    const withTron = parseConfig({ ...base(), tron }, validators).pinnedChecksum;
    expect(
      parseConfig({ ...base(), tron: { ...tron, apiUrl: "https://nile.trongrid.io" } }, validators)
        .pinnedChecksum,
    ).not.toBe(withTron);
    expect(
      parseConfig({ ...base(), tron: { ...tron, apiKeyEnv: "OTHER_KEY" } }, validators).pinnedChecksum,
    ).not.toBe(withTron);
    // the same money in another spelling is the same pin; operational knobs change nothing
    expect(
      parseConfig(withAsset({ amounts: { step: "0.010", maxSlots: 99, dustThreshold: "0.10" } }), validators)
        .pinnedChecksum,
    ).toBe(sum);
    const sameMoney: Record<string, unknown>[] = [
      { ...base(), api: { port: 9000, rateLimitPerMinute: 5 } },
      { ...base(), ops: { alerts: { cooldown: "1h" }, candidateMaxAge: "48h", maxDispatcherLag: "10m" } },
      { ...base(), ops: { retention: { deliveredWebhooks: "30d" } } },
      { ...base(), ops: { reconcile: { tron: { apiUrl: "https://apilist.tronscanapi.com" } } } },
    ];
    for (const c of sameMoney) expect(parseConfig(c, validators).pinnedChecksum, JSON.stringify(c)).toBe(sum);
    expect(
      parseConfig(
        { ...base(), tron: { ...tron, pollInterval: "30s", timeout: "20s", overlap: "1h" } },
        validators,
      ).pinnedChecksum,
    ).toBe(withTron);
  });

  it("a provider key variable must not be another secret", () => {
    const tron = {
      network: "tron:mainnet",
      apiUrl: "https://api.trongrid.io",
      startFrom: "2026-10-26T00:00:00Z",
    };
    expect(() =>
      parseConfig({ ...base(), tron: { ...tron, apiKeyEnv: "DATABASE_URL" } }, validators),
    ).toThrow(/database.urlEnv/);
    expect(() =>
      parseConfig({ ...base(), tron: { ...tron, apiKeyEnv: "POSTGRES_PASSWORD" } }, validators),
    ).toThrow(/database variable/);
    expect(() =>
      parseConfig({ ...base(), tron: { ...tron, apiKeyEnv: "NOCUSTODY_PINNED_SHA256" } }, validators),
    ).toThrow(/pinned/);
    expect(() =>
      parseConfig(
        {
          ...base(),
          tron: { ...tron, apiKeyEnv: "WH" },
          webhooks: { url: "https://shop.example/h", secretEnv: "WH" },
        },
        validators,
      ),
    ).toThrow(/webhooks.secretEnv/);
    expect(
      parseConfig({ ...base(), tron: { ...tron, apiKeyEnv: "TRONGRID_API_KEY" } }, validators).raw.tron
        ?.apiKeyEnv,
    ).toBe("TRONGRID_API_KEY");
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

  it("refuses zero durations and timer intervals Node would clamp to 1 ms", () => {
    const tron = {
      network: "tron:mainnet",
      apiUrl: "https://api.trongrid.io",
      startFrom: "2026-10-26T00:00:00Z",
    };
    expect(() => parseConfig({ ...base(), tron: { ...tron, pollInterval: "0s" } }, validators)).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ ...base(), tron: { ...tron, pollInterval: "30d" } }, validators)).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ ...base(), tron: { ...tron, timeout: "500ms" } }, validators)).toThrow(
      ConfigError,
    );
    expect(() => parseConfig(withAsset({ ttl: "0s" }), validators)).toThrow(ConfigError);
    expect(() => parseConfig({ ...base(), ops: { depeg: { interval: "25d" } } }, validators)).toThrow(
      ConfigError,
    );
    // arithmetic-only durations keep their range: a manual rate valid for a year is fine
    expect(parseConfig(base(), validators).manualRates[0]?.maxAgeMs).toBe(365 * 86_400_000);
    expect(
      parseConfig({ ...base(), tron: { ...tron, pollInterval: "24d" } }, validators).raw.tron?.pollInterval,
    ).toBe("24d");
  });

  it("refuses two ids for one on-chain asset and a depeg symbol no asset is priced in", () => {
    const c = base();
    const first = (c.assets as Record<string, unknown>[])[0] as Record<string, unknown>;
    c.assets = [first, { ...first, id: "usdt-tron-2" }];
    expect(() => parseConfig(c, validators)).toThrow(/same asset/);
    expect(() => parseConfig({ ...base(), ops: { depeg: { symbol: "USTD" } } }, validators)).toThrow(
      /priceSymbol/,
    );
    expect(
      parseConfig({ ...base(), ops: { depeg: { symbol: "USDT" } } }, validators).raw.ops.depeg?.symbol,
    ).toBe("USDT");
  });
});

describe("TON config", () => {
  const OWNER = "0:326bcaf1f252ca9e3458fe73348566afe805f7c5b40339277260bcb2fc8762b0";
  const JW = "0:58594ddbf5aae9eff2baf115da69590be38e07e89e79768915fda3089c190f6b";
  const MASTER = "0:f418a04cf196ebc959366844a6cdf53a6fd6fff1eadafc892f05210bba31593e";
  const ton = (address: Record<string, unknown>, kind: "token" | "native" = "token") => ({
    database: {},
    ton: {
      network: "ton:testnet",
      apiUrl: "https://testnet.toncenter.com",
      startFrom: "2026-10-25T00:00:00Z",
    },
    assets: [
      {
        id: "usdt-ton",
        network: "ton:testnet",
        kind,
        contract: kind === "token" ? MASTER : null,
        decimals: kind === "token" ? 6 : 9,
        symbol: "USDT",
        priceSymbol: "USDT",
        strategy: "memo",
        addresses: [{ status: "active", ...address }],
        amounts: { step: "0.01", maxSlots: 99 },
      },
    ],
    pricing: {},
  });

  it("requires a jetton-wallet for jettons, forbids it elsewhere, and pins it", () => {
    const cfg = parseConfig(ton({ address: OWNER, jettonWallet: JW }), addressValidators);
    expect(cfg.assets[0]?.addresses[0]?.tokenAccount?.value).toBe(JW);
    expect(cfg.assets[0]?.strategy).toBe("memo");
    expect(() => parseConfig(ton({ address: OWNER }), addressValidators)).toThrow("needs jettonWallet");
    expect(() => parseConfig(ton({ address: OWNER, jettonWallet: JW }, "native"), addressValidators)).toThrow(
      "only for TON jettons",
    );
    const other = parseConfig(ton({ address: OWNER, jettonWallet: MASTER }), addressValidators);
    expect(other.pinnedChecksum).not.toBe(cfg.pinnedChecksum);
  });

  it("accepts friendly addresses and pins their canonical raw form", () => {
    const friendly = parseConfig(
      ton({ address: "0QAya8rx8lLKnjRY_nM0hWav6AX3xbQDOSdyYLyy_IdisOvo", jettonWallet: JW }),
      addressValidators,
    );
    expect(friendly.assets[0]?.addresses[0]?.address.value).toBe(OWNER);
  });
});
