// SPDX-License-Identifier: Apache-2.0
import { parseTxRefKey } from "../../domain/tx-ref.ts";
import type { AssetCatalog } from "../catalog.ts";
import type { AmlScreener, Clock, UnitOfWork } from "../ports.ts";

export interface ScreenStats {
  completed: number;
  held: number;
  /** Invoices left aml_pending because a screener was unavailable; retried next cycle. */
  deferred: number;
  /** Screenings that failed with an unexpected error; the invoice stays aml_pending and is retried next cycle. */
  errors: number;
}

export interface ScreenPaymentsDeps {
  readonly catalog: AssetCatalog;
  readonly aml: AmlScreener;
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly batchSize: number;
  /** Called for an unexpected error on one invoice; the batch goes on with the next one. */
  readonly onError?: (subject: string, error: unknown) => void;
}

/**
 * AML screening of credited invoices (aml_pending): below the asset's threshold an invoice completes unscreened;
 * otherwise every payment's sender is screened, and one hold verdict holds the invoice. Separate from settlement so
 * that a screening vendor is added here, never inside the code that credits payments.
 */
export class ScreenPayments {
  readonly #deps: ScreenPaymentsDeps;

  constructor(deps: ScreenPaymentsDeps) {
    this.#deps = deps;
  }

  async execute(): Promise<ScreenStats> {
    const stats: ScreenStats = { completed: 0, held: 0, deferred: 0, errors: 0 };
    const { aml, uow, clock, batchSize } = this.#deps;
    const pending = await uow.run((r) => r.invoices.listByStatus("aml_pending", batchSize));
    for (const inv of pending) {
      const payments = inv.state.payments;
      const verdicts = [];
      const threshold = this.#deps.catalog.get(inv.state.asset.id).amlThresholdUnits;
      const belowThreshold = inv.received().units < threshold;
      try {
        for (const p of belowThreshold ? [] : payments) {
          verdicts.push(
            await aml.screen({
              network: inv.state.asset.network,
              from: p.from,
              txRef: parseTxRefKey(p.transferKey),
              amount: p.amount,
            }),
          );
        }
      } catch (e) {
        // A throwing screener is "unavailable" for this invoice: it stays aml_pending and is retried next cycle.
        stats.errors++;
        this.#deps.onError?.(inv.id, e);
        continue;
      }
      const hold = verdicts.find((v) => v.verdict === "hold");
      if (!hold && verdicts.some((v) => v.verdict === "unavailable")) {
        stats.deferred++;
        continue; // stays aml_pending; retried next cycle
      }
      await uow.run(async (repos) => {
        const fresh = await repos.invoices.findById(inv.id);
        if (fresh?.status !== "aml_pending") return;
        const now = clock.now();
        if (hold && hold.verdict === "hold") {
          fresh.placeAmlHold(hold.reason, now);
          stats.held++;
        } else {
          fresh.amlCleared(now);
          stats.completed++;
        }
        await repos.invoices.update(fresh);
        await repos.outbox.append(fresh.pullEvents());
        await repos.audit.record({
          at: now,
          actor: "aml",
          subject: fresh.id,
          decision: fresh.status,
          reason:
            hold && hold.verdict === "hold"
              ? hold.reason
              : belowThreshold
                ? "below AML threshold, not screened"
                : "clear",
        });
      });
    }
    return stats;
  }
}
