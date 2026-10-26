// SPDX-License-Identifier: Apache-2.0
// Composition root: wires config, adapters and use cases. The only place that knows concrete implementations.
import pg from "pg";
import { NoopAmlScreener } from "../adapters/aml/noop.ts";
import { TonAdapter } from "../adapters/chains/ton/adapter.ts";
import { parseTonAddress } from "../adapters/chains/ton/address.ts";
import { TronAdapter } from "../adapters/chains/tron/adapter.ts";
import { parseTronAddress } from "../adapters/chains/tron/address.ts";
import { JsonHttpClient } from "../adapters/http/json-client.ts";
import { PgUnitOfWork } from "../adapters/persistence/pg/unit-of-work.ts";
import { ManualRateTable } from "../adapters/pricing/manual-table.ts";
import { cryptoIds, cryptoMemos, systemClock } from "../adapters/system/system.ts";
import { AssetCatalog } from "../application/catalog.ts";
import type { AmlScreener, ChainAdapter, Clock, IntegrityGuard } from "../application/ports.ts";
import { RateService } from "../application/rates.ts";
import { MemoStrategy } from "../application/strategies/memo.ts";
import type { StrategyResolver } from "../application/strategies/strategy.ts";
import { UniqueAmountStrategy } from "../application/strategies/unique-amount.ts";
import { CreateInvoice } from "../application/use-cases/create-invoice.ts";
import { ExpireInvoices } from "../application/use-cases/expire-invoices.ts";
import { IngestTransfers } from "../application/use-cases/ingest-transfers.ts";
import { SettlePayments } from "../application/use-cases/settle-payments.ts";
import { VerifyTransfers } from "../application/use-cases/verify-transfers.ts";
import { chainAddress } from "../domain/chain-address.ts";
import type { AddressValidators, Config } from "./config.ts";
import { parseDuration } from "./duration.ts";

export const addressValidators: AddressValidators = new Map([
  ["tron", (network, raw) => chainAddress(network, parseTronAddress(raw))],
  ["ton", (network, raw) => chainAddress(network, parseTonAddress(raw))],
]);

export interface ContainerOptions {
  readonly config: Config;
  readonly databaseUrl: string;
  readonly integrity: IntegrityGuard;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
  readonly aml?: AmlScreener;
}

export interface NetworkWorker {
  readonly adapter: ChainAdapter;
  readonly ingest: IngestTransfers;
  readonly verify: VerifyTransfers;
  readonly settle: SettlePayments;
  readonly pollIntervalMs: number;
}

export function buildContainer(o: ContainerOptions) {
  const env = o.env ?? process.env;
  const clock = o.clock ?? systemClock;
  const pool = new pg.Pool({ connectionString: o.databaseUrl, max: 10 });
  const catalog = new AssetCatalog(o.config.assets);
  const assetById = new Map(o.config.assets.map((s) => [s.asset.id, s.asset]));
  const uow = new PgUnitOfWork(pool, (id) => {
    const a = assetById.get(id);
    if (!a) throw new Error(`asset ${id} is stored in the database but not configured`);
    return a;
  });
  const uniqueAmount = new UniqueAmountStrategy();
  const memo = new MemoStrategy(cryptoMemos);
  const strategies: StrategyResolver = (s) => (s.strategy === "memo" ? memo : uniqueAmount);
  const rates = new RateService([new ManualRateTable(o.config.manualRates)]);
  const aml = o.aml ?? new NoopAmlScreener();

  const createInvoice = new CreateInvoice({
    uow,
    catalog,
    pricing: o.config.pricing,
    rates,
    strategies,
    clock,
    ids: cryptoIds,
    integrity: o.integrity,
  });
  const expireInvoices = new ExpireInvoices({ uow, clock, batchSize: 100 });

  const workers: NetworkWorker[] = [];
  const tron = o.config.raw.tron;
  if (tron) {
    const apiKey = tron.apiKeyEnv ? env[tron.apiKeyEnv] : undefined;
    const client = new JsonHttpClient({
      baseUrl: tron.apiUrl,
      apiKey: apiKey || undefined,
      apiKeyHeader: "TRON-PRO-API-KEY",
      timeoutMs: parseDuration(tron.timeout),
      maxResponseBytes: tron.maxResponseBytes,
    });
    const adapter = new TronAdapter({
      network: tron.network as ChainAdapter["network"],
      client,
      startFrom: new Date(tron.startFrom),
      overlapMs: parseDuration(tron.overlap),
    });
    for (const s of catalog.forNetwork(adapter.network)) {
      if (!adapter.supports(s.asset))
        throw new Error(`asset ${s.asset.id} is not supported by the TRON adapter`);
    }
    workers.push({
      adapter,
      ingest: new IngestTransfers({ adapter, catalog, strategies, uow, clock, pageSize: 200, maxPages: 5 }),
      verify: new VerifyTransfers({ adapter, catalog, uow, clock, batchSize: 100 }),
      settle: new SettlePayments({
        network: adapter.network,
        catalog,
        strategies,
        aml,
        uow,
        clock,
        batchSize: 100,
      }),
      pollIntervalMs: parseDuration(tron.pollInterval),
    });
  }
  const startupChecks: Array<() => Promise<string[]>> = [];
  const ton = o.config.raw.ton;
  if (ton) {
    const apiKey = ton.apiKeyEnv ? env[ton.apiKeyEnv] : undefined;
    const client = new JsonHttpClient({
      baseUrl: ton.apiUrl,
      apiKey: apiKey || undefined,
      apiKeyHeader: "X-API-Key",
      timeoutMs: parseDuration(ton.timeout),
      maxResponseBytes: ton.maxResponseBytes,
      minIntervalMs: apiKey ? 0 : parseDuration(ton.minInterval),
    });
    const network = ton.network as ChainAdapter["network"];
    const jettonWallets = new Map(
      catalog
        .forNetwork(network)
        .map((s) => [
          s.asset.id,
          new Map(
            s.addresses.flatMap((a) =>
              a.tokenAccount ? [[a.address.value, a.tokenAccount.value] as const] : [],
            ),
          ),
        ]),
    );
    const adapter = new TonAdapter({
      network,
      client,
      startFrom: new Date(ton.startFrom),
      overlapMs: parseDuration(ton.overlap),
      jettonWallets,
    });
    const tonAssets = catalog.forNetwork(network);
    for (const s of tonAssets) {
      if (!adapter.supports(s.asset))
        throw new Error(`asset ${s.asset.id} is not supported by the TON adapter`);
    }
    startupChecks.push(() => adapter.checkJettonWallets(tonAssets.map((s) => s.asset)));
    workers.push({
      adapter,
      ingest: new IngestTransfers({ adapter, catalog, strategies, uow, clock, pageSize: 100, maxPages: 5 }),
      verify: new VerifyTransfers({ adapter, catalog, uow, clock, batchSize: 50 }),
      settle: new SettlePayments({ network, catalog, strategies, aml, uow, clock, batchSize: 100 }),
      pollIntervalMs: parseDuration(ton.pollInterval),
    });
  }
  for (const s of o.config.assets) {
    if (!workers.some((w) => w.adapter.network === s.asset.network)) {
      throw new Error(`asset ${s.asset.id}: no provider configured for ${s.asset.network}`);
    }
  }
  /** Network-level startup checks (e.g. TON jetton-wallet binding); throws if any fails. */
  const verifyStartup = async (): Promise<void> => {
    const problems = (await Promise.all(startupChecks.map((c) => c()))).flat();
    if (problems.length > 0)
      throw new Error(`startup check failed, refusing to run:\n  ${problems.join("\n  ")}`);
  };
  return { pool, uow, catalog, createInvoice, expireInvoices, workers, clock, verifyStartup };
}

export type Container = ReturnType<typeof buildContainer>;

/** One scanner → verifier → settlement pass for every network, plus expiry. */
export async function runCycle(c: Container) {
  const results = [];
  for (const w of c.workers) {
    const ingest = await w.ingest.execute();
    const verify = await w.verify.execute();
    const settle = await w.settle.execute();
    results.push({ network: w.adapter.network, ingest, verify, settle });
  }
  const expired = await c.expireInvoices.execute();
  return { results, expired };
}
