// SPDX-License-Identifier: Apache-2.0
// Composition root: wires config, adapters and use cases. The only place that knows concrete implementations.
import { randomInt } from "node:crypto";
import pg from "pg";
import { AlertRouter, LogAlertSink, TelegramAlertSink } from "../adapters/alerts/sinks.ts";
import { type AddressNormaliser, BlocklistAmlScreener } from "../adapters/aml/blocklist.ts";
import { NoopAmlScreener } from "../adapters/aml/noop.ts";
import { ApiServer } from "../adapters/api/server.ts";
import { TonAdapter } from "../adapters/chains/ton/adapter.ts";
import { parseTonAddress } from "../adapters/chains/ton/address.ts";
import { TonapiSource } from "../adapters/chains/ton/tonapi.ts";
import { TronAdapter } from "../adapters/chains/tron/adapter.ts";
import { parseTronAddress } from "../adapters/chains/tron/address.ts";
import { TronscanSource } from "../adapters/chains/tron/tronscan.ts";
import { JsonHttpClient } from "../adapters/http/json-client.ts";
import { PgUnitOfWork } from "../adapters/persistence/pg/unit-of-work.ts";
import { ManualRateTable } from "../adapters/pricing/manual-table.ts";
import { CoinbaseUsdtUsd, KrakenUsdtUsd } from "../adapters/pricing/peg-sources.ts";
import { cryptoIds, cryptoMemos, systemClock } from "../adapters/system/system.ts";
import { HttpWebhookSender } from "../adapters/webhooks/http-sender.ts";
import { AssetCatalog } from "../application/catalog.ts";
import type {
  AlertSink,
  AmlScreener,
  ChainAdapter,
  Clock,
  IntegrityGuard,
  MemoGenerator,
  SecondarySource,
} from "../application/ports.ts";
import { RateService } from "../application/rates.ts";
import { MemoStrategy } from "../application/strategies/memo.ts";
import type { StrategyResolver } from "../application/strategies/strategy.ts";
import { UniqueAmountStrategy } from "../application/strategies/unique-amount.ts";
import { CreateInvoice } from "../application/use-cases/create-invoice.ts";
import { DispatchWebhooks } from "../application/use-cases/dispatch-webhooks.ts";
import { ExpireInvoices } from "../application/use-cases/expire-invoices.ts";
import { IngestTransfers } from "../application/use-cases/ingest-transfers.ts";
import { Monitor } from "../application/use-cases/monitor.ts";
import { QuotePrice } from "../application/use-cases/quote-price.ts";
import { ResolveAmlHold } from "../application/use-cases/resolve-aml-hold.ts";
import { SettlePayments } from "../application/use-cases/settle-payments.ts";
import { VerifyTransfers } from "../application/use-cases/verify-transfers.ts";
import { chainAddress } from "../domain/chain-address.ts";
import { type NetworkId, networkFamily, networkId } from "../domain/network.ts";
import type { AddressValidators, Config } from "./config.ts";
import { parseDuration } from "./duration.ts";
import { logger } from "./logger.ts";

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
  /** Test harnesses only; production uses node:crypto. */
  readonly memos?: MemoGenerator;
}

export interface NetworkWorker {
  readonly adapter: ChainAdapter;
  readonly ingest: IngestTransfers;
  readonly verify: VerifyTransfers;
  readonly settle: SettlePayments;
  readonly pollIntervalMs: number;
}

/**
 * Connection pool with the handler pg requires: pg-pool emits "error" when an idle client loses its connection
 * (PostgreSQL restart, failover); without a listener that is an uncaught exception and the whole process exits.
 */
export function createPool(connectionString: string, o: { max?: number; statementTimeoutMs?: number } = {}) {
  const pool = new pg.Pool({
    connectionString,
    max: o.max ?? 10,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    ...(o.statementTimeoutMs ? { statement_timeout: o.statementTimeoutMs } : {}),
  });
  pool.on("error", (err) => logger.error({ err: err.message }, "database connection lost on an idle client"));
  return pool;
}

export function buildContainer(o: ContainerOptions) {
  const env = o.env ?? process.env;
  const clock = o.clock ?? systemClock;
  const pool = createPool(o.databaseUrl, { max: 10, statementTimeoutMs: 60_000 });
  const catalog = new AssetCatalog(o.config.assets);
  const uow = new PgUnitOfWork(pool, new Map(o.config.assets.map((s) => [s.asset.id, s.asset])));
  const onSettleError = (subject: string, err: unknown) =>
    logger.error({ subject, err: err instanceof Error ? err.message : String(err) }, "settlement failed");
  // A random first slot: the pair a previous invoice just released is not the next one handed out.
  const randomSlot = (n: number) => (n > 1 ? randomInt(n) : 0);
  const uniqueAmount = new UniqueAmountStrategy(randomSlot);
  const memo = new MemoStrategy(o.memos ?? cryptoMemos, randomSlot);
  const strategies: StrategyResolver = (s) => {
    switch (s.strategy) {
      case "memo":
        return memo;
      case "unique-amount":
        return uniqueAmount;
      default:
        return unreachable(s.strategy);
    }
  };
  const rates = new RateService([new ManualRateTable(o.config.manualRates)], (provider, err) =>
    logger.warn({ provider, err: err instanceof Error ? err.message : String(err) }, "rate provider failed"),
  );
  const ops = o.config.raw.ops;
  const sinks: AlertSink[] = [new LogAlertSink((level, fields, msg) => logger[level](fields, msg))];
  if (ops.alerts.telegram) {
    const token = env[ops.alerts.telegram.botTokenEnv];
    if (!token) throw new Error(`ops.alerts.telegram: ${ops.alerts.telegram.botTokenEnv} is not set`);
    sinks.push(new TelegramAlertSink({ token, chatId: ops.alerts.telegram.chatId, timeoutMs: 10_000 }));
  }
  const alerts = new AlertRouter(sinks, parseDuration(ops.alerts.cooldown), (err) =>
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "alert delivery failed"),
  );
  const aml = o.aml ?? buildAml(ops.aml);
  const maxPendingMs = parseDuration(ops.candidateMaxAge);

  const createInvoice = new CreateInvoice({
    uow,
    catalog,
    pricing: o.config.pricing,
    rates,
    strategies,
    clock,
    ids: cryptoIds,
    integrity: o.integrity,
    depeg: ops.depeg
      ? { symbol: ops.depeg.symbol, maxGuardAgeMs: 3 * parseDuration(ops.depeg.interval) }
      : null,
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
      verify: new VerifyTransfers({ adapter, catalog, uow, clock, batchSize: 100, maxPendingMs, alerts }),
      settle: new SettlePayments({
        network: adapter.network,
        catalog,
        strategies,
        aml,
        uow,
        clock,
        batchSize: 100,
        onError: onSettleError,
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
      verify: new VerifyTransfers({ adapter, catalog, uow, clock, batchSize: 50, maxPendingMs, alerts }),
      settle: new SettlePayments({
        network,
        catalog,
        strategies,
        aml,
        uow,
        clock,
        batchSize: 100,
        onError: onSettleError,
      }),
      pollIntervalMs: parseDuration(ton.pollInterval),
    });
  }
  for (const s of o.config.assets) {
    if (!workers.some((w) => w.adapter.network === s.asset.network)) {
      throw new Error(`asset ${s.asset.id}: no provider configured for ${s.asset.network}`);
    }
  }
  const quotePrice = new QuotePrice(catalog, o.config.pricing, rates);
  const resolveAmlHold = new ResolveAmlHold(uow, clock);

  // Monitor: heartbeats, dead webhooks, reconciliation (second source), depeg.
  const secondary: SecondarySource[] = [];
  const rc = ops.reconcile;
  const client = (
    cfg: { apiUrl: string; apiKeyEnv?: string | undefined; apiKeyHeader?: string | undefined },
    header: string,
    minIntervalMs: number,
  ) => {
    const key = cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined;
    return new JsonHttpClient({
      baseUrl: cfg.apiUrl,
      apiKey: key || undefined,
      apiKeyHeader: cfg.apiKeyHeader ?? header,
      timeoutMs: 15_000,
      maxResponseBytes: 5_000_000,
      minIntervalMs: key ? 0 : minIntervalMs,
    });
  };
  if (rc?.tron && tron)
    secondary.push(new TronscanSource(tron.network as NetworkId, client(rc.tron, "TRON-PRO-API-KEY", 1_000)));
  if (rc?.ton && ton)
    secondary.push(new TonapiSource(ton.network as NetworkId, client(rc.ton, "Authorization", 1_100)));
  const lagDefaults: Readonly<Record<string, string>> = { tron: "5m", ton: "2m" };
  const maxScannerLagMs = new Map<NetworkId, number>(
    workers.map((w) => {
      return [
        w.adapter.network,
        parseDuration(
          ops.maxScannerLag[w.adapter.network] ?? lagDefaults[networkFamily(w.adapter.network)] ?? "5m",
        ),
      ];
    }),
  );
  const exchange = (url: string) =>
    new JsonHttpClient({ baseUrl: url, timeoutMs: 10_000, maxResponseBytes: 200_000 });
  const monitor = new Monitor({
    uow,
    clock,
    alerts,
    catalog,
    integrity: o.integrity,
    retention: ops.retention
      ? {
          ...(ops.retention.deliveredWebhooks
            ? { deliveredWebhooksMs: parseDuration(ops.retention.deliveredWebhooks) }
            : {}),
          ...(ops.retention.idempotencyKeys
            ? { idempotencyKeysMs: parseDuration(ops.retention.idempotencyKeys) }
            : {}),
          ...(ops.retention.settledCandidates
            ? { settledCandidatesMs: parseDuration(ops.retention.settledCandidates) }
            : {}),
        }
      : null,
    maxScannerLagMs,
    secondary,
    reconcileLookbackMs: parseDuration(rc?.lookback ?? "3h"),
    reconcileSettleDelayMs: parseDuration(rc?.settleDelay ?? "10m"),
    depeg: ops.depeg
      ? {
          symbol: ops.depeg.symbol,
          maxDeviationBps: ops.depeg.maxDeviationBps,
          sources: ops.depeg.sources.map((s) => {
            switch (s) {
              case "kraken":
                return new KrakenUsdtUsd(exchange("https://api.kraken.com"));
              case "coinbase":
                return new CoinbaseUsdtUsd(exchange("https://api.exchange.coinbase.com"));
              default:
                return unreachable(s);
            }
          }),
        }
      : null,
  });
  const monitorIntervals = {
    healthMs: 60_000,
    reconcileMs: rc ? parseDuration(rc.interval) : null,
    depegMs: ops.depeg ? parseDuration(ops.depeg.interval) : null,
    pruneMs: ops.retention ? 3_600_000 : null,
  };

  const wh = o.config.raw.webhooks;
  let dispatcher: DispatchWebhooks | null = null;
  if (wh) {
    const secret = env[wh.secretEnv];
    if (!secret) throw new Error(`webhooks: ${wh.secretEnv} is not set`);
    dispatcher = new DispatchWebhooks({
      uow,
      sender: new HttpWebhookSender({
        url: wh.url,
        secret,
        allowPrivateNetworks: wh.allowPrivateNetworks,
        allowHttp: wh.allowHttp,
        timeoutMs: parseDuration(wh.timeout),
      }),
      clock,
      batchSize: 50,
      sendTimeoutMs: parseDuration(wh.timeout),
      maxAttempts: wh.maxAttempts,
      baseDelayMs: parseDuration(wh.baseDelay),
      maxDelayMs: parseDuration(wh.maxDelay),
    });
  }

  const api = (onError: (err: unknown) => void) =>
    new ApiServer({
      uow,
      createInvoice,
      quotePrice,
      adapters: workers.map((w) => w.adapter),
      clock,
      rateLimitPerMinute: o.config.raw.api.rateLimitPerMinute,
      paymentPage: o.config.raw.api.paymentPage.enabled
        ? {
            defaultLanguage: o.config.raw.api.paymentPage.defaultLanguage,
            publicRateLimitPerMinute: o.config.raw.api.paymentPage.publicRateLimitPerMinute,
          }
        : null,
      onError,
    });

  /** Network-level startup checks (e.g. TON jetton-wallet binding); throws if any fails. */
  const verifyStartup = async (): Promise<void> => {
    const problems = (await Promise.all(startupChecks.map((c) => c()))).flat();
    if (problems.length > 0)
      throw new Error(`startup check failed, refusing to run:\n  ${problems.join("\n  ")}`);
  };
  return {
    pool,
    uow,
    catalog,
    createInvoice,
    quotePrice,
    expireInvoices,
    workers,
    clock,
    verifyStartup,
    dispatcher,
    api,
    alerts,
    monitor,
    monitorIntervals,
    resolveAmlHold,
  };
}

export type Container = ReturnType<typeof buildContainer>;

/** A new variant of a config enum must be wired here, not fall through to a default silently. */
function unreachable(x: never): never {
  throw new Error(`unhandled config variant ${String(x)}`);
}

function buildAml(aml: Config["raw"]["ops"]["aml"]): AmlScreener {
  switch (aml.provider) {
    case "noop":
      return new NoopAmlScreener();
    case "blocklist":
      if (!aml.blocklistFile) throw new Error("ops.aml.blocklistFile is required for the blocklist provider");
      return BlocklistAmlScreener.fromFile(aml.blocklistFile, normaliseAddress);
    default:
      return unreachable(aml.provider);
  }
}

/** Canonical form of an address for the blocklist: by network, or by any family that accepts it. */
const normaliseAddress: AddressNormaliser = (network, raw) => {
  if (network) {
    const validate = addressValidators.get(networkFamily(network));
    if (!validate) throw new Error(`no adapter for network ${network}`);
    return validate(network, raw).value;
  }
  for (const [family, validate] of addressValidators) {
    try {
      return validate(networkId(`${family}:mainnet`), raw).value;
    } catch {
      // not this family's address format
    }
  }
  throw new Error(`${raw} is not an address of any configured network family`);
};

/** One scanner → verifier → settlement pass for every network, plus expiry. */
/**
 * One scanner → verifier → settlement pass for every network, plus expiry. Networks are isolated: a failing
 * provider stops only its own network for this cycle. Each network's heartbeat is recorded for the monitor.
 */
export async function runCycle(c: Container) {
  const results = [];
  for (const w of c.workers) {
    const role = `scanner:${w.adapter.network}`;
    try {
      const ingest = await w.ingest.execute();
      const verify = await w.verify.execute();
      const settle = await w.settle.execute();
      await c.uow.run((r) => r.heartbeats.ok(role, c.clock.now()));
      results.push({ network: w.adapter.network, ingest, verify, settle });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await c.uow.run((r) => r.heartbeats.error(role, c.clock.now(), error)).catch(() => undefined);
      results.push({ network: w.adapter.network, error });
    }
  }
  const expired = await c.expireInvoices.execute();
  return { results, expired };
}
