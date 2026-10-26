// SPDX-License-Identifier: Apache-2.0
// Configuration: JSON file validated with zod. Receiving addresses and asset contracts are pinned by a sha256
// checksum supplied separately (NOCUSTODY_PINNED_SHA256). There is deliberately no API to change them.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ManualRate } from "../adapters/pricing/manual-table.ts";
import type { AssetSettings, PricingSettings } from "../application/catalog.ts";
import { amountPolicy, uniqueAmountPolicy } from "../domain/amount-policy.ts";
import { defineAsset } from "../domain/asset.ts";
import type { ChainAddress } from "../domain/chain-address.ts";
import { isIsoCurrency } from "../domain/currency.ts";
import { parseDecimal } from "../domain/decimal.ts";
import { type NetworkId, networkId } from "../domain/network.ts";
import { parseDuration } from "./duration.ts";

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/, "non-negative decimal string");
const duration = z.string().refine((s) => {
  try {
    parseDuration(s);
    return true;
  } catch {
    return false;
  }
}, "duration like 30s, 30m, 1h, 7d");
const httpsUrl = z
  .string()
  .url()
  .refine((u) => new URL(u).protocol === "https:", "only https URLs are allowed");
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "environment variable name");

const assetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    network: z.string(),
    kind: z.enum(["native", "token"]),
    contract: z.string().min(1).nullable(),
    decimals: z.number().int().min(0).max(36),
    symbol: z.string().min(1).max(16),
    priceSymbol: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
    strategy: z.enum(["unique-amount", "memo"]).default("unique-amount"),
    addresses: z
      .array(z.object({ address: z.string().min(1), status: z.enum(["active", "draining"]) }).strict())
      .min(1),
    amounts: z
      .object({
        step: decimal,
        maxSlots: z.number().int().min(1).max(999),
        dustThreshold: decimal.default("0"),
        underpaymentTolerance: decimal.default("0"),
        underpaymentToleranceBps: z.number().int().min(0).max(9_999).default(0),
        acceptLatePayments: z.boolean().default(true),
      })
      .strict(),
    ttl: duration.default("30m"),
    grace: duration.default("60m"),
  })
  .strict();

const tronSchema = z
  .object({
    network: z.string(),
    apiUrl: httpsUrl,
    apiKeyEnv: envName.optional(),
    timeout: duration.default("10s"),
    pollInterval: duration.default("10s"),
    /** Rescan overlap so transfers near the previous window edge are never skipped. */
    overlap: duration.default("10m"),
    /** Where scanning starts when there is no cursor yet. */
    startFrom: z.string().datetime(),
    maxResponseBytes: z.number().int().min(1_024).max(50_000_000).default(5_000_000),
  })
  .strict();

export const configSchema = z
  .object({
    database: z.object({ urlEnv: envName.default("DATABASE_URL") }).strict(),
    tron: tronSchema.optional(),
    assets: z.array(assetSchema).min(1),
    pricing: z
      .object({
        currencies: z.array(z.string()).default([]),
        markupBps: z.record(z.string(), z.number().int().min(0).max(10_000)).default({}),
        manualRates: z
          .array(
            z
              .object({
                base: z.string(),
                quote: z.string(),
                rate: decimal,
                setAt: z.string().datetime(),
                maxAge: duration,
              })
              .strict(),
          )
          .default([]),
      })
      .strict(),
  })
  .strict();

export type RawConfig = z.infer<typeof configSchema>;

/** Network-specific address validation, provided by the chain adapters. */
export type AddressValidators = ReadonlyMap<string, (network: NetworkId, raw: string) => ChainAddress>;

export interface Config {
  readonly raw: RawConfig;
  readonly assets: readonly AssetSettings[];
  readonly pricing: PricingSettings;
  readonly manualRates: readonly ManualRate[];
  /** sha256 over the canonical form of assets and receiving addresses. */
  readonly pinnedChecksum: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseConfig(json: unknown, validators: AddressValidators): Config {
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(
      `invalid config:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`,
    );
  }
  const raw = parsed.data;
  const ids = new Set<string>();
  const assets: AssetSettings[] = raw.assets.map((a) => {
    if (ids.has(a.id)) throw new ConfigError(`duplicate asset id ${a.id}`);
    ids.add(a.id);
    const network = networkId(a.network);
    const validate = validators.get(network.slice(0, network.indexOf(":")));
    if (!validate) throw new ConfigError(`no adapter for network ${network}`);
    const asset = defineAsset({
      id: a.id,
      network,
      kind: a.kind,
      contract: a.contract === null ? null : validate(network, a.contract).value,
      decimals: a.decimals,
      symbol: a.symbol,
    });
    const seen = new Set<string>();
    const addresses = a.addresses.map((x) => {
      const address = validate(network, x.address);
      if (seen.has(address.value)) throw new ConfigError(`duplicate address ${address.value} in ${a.id}`);
      seen.add(address.value);
      return { address, status: x.status };
    });
    if (!addresses.some((x) => x.status === "active"))
      throw new ConfigError(`asset ${a.id} has no active address`);
    return {
      asset,
      priceSymbol: a.priceSymbol,
      strategy: a.strategy,
      addresses,
      amountPolicy: amountPolicy({
        underpaymentToleranceUnits: parseDecimal(a.amounts.underpaymentTolerance, a.decimals),
        underpaymentToleranceBps: a.amounts.underpaymentToleranceBps,
        dustThresholdUnits: parseDecimal(a.amounts.dustThreshold, a.decimals),
        acceptLatePayments: a.amounts.acceptLatePayments,
      }),
      uniqueAmount: uniqueAmountPolicy({
        stepUnits: parseDecimal(a.amounts.step, a.decimals),
        maxSlots: a.amounts.maxSlots,
      }),
      ttlMs: parseDuration(a.ttl),
      graceMs: parseDuration(a.grace),
    };
  });
  for (const c of raw.pricing.currencies) {
    if (!isIsoCurrency(c)) throw new ConfigError(`pricing.currencies: ${c} is not an ISO 4217 currency`);
  }
  return {
    raw,
    assets,
    pricing: {
      currencies: new Set(raw.pricing.currencies),
      markupBps: new Map(Object.entries(raw.pricing.markupBps)),
    },
    manualRates: raw.pricing.manualRates.map((r) => ({
      base: r.base,
      quote: r.quote,
      rate: r.rate,
      setAt: new Date(r.setAt),
      maxAgeMs: parseDuration(r.maxAge),
    })),
    pinnedChecksum: pinnedChecksum(assets),
  };
}

/**
 * Canonical form of everything that decides where money goes and what counts as the asset:
 * per asset (sorted by id) its network, kind, contract and decimals, then its addresses (sorted) with status.
 */
export function pinnedChecksum(assets: readonly AssetSettings[]): string {
  const lines: string[] = [];
  for (const s of [...assets].sort((a, b) => (a.asset.id < b.asset.id ? -1 : 1))) {
    const a = s.asset;
    lines.push(["asset", a.id, a.network, a.kind, a.contract ?? "-", String(a.decimals)].join("\t"));
    for (const x of [...s.addresses].sort((p, q) => (p.address.value < q.address.value ? -1 : 1))) {
      lines.push(["address", a.id, x.address.value, x.status].join("\t"));
    }
  }
  return createHash("sha256")
    .update(`nocustody-pinned-v1\n${lines.join("\n")}\n`)
    .digest("hex");
}

export function loadConfigFile(path: string, validators: AddressValidators): Config {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`cannot read config ${path}: ${e instanceof Error ? e.message : e}`);
  }
  return parseConfig(json, validators);
}

/** Startup check: the pinned checksum must be supplied separately and match. */
export function assertPinned(config: Config, expected: string | undefined): void {
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new ConfigError(
      "NOCUSTODY_PINNED_SHA256 is not set. Compute it with `node src/app/cli.ts config:hash` and set it at deploy time.",
    );
  }
  if (expected !== config.pinnedChecksum) {
    throw new ConfigError(
      "receiving addresses or asset contracts differ from the pinned checksum (NOCUSTODY_PINNED_SHA256); refusing to start",
    );
  }
}
