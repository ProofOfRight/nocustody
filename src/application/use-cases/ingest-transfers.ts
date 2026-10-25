// SPDX-License-Identifier: Apache-2.0
import { isDust } from "../../domain/amount-policy.ts";
import { sameAsset } from "../../domain/asset.ts";
import { sameAddress } from "../../domain/chain-address.ts";
import { txRefKey } from "../../domain/tx-ref.ts";
import { type AssetCatalog, watchedAddresses } from "../catalog.ts";
import type { ChainAdapter, Clock, UnitOfWork } from "../ports.ts";
import type { PaymentInstructionStrategy } from "../strategies/unique-amount.ts";

export interface IngestStats {
  fetched: number;
  inserted: number;
  duplicates: number;
  dust: number;
  ignored: number;
}

/**
 * Scanner step: fetch candidates from the indexer, store them idempotently and advance the cursor in the same
 * transaction, so the cursor never moves past transfers that were not stored. A matching invoice is marked as
 * "confirming"; nothing is credited here.
 */
export interface IngestTransfersDeps {
  readonly adapter: ChainAdapter;
  readonly catalog: AssetCatalog;
  readonly strategy: PaymentInstructionStrategy;
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly pageSize: number;
  readonly maxPages: number;
}

export class IngestTransfers {
  readonly #deps: IngestTransfersDeps;

  constructor(deps: IngestTransfersDeps) {
    this.#deps = deps;
  }

  async execute(): Promise<IngestStats> {
    const { adapter, catalog, strategy, uow, clock, pageSize, maxPages } = this.#deps;
    const stats: IngestStats = { fetched: 0, inserted: 0, duplicates: 0, dust: 0, ignored: 0 };
    for (const settings of catalog.forNetwork(adapter.network)) {
      const watched = watchedAddresses(settings);
      const stream = settings.asset.id;
      for (let page = 0; page < maxPages; page++) {
        const cursor = await uow.run((r) => r.cursors.get(adapter.network, stream));
        const result = await adapter.fetchIncoming(settings.asset, watched, cursor, pageSize);
        stats.fetched += result.candidates.length;
        await uow.run(async (repos) => {
          const now = clock.now();
          for (const c of result.candidates) {
            // Defence in depth: the adapter already filters, but never store what is not ours.
            if (!sameAsset(c.amount.asset, settings.asset) || !watched.some((a) => sameAddress(a, c.to))) {
              stats.ignored++;
              await repos.audit.record({
                at: now,
                actor: "scanner",
                subject: txRefKey(c.ref),
                decision: "ignored",
                reason: "not a watched asset/address",
              });
              continue;
            }
            const dust = isDust(c.amount, settings.amountPolicy);
            const outcome = await repos.transfers.insertCandidate(
              c,
              dust ? "dust" : "seen",
              dust ? "dust" : null,
            );
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
                subject: txRefKey(c.ref),
                decision: "dust",
                reason: "below dust threshold",
                data: { amount: c.amount.toDecimalString(), from: c.from },
              });
              continue;
            }
            const m = await strategy.match(c, repos.slots);
            if (m.kind === "matched") {
              const invoice = await repos.invoices.findById(m.invoiceId);
              if (invoice) {
                invoice.markDetected(txRefKey(c.ref), now);
                await repos.invoices.update(invoice);
                await repos.outbox.append(invoice.pullEvents());
              }
            }
          }
          await repos.cursors.set(adapter.network, stream, result.next);
        });
        if (result.candidates.length < pageSize) break;
      }
    }
    return stats;
  }
}
