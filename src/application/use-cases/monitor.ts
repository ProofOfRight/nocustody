// SPDX-License-Identifier: Apache-2.0
// Operations monitor: scanner heartbeat staleness, dead webhooks, never-final candidates, depeg, reconciliation.
// Raises alerts; the only state it changes is the depeg guard (blocks new invoices) and reconciled candidates.
import { isDust } from "../../domain/amount-policy.ts";
import type { NetworkId } from "../../domain/network.ts";
import type { Rational } from "../../domain/rational.ts";
import { type AssetCatalog, watchedAddresses } from "../catalog.ts";
import type {
  AlertSink,
  Clock,
  IntegrityGuard,
  PegPriceSource,
  SecondarySource,
  UnitOfWork,
} from "../ports.ts";

export interface MonitorDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly alerts: AlertSink;
  readonly catalog: AssetCatalog;
  /** Max age of the last successful scanner cycle, per network. */
  readonly maxScannerLagMs: ReadonlyMap<NetworkId, number>;
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
}

export interface ReconcileStats {
  checked: number;
  missedByPrimary: number;
  notInSecondary: number;
  errors: number;
}

/** |x − 1| in basis points, for a price quoted in units of the peg. */
export function deviationBps(price: Rational): number {
  const diff = price.num > price.den ? price.num - price.den : price.den - price.num;
  return Number((diff * 10_000n) / price.den);
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
    return problems;
  }

  /**
   * Depeg: if any source deviates from 1.00 by more than the limit, or no source answers, new invoices priced in
   * that asset are blocked (guard in the database, read by CreateInvoice). Cleared when all sources are back in range.
   */
  async checkDepeg(): Promise<{ blocked: boolean; reason: string } | null> {
    const { uow, clock, alerts, depeg } = this.#d;
    if (!depeg) return null;
    const prices: Array<{ name: string; bps: number }> = [];
    const failures: string[] = [];
    for (const s of depeg.sources) {
      try {
        prices.push({ name: s.name, bps: deviationBps(await s.price()) });
      } catch (e) {
        failures.push(`${s.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    const worst = prices.reduce((m, p) => (p.bps > m.bps ? p : m), { name: "-", bps: 0 });
    let blocked = false;
    let reason = `${depeg.symbol}/USD within ${depeg.maxDeviationBps} bps (${prices.map((p) => `${p.name} ${p.bps}`).join(", ")})`;
    if (prices.length === 0) {
      blocked = true;
      reason = `no ${depeg.symbol}/USD price source reachable: ${failures.join("; ")}`;
    } else if (worst.bps > depeg.maxDeviationBps) {
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
    const stats: ReconcileStats = { checked: 0, missedByPrimary: 0, notInSecondary: 0, errors: 0 };
    const now = clock.now().getTime();
    const from = new Date(now - reconcileLookbackMs);
    const until = new Date(now - reconcileSettleDelayMs);
    for (const source of secondary) {
      for (const settings of catalog.forNetwork(source.network)) {
        if (!source.supports(settings.asset)) continue;
        for (const address of watchedAddresses(settings)) {
          let theirs: Awaited<ReturnType<SecondarySource["incoming"]>>;
          try {
            theirs = (await source.incoming(settings.asset, address, settings.addresses, from)).filter(
              (c) => c.at <= until,
            );
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
