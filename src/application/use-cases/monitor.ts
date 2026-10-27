// SPDX-License-Identifier: Apache-2.0
// Operations monitor: scanner heartbeat staleness, dead webhooks, never-final candidates, depeg, reconciliation,
// open invoices on addresses outside the pinned config.
// Raises alerts; the only state it changes is the depeg guard (blocks new invoices) and reconciled candidates.
import { isDust } from "../../domain/amount-policy.ts";
import type { NetworkId } from "../../domain/network.ts";
import type { Rational } from "../../domain/rational.ts";
import { type AssetCatalog, unpinnedUsage, watchedAddresses } from "../catalog.ts";
import type {
  AlertSink,
  Clock,
  IntegrityGuard,
  PegPriceSource,
  SecondarySource,
  TransferCandidate,
  UnitOfWork,
} from "../ports.ts";

export interface MonitorDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly alerts: AlertSink;
  readonly catalog: AssetCatalog;
  /** Max age of the last successful scanner cycle, per network. */
  readonly maxScannerLagMs: ReadonlyMap<NetworkId, number>;
  /**
   * With webhooks configured: max age of the dispatcher's last successful cycle, and the longest an event may be due
   * without being delivered (a dispatcher that is down, stuck on one endpoint, or not running anywhere).
   */
  readonly maxDispatcherLagMs?: number;
  readonly secondary: readonly SecondarySource[];
  /** Reconciliation window: [now - lookback, now - settleDelay]. */
  readonly reconcileLookbackMs: number;
  readonly reconcileSettleDelayMs: number;
  readonly depeg: {
    readonly symbol: string;
    readonly sources: readonly PegPriceSource[];
    readonly maxDeviationBps: number;
  } | null;
  /** Re-checked every health cycle, so a tampered config is alerted even when no invoice is being created. */
  readonly integrity?: IntegrityGuard;
  /** Retention of operational rows (ops.retention); null keeps everything forever. Payments and audit are never pruned. */
  readonly retention?: {
    readonly deliveredWebhooksMs?: number;
    readonly idempotencyKeysMs?: number;
    readonly settledCandidatesMs?: number;
  } | null;
}

export interface PruneStats {
  deliveredWebhooks: number;
  idempotencyKeys: number;
  settledCandidates: number;
}

export interface ReconcileStats {
  checked: number;
  missedByPrimary: number;
  notInSecondary: number;
  /** Addresses for which a source returned a partial answer, so credited transfers were not compared. */
  truncated: number;
  errors: number;
}

/** |x − 1| in basis points, rounded down: for alert texts only, the decision is `exceedsDeviation`. */
export function deviationBps(price: Rational): number {
  const diff = price.num > price.den ? price.num - price.den : price.den - price.num;
  return Number((diff * 10_000n) / price.den);
}

/** Exact: |x − 1| > maxBps / 10 000, without rounding (150.9 bps is over a 150 bps limit). */
export function exceedsDeviation(price: Rational, maxBps: number): boolean {
  const diff = price.num > price.den ? price.num - price.den : price.den - price.num;
  return diff * 10_000n > BigInt(maxBps) * price.den;
}

export class Monitor {
  readonly #d: MonitorDeps;

  constructor(deps: MonitorDeps) {
    this.#d = deps;
  }

  /** Pinned config, heartbeats and dead webhooks: cheap, run every cycle. */
  async checkHealth(): Promise<string[]> {
    const { uow, clock, alerts, maxScannerLagMs, integrity } = this.#d;
    const now = clock.now().getTime();
    const problems: string[] = [];
    if (integrity) {
      const pin = await integrity.check();
      if (!pin.ok) {
        problems.push(`pinned config check failed, new invoices are blocked: ${pin.reason}`);
        await alerts.send({
          key: "address_pin_violation",
          severity: "critical",
          message: problems.at(-1) ?? "",
        });
      }
    }
    // Start-up refuses open invoices on an address missing from the config, so one appearing later was written to the
    // database behind the gateway's back. Its address is never shown to payers (ADR-0037); say so loudly.
    const stray = unpinnedUsage(
      this.#d.catalog,
      await uow.run((r) => r.invoices.addressUsage({ openOnly: true, now: clock.now() })),
    );
    if (stray.length > 0) {
      problems.push(
        `open invoices point at addresses outside the pinned config (not shown to payers): ${stray
          .map((u) => `${u.assetId} ${u.address} (${u.open})`)
          .join(", ")}`,
      );
      await alerts.send({
        key: "invoice-address-unpinned",
        severity: "critical",
        message: problems.at(-1) ?? "",
      });
    }
    const beats = await uow.run((r) => r.heartbeats.list());
    for (const [network, maxLag] of maxScannerLagMs) {
      const hb = beats.find((b) => b.role === `scanner:${network}`);
      const last = hb?.lastOkAt?.getTime() ?? 0;
      if (now - last > maxLag) {
        const age = last ? `${Math.round((now - last) / 1000)} s ago` : "never";
        problems.push(
          `scanner ${network} last succeeded ${age}${hb?.lastError ? ` (last error: ${hb.lastError})` : ""}`,
        );
        await alerts.send({
          key: `scanner-lag:${network}`,
          severity: "critical",
          message: problems.at(-1) ?? "",
        });
      }
    }
    const dead = await uow.run((r) => r.delivery.countDead());
    if (dead > 0) {
      problems.push(`${dead} webhook event(s) in dead-letter`);
      await alerts.send({ key: "webhooks-dead", severity: "warning", message: problems.at(-1) ?? "" });
    }
    const maxDispatcherLag = this.#d.maxDispatcherLagMs;
    if (maxDispatcherLag !== undefined) {
      const hb = beats.find((b) => b.role === "dispatcher");
      const last = hb?.lastOkAt?.getTime() ?? 0;
      if (now - last > maxDispatcherLag) {
        const age = last ? `${Math.round((now - last) / 1000)} s ago` : "never";
        problems.push(`dispatcher last succeeded ${age}`);
        await alerts.send({ key: "dispatcher-lag", severity: "critical", message: problems.at(-1) ?? "" });
      }
      const oldest = await uow.run((r) => r.delivery.oldestDue(clock.now()));
      if (oldest && now - oldest.getTime() > maxDispatcherLag) {
        problems.push(`a webhook event has been due for ${Math.round((now - oldest.getTime()) / 1000)} s`);
        await alerts.send({ key: "webhooks-backlog", severity: "warning", message: problems.at(-1) ?? "" });
      }
    }
    return problems;
  }

  /** Deletes operational rows past their configured retention; invoices, payments, transfers and audit stay. */
  async prune(): Promise<PruneStats> {
    const { uow, clock, retention } = this.#d;
    const stats: PruneStats = { deliveredWebhooks: 0, idempotencyKeys: 0, settledCandidates: 0 };
    if (!retention) return stats;
    const now = clock.now().getTime();
    const before = (ms: number) => new Date(now - ms);
    if (retention.deliveredWebhooksMs !== undefined) {
      stats.deliveredWebhooks = await uow.run((r) =>
        r.delivery.pruneDelivered(before(retention.deliveredWebhooksMs ?? 0)),
      );
    }
    if (retention.idempotencyKeysMs !== undefined) {
      stats.idempotencyKeys = await uow.run((r) =>
        r.idempotency.prune(before(retention.idempotencyKeysMs ?? 0)),
      );
    }
    if (retention.settledCandidatesMs !== undefined) {
      stats.settledCandidates = await uow.run((r) =>
        r.candidates.pruneSettled(before(retention.settledCandidatesMs ?? 0)),
      );
    }
    return stats;
  }

  /**
   * Depeg: if any source deviates from 1.00 by more than the limit, or no source answers, new invoices priced in
   * that asset are blocked (guard in the database, read by CreateInvoice). Cleared when all sources are back in range.
   */
  async checkDepeg(): Promise<{ blocked: boolean; reason: string } | null> {
    const { uow, clock, alerts, depeg } = this.#d;
    if (!depeg) return null;
    const prices: Array<{ name: string; bps: number; over: boolean }> = [];
    const failures: string[] = [];
    for (const s of depeg.sources) {
      try {
        const price = await s.price();
        prices.push({
          name: s.name,
          bps: deviationBps(price),
          over: exceedsDeviation(price, depeg.maxDeviationBps),
        });
      } catch (e) {
        failures.push(`${s.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    const worst = prices.reduce((m, p) => (p.bps > m.bps ? p : m), { name: "-", bps: 0, over: false });
    let blocked = false;
    let reason = `${depeg.symbol}/USD within ${depeg.maxDeviationBps} bps (${prices.map((p) => `${p.name} ${p.bps}`).join(", ")})`;
    if (prices.length === 0) {
      blocked = true;
      reason = `no ${depeg.symbol}/USD price source reachable: ${failures.join("; ")}`;
    } else if (prices.some((p) => p.over)) {
      blocked = true;
      reason = `${depeg.symbol}/USD deviates ${worst.bps} bps at ${worst.name} (limit ${depeg.maxDeviationBps})`;
    }
    const key = `depeg:${depeg.symbol}`;
    const prev = await uow.run((r) => r.guards.get(key));
    await uow.run((r) => r.guards.set(key, blocked, reason, clock.now()));
    if (blocked)
      await alerts.send({
        key,
        severity: "critical",
        message: `new ${depeg.symbol} invoices blocked: ${reason}`,
      });
    else if (prev?.blocked)
      await alerts.send({
        key: `${key}:cleared`,
        severity: "info",
        message: `${depeg.symbol} invoices unblocked: ${reason}`,
      });
    if (failures.length > 0 && !blocked) {
      await alerts.send({
        key: `${key}:source`,
        severity: "warning",
        message: `price source failing: ${failures.join("; ")}`,
      });
    }
    return { blocked, reason };
  }

  /**
   * Compares incoming transfers seen by a second, independent source with our candidates. A transfer the primary
   * scanner missed becomes a candidate (the verifier decides, as for any other); one we credited that the second
   * source does not know is only reported.
   */
  async reconcile(): Promise<ReconcileStats> {
    const { uow, clock, alerts, catalog, secondary, reconcileLookbackMs, reconcileSettleDelayMs } = this.#d;
    const stats: ReconcileStats = {
      checked: 0,
      missedByPrimary: 0,
      notInSecondary: 0,
      truncated: 0,
      errors: 0,
    };
    const now = clock.now().getTime();
    const from = new Date(now - reconcileLookbackMs);
    const until = new Date(now - reconcileSettleDelayMs);
    for (const source of secondary) {
      for (const settings of catalog.forNetwork(source.network)) {
        if (!source.supports(settings.asset)) continue;
        for (const address of watchedAddresses(settings)) {
          let theirs: TransferCandidate[];
          let complete: boolean;
          try {
            const report = await source.incoming(settings.asset, address, settings.addresses, from, until);
            theirs = report.transfers.filter((c) => c.at <= until);
            complete = report.complete;
          } catch (e) {
            stats.errors++;
            await alerts.send({
              key: `reconcile-source:${source.name}`,
              severity: "warning",
              message: `second source ${source.name} failed: ${e instanceof Error ? e.message : e}`,
            });
            continue;
          }
          stats.checked += theirs.length;
          const missed = await uow.run(async (r) => {
            const out: string[] = [];
            for (const c of theirs) {
              const dust = isDust(c.amount, settings.amountPolicy);
              const res = await r.candidates.insert(
                c,
                dust ? "dust" : "seen",
                dust ? "dust (reconciled)" : "reconciled",
              );
              if (res === "inserted") {
                out.push(c.txHash);
                await r.audit.record({
                  at: clock.now(),
                  actor: "scanner",
                  subject: `${c.network}/${c.txHash}`,
                  decision: "reconciled",
                  reason: `missed by the primary indexer, reported by ${source.name}`,
                });
              }
            }
            return out;
          });
          stats.missedByPrimary += missed.length;
          if (missed.length > 0) {
            await alerts.send({
              key: `reconcile-missed:${source.network}:${address.value}`,
              severity: "warning",
              message: `${missed.length} transfer(s) to ${address.value} missed by the primary indexer were queued for verification (${source.name})`,
            });
          }
          if (!complete) {
            // Comparing a partial answer would report every transfer it left out as unknown to the source.
            stats.truncated++;
            await alerts.send({
              key: `reconcile-truncated:${source.network}:${address.value}`,
              severity: "warning",
              message: `${source.name} returned only part of the transfers to ${address.value} in the reconciliation window; transfers we credited were not compared`,
            });
            continue;
          }
          const known = new Set(theirs.map((c) => c.txHash));
          const ours = await uow.run((r) => r.candidates.listVerified(source.network, address, from, until));
          const unknown = ours.filter((h) => !known.has(h));
          stats.notInSecondary += unknown.length;
          if (unknown.length > 0) {
            await alerts.send({
              key: `reconcile-unknown:${source.network}:${address.value}`,
              severity: "warning",
              message: `${unknown.length} verified transfer(s) to ${address.value} are unknown to ${source.name}: ${unknown.slice(0, 3).join(", ")}`,
            });
          }
        }
      }
    }
    return stats;
  }
}
