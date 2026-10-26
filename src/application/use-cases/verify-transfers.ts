// SPDX-License-Identifier: Apache-2.0
import { isDust } from "../../domain/amount-policy.ts";
import { sameAsset } from "../../domain/asset.ts";
import { sameAddress } from "../../domain/chain-address.ts";
import { txRefKey } from "../../domain/tx-ref.ts";
import { type AssetCatalog, watchedAddresses } from "../catalog.ts";
import type {
  AlertSink,
  ChainAdapter,
  Clock,
  Repositories,
  StoredCandidate,
  UnitOfWork,
  VerificationResult,
} from "../ports.ts";

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
  /**
   * A candidate still without a decision (not final, or the provider keeps failing) this long after its block time
   * is rejected (dropped or never-final tx). Counted from the time we first saw it when that is later (downtime).
   */
  readonly maxPendingMs?: number;
  readonly alerts?: AlertSink;
}

/**
 * Verifier step: ask the adapter's finalized-state query about each candidate transaction. Only the transfers it
 * returns (with real log indexes) are stored for settlement; the indexer's hint is never credited. One candidate
 * that cannot be verified or stored never stops the batch: it is kept for the next cycle and the others go on.
 */
export class VerifyTransfers {
  readonly #deps: VerifyTransfersDeps;

  constructor(deps: VerifyTransfersDeps) {
    this.#deps = deps;
  }

  async execute(): Promise<VerifyStats> {
    const { adapter, catalog, uow, batchSize } = this.#deps;
    const stats: VerifyStats = { final: 0, transfers: 0, pending: 0, rejected: 0, errors: 0 };
    const seen = await uow.run((r) => r.candidates.listSeen(adapter.network, batchSize));
    for (const stored of seen) {
      const c = stored.candidate;
      const settings = catalog.get(c.amount.asset.id);
      const watched = watchedAddresses(settings);
      let result: VerificationResult;
      try {
        result = await adapter.verify(c, settings.asset, watched);
      } catch (e) {
        // Provider failure: keep the candidate and retry later; an error is never a decision.
        stats.errors++;
        await this.#keep(stored, `error: ${message(e)}`, stats).catch(() => undefined);
        continue;
      }
      try {
        await uow.run((repos) => this.#store(repos, stored, result, watched, stats));
      } catch (e) {
        // The result could not be written (database error, a value PostgreSQL refuses). One bad row must not stop
        // the batch or the network's settlement: keep the candidate for the next cycle and go on.
        stats.errors++;
        await this.#keep(stored, `store error: ${message(e)}`, stats).catch(() => undefined);
      }
    }
    return stats;
  }

  async #store(
    repos: Repositories,
    stored: StoredCandidate,
    result: VerificationResult,
    watched: readonly StoredCandidate["candidate"]["to"][],
    stats: VerifyStats,
  ): Promise<void> {
    const c = stored.candidate;
    const settings = this.#deps.catalog.get(c.amount.asset.id);
    const subject = `${c.network}/${c.txHash}`;
    const at = this.#deps.clock.now();
    if (result.status === "pending") {
      if (this.#tooOld(stored, at)) {
        await this.#giveUp(repos, stored, at, result.reason, stats);
        return;
      }
      stats.pending++;
      await repos.candidates.markPending(c.network, c.txHash, result.reason);
      return;
    }
    // Defence in depth: the adapter decides finality and parses the chain, but what it returns must still be a
    // transfer of the expected asset to a pinned address.
    const foreign =
      result.status === "final"
        ? result.transfers.find(
            (t) => !sameAsset(t.amount.asset, settings.asset) || !watched.some((a) => sameAddress(a, t.to)),
          )
        : undefined;
    const reason =
      result.status === "rejected"
        ? result.reason
        : foreign
          ? `adapter returned a transfer of ${foreign.amount.asset.id} to ${foreign.to.value}`
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
  }

  /** No decision this cycle: record the reason (attempts + 1), or reject the candidate once it is too old. */
  async #keep(stored: StoredCandidate, reason: string, stats: VerifyStats): Promise<void> {
    const c = stored.candidate;
    await this.#deps.uow.run(async (repos) => {
      const at = this.#deps.clock.now();
      if (this.#tooOld(stored, at)) await this.#giveUp(repos, stored, at, reason, stats);
      else await repos.candidates.markPending(c.network, c.txHash, reason);
    });
  }

  #tooOld(stored: StoredCandidate, now: Date): boolean {
    const max = this.#deps.maxPendingMs;
    if (max === undefined) return false;
    const since = Math.max(stored.candidate.at.getTime(), stored.seenAt.getTime());
    return now.getTime() - since > max;
  }

  async #giveUp(
    repos: Repositories,
    stored: StoredCandidate,
    at: Date,
    why: string,
    stats: VerifyStats,
  ): Promise<void> {
    const c = stored.candidate;
    const subject = `${c.network}/${c.txHash}`;
    const age = at.getTime() - c.at.getTime();
    stats.rejected++;
    const reason = `not final ${Math.round(age / 60_000)} min after its block time (${why})`;
    await repos.candidates.markRejected(c.network, c.txHash, reason);
    await repos.audit.record({ at, actor: "verifier", subject, decision: "rejected", reason });
    await this.#deps.alerts?.send({
      key: `never-final:${subject}`,
      severity: "warning",
      message: `${subject}: ${reason}`,
    });
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
