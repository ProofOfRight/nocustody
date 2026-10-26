// SPDX-License-Identifier: Apache-2.0
import { isDust } from "../../domain/amount-policy.ts";
import { txRefKey } from "../../domain/tx-ref.ts";
import { type AssetCatalog, watchedAddresses } from "../catalog.ts";
import type { AlertSink, ChainAdapter, Clock, UnitOfWork, VerificationResult } from "../ports.ts";

export interface VerifyStats {
  final: number;
  transfers: number;
  pending: number;
  rejected: number;
  errors: number;
}

export interface VerifyTransfersDeps {
  readonly adapter: ChainAdapter;
  readonly catalog: AssetCatalog;
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly batchSize: number;
  /** A candidate still not final this long after its block time is rejected (dropped or never-final tx). */
  readonly maxPendingMs?: number;
  readonly alerts?: AlertSink;
}

/**
 * Verifier step: ask the adapter's finalized-state query about each candidate transaction. Only the transfers it
 * returns (with real log indexes) are stored for settlement; the indexer's hint is never credited.
 */
export class VerifyTransfers {
  readonly #deps: VerifyTransfersDeps;

  constructor(deps: VerifyTransfersDeps) {
    this.#deps = deps;
  }

  async execute(): Promise<VerifyStats> {
    const { adapter, catalog, uow, clock, batchSize } = this.#deps;
    const stats: VerifyStats = { final: 0, transfers: 0, pending: 0, rejected: 0, errors: 0 };
    const seen = await uow.run((r) => r.candidates.listSeen(adapter.network, batchSize));
    for (const { candidate: c } of seen) {
      const settings = catalog.get(c.amount.asset.id);
      const subject = `${c.network}/${c.txHash}`;
      let result: VerificationResult;
      try {
        result = await adapter.verify(c, settings.asset, watchedAddresses(settings));
      } catch (e) {
        // Provider failure: keep the candidate and retry later; an error is never a decision.
        stats.errors++;
        await uow.run((r) =>
          r.candidates.markPending(c.network, c.txHash, `error: ${e instanceof Error ? e.message : e}`),
        );
        continue;
      }
      await uow.run(async (repos) => {
        const at = clock.now();
        if (result.status === "pending") {
          const age = at.getTime() - c.at.getTime();
          if (this.#deps.maxPendingMs !== undefined && age > this.#deps.maxPendingMs) {
            stats.rejected++;
            const reason = `not final ${Math.round(age / 60_000)} min after its block time (${result.reason})`;
            await repos.candidates.markRejected(c.network, c.txHash, reason);
            await repos.audit.record({ at, actor: "verifier", subject, decision: "rejected", reason });
            await this.#deps.alerts?.send({
              key: `never-final:${subject}`,
              severity: "warning",
              message: `${subject}: ${reason}`,
            });
            return;
          }
          stats.pending++;
          await repos.candidates.markPending(c.network, c.txHash, result.reason);
          return;
        }
        const reason =
          result.status === "rejected"
            ? result.reason
            : result.transfers.length === 0
              ? "no transfer of the asset to a watched address"
              : null;
        if (reason !== null) {
          stats.rejected++;
          await repos.candidates.markRejected(c.network, c.txHash, reason);
          await repos.audit.record({ at, actor: "verifier", subject, decision: "rejected", reason });
          return;
        }
        if (result.status !== "final") return;
        stats.final++;
        for (const t of result.transfers) {
          const dust = isDust(t.amount, settings.amountPolicy);
          const outcome = await repos.transfers.insert(t, dust ? "dust" : "verified", dust ? "dust" : null);
          if (outcome === "inserted") stats.transfers++;
          await repos.audit.record({
            at,
            actor: "verifier",
            subject: txRefKey(t.ref),
            decision: dust ? "dust" : "final",
            reason: dust ? "below dust threshold" : "finalized and successful",
            data: {
              amount: t.amount.toDecimalString(),
              to: t.to.value,
              from: t.from,
              duplicate: outcome === "duplicate",
            },
          });
        }
        await repos.candidates.markVerified(c.network, c.txHash);
      });
    }
    return stats;
  }
}
