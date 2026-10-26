// SPDX-License-Identifier: Apache-2.0
import type { Clock, UnitOfWork, WebhookSender } from "../ports.ts";

export interface DispatchStats {
  delivered: number;
  failed: number;
  dead: number;
}

export interface DispatchWebhooksDeps {
  readonly uow: UnitOfWork;
  readonly sender: WebhookSender;
  readonly clock: Clock;
  readonly batchSize: number;
  /** How long a claimed message is hidden from other dispatchers while it is being sent. */
  readonly leaseMs: number;
  /** After this many failed attempts the message goes to the dead-letter state. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/**
 * Delivers outbox events to the merchant's webhook endpoint: at-least-once, exponential backoff, dead-letter.
 * A failing endpoint never blocks scanning or settlement — they only write to the outbox.
 */
export class DispatchWebhooks {
  readonly #d: DispatchWebhooksDeps;

  constructor(deps: DispatchWebhooksDeps) {
    this.#d = deps;
  }

  /** Delay before attempt number `attempt + 1` (attempt counts failures so far, from 1). */
  delayAfter(attempt: number): number {
    return Math.min(this.#d.maxDelayMs, this.#d.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  }

  async execute(): Promise<DispatchStats> {
    const { uow, sender, clock, batchSize, leaseMs, maxAttempts } = this.#d;
    const stats: DispatchStats = { delivered: 0, failed: 0, dead: 0 };
    const claimed = await uow.run((r) => r.delivery.claim(clock.now(), leaseMs, batchSize));
    for (const m of claimed) {
      let result: Awaited<ReturnType<WebhookSender["send"]>>;
      try {
        result = await sender.send(m);
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true };
      }
      await uow.run(async (r) => {
        const now = clock.now();
        if (result.ok) {
          stats.delivered++;
          await r.delivery.markDelivered(m.id, now);
          return;
        }
        const attempts = m.attempts + 1;
        if (!result.retryable || attempts >= maxAttempts) {
          stats.dead++;
          await r.delivery.markDead(m.id, now, result.error);
          await r.audit.record({
            at: now,
            actor: "invoicing",
            subject: m.aggregateId,
            decision: "webhook_dead",
            reason: result.error,
            data: { eventId: m.eventId, type: m.type, attempts },
          });
          return;
        }
        stats.failed++;
        await r.delivery.markFailed(m.id, new Date(now.getTime() + this.delayAfter(attempts)), result.error);
      });
    }
    return stats;
  }
}
