// SPDX-License-Identifier: Apache-2.0
import { DomainError } from "../../domain/errors.ts";
import type { Invoice } from "../../domain/invoice.ts";
import type { NetworkId } from "../../domain/network.ts";
import { txRefKey } from "../../domain/tx-ref.ts";
import type { AssetCatalog } from "../catalog.ts";
import { ConcurrencyError } from "../errors.ts";
import type { Clock, Repositories, UnitOfWork, VerifiedTransfer } from "../ports.ts";
import type { StrategyResolver } from "../strategies/strategy.ts";

export interface SettleStats {
  matched: number;
  unmatched: number;
  /** Transfers that failed with an unexpected error; left as they are and retried next cycle. */
  errors: number;
}

/**
 * Settlement (MatchPayment): match verified transfers to invoices, apply amount policies, change status and write
 * outbox events in one transaction per transfer. A credited invoice goes to aml_pending; ScreenPayments takes it
 * from there.
 */
export interface SettlePaymentsDeps {
  readonly network: NetworkId;
  readonly catalog: AssetCatalog;
  readonly strategies: StrategyResolver;
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly batchSize: number;
  /** Called for an unexpected error on one transfer; the batch goes on with the next one. */
  readonly onError?: (subject: string, error: unknown) => void;
}

export class SettlePayments {
  readonly #deps: SettlePaymentsDeps;

  constructor(deps: SettlePaymentsDeps) {
    this.#deps = deps;
  }

  async execute(): Promise<SettleStats> {
    const { network, uow, batchSize } = this.#deps;
    const stats: SettleStats = { matched: 0, unmatched: 0, errors: 0 };
    const verified = await uow.run((r) => r.transfers.listVerified(network, batchSize));
    for (const t of verified) {
      try {
        try {
          await uow.run((repos) => this.#settleOne(repos, t.transfer, stats));
        } catch (e) {
          // Another process changed the invoice between read and write: re-read and apply once more.
          if (!(e instanceof ConcurrencyError)) throw e;
          await uow.run((repos) => this.#settleOne(repos, t.transfer, stats));
        }
      } catch (e) {
        // One failing transfer must not block the ones behind it; it stays "verified" and is retried next cycle.
        stats.errors++;
        this.#deps.onError?.(txRefKey(t.transfer.ref), e);
      }
    }
    return stats;
  }

  async #settleOne(repos: Repositories, v: VerifiedTransfer, stats: SettleStats): Promise<void> {
    const { catalog, strategies, clock } = this.#deps;
    const now = clock.now();
    const subject = txRefKey(v.ref);
    const unmatched = async (reason: string): Promise<void> => {
      // Another worker may have settled this transfer since it was listed: then nothing is recorded twice.
      if (!(await repos.transfers.markUnmatched(v.ref, reason))) return;
      stats.unmatched++;
      await repos.audit.record({ at: now, actor: "settlement", subject, decision: "unmatched", reason });
      await repos.outbox.append([
        {
          type: "transfer.unmatched",
          aggregateId: subject,
          occurredAt: now,
          data: {
            reason,
            amount: v.amount.toDecimalString(),
            to: v.to.value,
            from: v.from,
            asset: v.amount.asset.id,
          },
        },
      ]);
    };

    const settings = catalog.get(v.amount.asset.id);
    const m = await strategies(settings).match(v, repos);
    if (m.kind === "unmatched") return unmatched(m.reason);
    const invoice = await repos.invoices.findById(m.invoiceId);
    if (!invoice) return unmatched("invoice_missing");
    try {
      invoice.applyPayment(
        { transferKey: subject, from: v.from, to: v.to, amount: v.amount, at: v.at },
        settings.amountPolicy,
        now,
      );
    } catch (e) {
      if (e instanceof DomainError) return unmatched(e.code);
      throw e;
    }
    if (invoice.needsAmlReview()) invoice.startAmlReview(now);
    if (!(await repos.transfers.markMatched(v.ref, invoice.id))) return; // settled by another worker meanwhile
    await this.#save(repos, invoice);
    await repos.audit.record({
      at: now,
      actor: "settlement",
      subject,
      decision: "matched",
      reason: `applied to invoice by ${m.by}, status ${invoice.status}`,
      data: { invoiceId: invoice.id, amount: v.amount.toDecimalString(), by: m.by, memo: v.memo },
    });
    stats.matched++;
  }

  async #save(repos: Repositories, invoice: Invoice): Promise<void> {
    await repos.invoices.update(invoice);
    await repos.outbox.append(invoice.pullEvents());
  }
}
