// SPDX-License-Identifier: Apache-2.0
import { txRefKey } from "../../domain/tx-ref.ts";
import { type AssetCatalog, watchedAddresses } from "../catalog.ts";
import type { ChainAdapter, Clock, UnitOfWork } from "../ports.ts";

export interface VerifyStats {
  final: number;
  pending: number;
  rejected: number;
  errors: number;
}

/** Verifier step: drive stored candidates to a decision using the adapter's finalized-state query. */
export interface VerifyTransfersDeps {
  readonly adapter: ChainAdapter;
  readonly catalog: AssetCatalog;
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly batchSize: number;
}

export class VerifyTransfers {
  readonly #deps: VerifyTransfersDeps;

  constructor(deps: VerifyTransfersDeps) {
    this.#deps = deps;
  }

  async execute(): Promise<VerifyStats> {
    const { adapter, catalog, uow, clock, batchSize } = this.#deps;
    const stats: VerifyStats = { final: 0, pending: 0, rejected: 0, errors: 0 };
    const pending = await uow.run((r) => r.transfers.listByStatus(adapter.network, "seen", batchSize));
    for (const t of pending) {
      const settings = catalog.get(t.candidate.amount.asset.id);
      const subject = txRefKey(t.candidate.ref);
      let result: Awaited<ReturnType<ChainAdapter["verify"]>>;
      try {
        result = await adapter.verify(t.candidate, settings.asset, watchedAddresses(settings));
      } catch (e) {
        // Provider failure: keep the candidate and retry later; never treat an error as a decision.
        stats.errors++;
        await uow.run((r) =>
          r.transfers.markPending(t.candidate.ref, `error: ${e instanceof Error ? e.message : e}`),
        );
        continue;
      }
      await uow.run(async (repos) => {
        const at = clock.now();
        if (result.status === "final") {
          stats.final++;
          await repos.transfers.markVerified(t.candidate.ref, result.transfer);
          await repos.audit.record({
            at,
            actor: "verifier",
            subject,
            decision: "final",
            reason: "finalized and successful",
            data: { amount: result.transfer.amount.toDecimalString(), to: result.transfer.to.value },
          });
        } else if (result.status === "rejected") {
          stats.rejected++;
          await repos.transfers.markRejected(t.candidate.ref, result.reason);
          await repos.audit.record({
            at,
            actor: "verifier",
            subject,
            decision: "rejected",
            reason: result.reason,
          });
        } else {
          stats.pending++;
          await repos.transfers.markPending(t.candidate.ref, result.reason);
        }
      });
    }
    return stats;
  }
}
