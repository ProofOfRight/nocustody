// SPDX-License-Identifier: Apache-2.0
import { isDust } from "../../domain/amount-policy.ts";
import { sameAsset } from "../../domain/asset.ts";
import { sameAddress } from "../../domain/chain-address.ts";
import { type AssetCatalog, watchedAddresses } from "../catalog.ts";
import type { AlertSink, ChainAdapter, Clock, UnitOfWork } from "../ports.ts";
import type { StrategyResolver } from "../strategies/strategy.ts";

export interface IngestStats {
  fetched: number;
  inserted: number;
  duplicates: number;
  dust: number;
  ignored: number;
  /** Assets whose rows were still not all read after `maxScans` scans: the scanner lags (an alert is raised). */
  exhausted: number;
}

export interface IngestTransfersDeps {
  readonly adapter: ChainAdapter;
  readonly catalog: AssetCatalog;
  readonly strategies: StrategyResolver;
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  /** Rows per indexer request, passed to the adapter as `limit`. */
  readonly pageSize: number;
  /** Scans per asset and cycle while the adapter reports `more`: catching up after a burst or an outage. */
  readonly maxScans: number;
  readonly alerts?: AlertSink;
}

/**
 * Scanner step: fetch candidate transactions from the indexer, store them idempotently and advance the cursor in the
 * same transaction, so the cursor never moves past candidates that were not stored. A matching invoice is marked
 * "confirming" from the indexer's hint; nothing is credited here. The adapter pages through the indexer; this loop
 * only follows its `more` from one stored cursor to the next.
 */
export class IngestTransfers {
  readonly #deps: IngestTransfersDeps;

  constructor(deps: IngestTransfersDeps) {
    this.#deps = deps;
  }

  async execute(): Promise<IngestStats> {
    const { adapter, catalog, strategies, uow, clock, pageSize, maxScans } = this.#deps;
    const stats: IngestStats = { fetched: 0, inserted: 0, duplicates: 0, dust: 0, ignored: 0, exhausted: 0 };
    for (const settings of catalog.forNetwork(adapter.network)) {
      const watched = watchedAddresses(settings);
      const stream = settings.asset.id;
      let more = true;
      for (let scan = 0; scan < maxScans && more; scan++) {
        const cursor = await uow.run((r) => r.cursors.get(adapter.network, stream));
        const result = await adapter.fetchIncoming(settings.asset, watched, cursor, pageSize);
        more = result.more;
        stats.fetched += result.candidates.length;
        await uow.run(async (repos) => {
          const now = clock.now();
          for (const c of result.candidates) {
            const subject = `${c.network}/${c.txHash}`;
            // Defence in depth: the adapter already filters, but never store what is not ours.
            if (!sameAsset(c.amount.asset, settings.asset) || !watched.some((a) => sameAddress(a, c.to))) {
              stats.ignored++;
              await repos.audit.record({
                at: now,
                actor: "scanner",
                subject,
                decision: "ignored",
                reason: "not a watched asset/address",
              });
              continue;
            }
            const dust = isDust(c.amount, settings.amountPolicy);
            const outcome = await repos.candidates.insert(c, dust ? "dust" : "seen", dust ? "dust" : null);
            if (outcome === "duplicate") {
              stats.duplicates++;
              continue;
            }
            stats.inserted++;
            if (dust) {
              stats.dust++;
              await repos.audit.record({
                at: now,
                actor: "scanner",
                subject,
                decision: "dust",
                reason: "below dust threshold",
                data: { amount: c.amount.toDecimalString(), from: c.from },
              });
              continue;
            }
            const m = await strategies(settings).match(c, repos);
            if (m.kind === "matched") {
              const invoice = await repos.invoices.findById(m.invoiceId);
              if (invoice) {
                invoice.markDetected(subject, now);
                await repos.invoices.update(invoice);
                await repos.outbox.append(invoice.pullEvents());
              }
            }
          }
          await repos.cursors.set(adapter.network, stream, result.next);
        });
      }
      if (more) {
        stats.exhausted++;
        await this.#deps.alerts?.send({
          key: `scanner-budget:${stream}`,
          severity: "warning",
          message: `${adapter.network} ${stream}: more transactions than one cycle reads; the scanner is catching up and may lag behind the chain`,
        });
      }
    }
    return stats;
  }
}
