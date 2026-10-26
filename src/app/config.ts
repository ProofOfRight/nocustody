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
import { type NetworkId, networkFamily, networkId } from "../domain/network.ts";
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
      .array(
        z
          .object({
            address: z.string().min(1),
            status: z.enum(["active", "draining"]),
            /** TON jetton assets: this owner's jetton-wallet; verified with get_wallet_address at startup. */
            jettonWallet: z.string().min(1).optional(),
          })
          .strict(),
      )
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
    /** Payments below this amount (in the asset) complete without AML screening; "0" screens everything. */
    amlThreshold: decimal.default("0"),
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

const tonSchema = z
  .object({
    network: z.string(),
    apiUrl: httpsUrl,
    apiKeyEnv: envName.optional(),
    timeout: duration.default("10s"),
    pollInterval: duration.default("10s"),
    overlap: duration.default("10m"),
    startFrom: z.string().datetime(),
    /** toncenter allows 1 request/s without a key. */
    minInterval: duration.default("1100ms"),
    maxResponseBytes: z.number().int().min(1_024).max(50_000_000).default(5_000_000),
  })
  .strict();

const apiSchema = z
  .object({
    /** Bind address; expose the API through a TLS reverse proxy, never directly. */
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(8080),
    rateLimitPerMinute: z.number().int().min(1).max(100_000).default(120),
    /** Hosted payment page at /pay/:id. Off by default (headless integration). */
    paymentPage: z
      .object({
        enabled: z.boolean().default(false),
        defaultLanguage: z.enum(["en", "ru", "fr", "fa", "zh-CN"]).default("en"),
        publicRateLimitPerMinute: z.number().int().min(1).max(1_000_000).default(600),
      })
      .strict()
      .prefault({}),
  })
  .strict();

const webhookSchema = z
  .object({
    url: z.string().url(),
    secretEnv: envName,
    /** Allow delivery to private / loopback addresses (merchant on an internal network). */
    allowPrivateNetworks: z.boolean().default(false),
    /** Allow plain http (only sensible together with a trusted private network). */
    allowHttp: z.boolean().default(false),
    timeout: duration.default("10s"),
    maxAttempts: z.number().int().min(1).max(100).default(15),
    baseDelay: duration.default("30s"),
    maxDelay: duration.default("6h"),
  })
  .strict();

const secondarySchema = z
  .object({ apiUrl: httpsUrl, apiKeyEnv: envName.optional(), apiKeyHeader: z.string().optional() })
  .strict();

const opsSchema = z
  .object({
    alerts: z
      .object({
        cooldown: duration.default("30m"),
        telegram: z
          .object({ botTokenEnv: envName, chatId: z.string().regex(/^-?\d{1,20}$/) })
          .strict()
          .optional(),
      })
      .strict()
      .prefault({}),
    /** Alert when a scanner has not completed a cycle for this long. Defaults: TRON 5m, TON 2m. */
    maxScannerLag: z.record(z.string(), duration).default({}),
    /** Reject candidates still not final this long after their block time. */
    candidateMaxAge: duration.default("24h"),
    reconcile: z
      .object({
        interval: duration.default("1h"),
        lookback: duration.default("3h"),
        settleDelay: duration.default("10m"),
        tron: secondarySchema.optional(),
        ton: secondarySchema.optional(),
      })
      .strict()
      .optional(),
    /** Off unless configured: no requests to exchanges otherwise. */
    depeg: z
      .object({
        symbol: z
          .string()
          .regex(/^[A-Z][A-Z0-9]{1,9}$/)
          .default("USDT"),
        maxDeviationBps: z.number().int().min(1).max(5_000).default(150),
        interval: duration.default("5m"),
        sources: z
          .array(z.enum(["kraken", "coinbase"]))
          .min(1)
          .default(["kraken", "coinbase"]),
      })
      .strict()
      .optional(),
    aml: z
      .object({
        provider: z.enum(["noop", "blocklist"]).default("noop"),
        blocklistFile: z.string().optional(),
      })
      .strict()
      .refine(
        (a) => a.provider !== "blocklist" || !!a.blocklistFile,
        "blocklistFile is required for the blocklist provider",
      )
      .prefault({}),
  })
  .strict();

export const configSchema = z
  .object({
    database: z.object({ urlEnv: envName.default("DATABASE_URL") }).strict(),
    tron: tronSchema.optional(),
    ton: tonSchema.optional(),
    api: apiSchema.prefault({}),
    webhooks: webhookSchema.optional(),
    ops: opsSchema.prefault({}),
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
    const validate = validators.get(networkFamily(network));
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
    const needsTokenAccount = network.startsWith("ton:") && a.kind === "token";
    const addresses = a.addresses.map((x) => {
      const address = validate(network, x.address);
      if (seen.has(address.value)) throw new ConfigError(`duplicate address ${address.value} in ${a.id}`);
      seen.add(address.value);
      if (needsTokenAccount && !x.jettonWallet)
        throw new ConfigError(`${a.id}: ${x.address} needs jettonWallet`);
      if (!needsTokenAccount && x.jettonWallet)
        throw new ConfigError(`${a.id}: jettonWallet is only for TON jettons`);
      return {
        address,
        status: x.status,
        tokenAccount: x.jettonWallet ? validate(network, x.jettonWallet) : null,
      };
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
      amlThresholdUnits: parseDecimal(a.amlThreshold, a.decimals),
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
      const fields = ["address", a.id, x.address.value, x.status];
      if (x.tokenAccount) fields.push(x.tokenAccount.value);
      lines.push(fields.join("\t"));
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
