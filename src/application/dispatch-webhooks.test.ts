// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { DeliveryResult, OutboxMessage, WebhookSender } from "./ports.ts";
import { InMemoryStore } from "./testing/in-memory.ts";
import { DispatchWebhooks } from "./use-cases/dispatch-webhooks.ts";

const T0 = new Date("2026-10-26T12:00:00Z").getTime();

function setup(results: DeliveryResult[]) {
  const store = new InMemoryStore();
  let t = T0;
  const sent: OutboxMessage[] = [];
  const sender: WebhookSender = {
    send: async (m) => {
      sent.push(m);
      return results.shift() ?? { ok: true };
    },
  };
  const dispatch = new DispatchWebhooks({
    uow: store,
    sender,
    clock: { now: () => new Date(t) },
    batchSize: 10,
    sendTimeoutMs: 6_000,
    maxAttempts: 3,
    baseDelayMs: 30_000,
    maxDelayMs: 3_600_000,
  });
  const append = () =>
    store.run((r) =>
      r.outbox.append([{ type: "invoice.paid", aggregateId: "inv-1", occurredAt: new Date(T0), data: {} }]),
    );
  return { store, dispatch, sent, append, advance: (ms: number) => (t += ms), now: () => t };
}

describe("DispatchWebhooks", () => {
  it("delivers once and marks the event delivered; every cycle writes the dispatcher heartbeat", async () => {
    const s = setup([]);
    await s.append();
    expect(await s.dispatch.execute()).toEqual({ delivered: 1, failed: 0, dead: 0 });
    expect(await s.dispatch.execute()).toEqual({ delivered: 0, failed: 0, dead: 0 });
    expect(s.sent).toHaveLength(1);
    expect(s.store.data.heartbeats.get("dispatcher")?.lastOkAt?.getTime()).toBe(T0);
  });

  it("retries with exponential backoff, then dead-letters", async () => {
    const fail: DeliveryResult = { ok: false, error: "HTTP 503", retryable: true };
    const s = setup([fail, fail, fail]);
    await s.append();
    expect((await s.dispatch.execute()).failed).toBe(1);
    expect((await s.dispatch.execute()).failed).toBe(0); // not due yet
    s.advance(30_000);
    expect((await s.dispatch.execute()).failed).toBe(1);
    s.advance(59_000);
    expect(s.sent).toHaveLength(2); // second delay is 60 s
    s.advance(1_000);
    expect((await s.dispatch.execute()).dead).toBe(1);
    expect(s.store.data.outboxRows[0]?.deadAt).not.toBeNull();
    expect(s.store.data.audit.at(-1)?.decision).toBe("webhook_dead");
  });

  it("a non-retryable failure (e.g. blocked by SSRF policy) is dead-lettered at once", async () => {
    const s = setup([{ ok: false, error: "private address", retryable: false }]);
    await s.append();
    expect((await s.dispatch.execute()).dead).toBe(1);
  });

  it("a thrown sender error is retried, not lost", async () => {
    const s = setup([]);
    await s.append();
    const broken = new DispatchWebhooks({
      uow: s.store,
      sender: { send: async () => Promise.reject(new Error("socket hang up")) },
      clock: { now: () => new Date(T0) },
      batchSize: 10,
      sendTimeoutMs: 6_000,
      maxAttempts: 3,
      baseDelayMs: 30_000,
      maxDelayMs: 3_600_000,
    });
    expect((await broken.execute()).failed).toBe(1);
    expect(s.store.data.outboxRows[0]?.lastError).toBe("socket hang up");
  });

  it("the lease outlives a whole batch, so a second dispatcher running meanwhile never re-sends", async () => {
    // Ten due events, each send takes the sender's full deadline (6 s). A second dispatcher polls while the first
    // is still half way through its batch. With a lease sized for one send (0.2.1: 2 × timeout + 5 s = 17 s) it
    // would re-claim the rest of the batch; the lease now covers batchSize × timeout.
    const s = setup([]);
    for (let i = 0; i < 10; i++) await s.append();
    const sentBy: string[] = [];
    let second: DispatchWebhooks | null = null;
    const slow = (name: string): WebhookSender => ({
      send: async (m) => {
        sentBy.push(`${name}:${m.eventId}`);
        s.advance(6_000);
        if (name === "A" && sentBy.length === 4 && second) await second.execute();
        return { ok: true };
      },
    });
    const deps = {
      uow: s.store,
      clock: { now: () => new Date(s.now()) },
      batchSize: 10,
      sendTimeoutMs: 6_000,
      maxAttempts: 3,
      baseDelayMs: 30_000,
      maxDelayMs: 3_600_000,
    };
    const first = new DispatchWebhooks({ ...deps, sender: slow("A") });
    second = new DispatchWebhooks({ ...deps, sender: slow("B") });
    expect(first.leaseMs).toBe(65_000);
    expect(await first.execute()).toEqual({ delivered: 10, failed: 0, dead: 0 });
    const ids = sentBy.map((x) => x.split(":")[1]);
    expect(new Set(ids).size).toBe(ids.length); // every event sent exactly once
    expect(sentBy.filter((x) => x.startsWith("B:"))).toHaveLength(0);
  });

  it("caps the delay", () => {
    const s = setup([]);
    expect(s.dispatch.delayAfter(1)).toBe(30_000);
    expect(s.dispatch.delayAfter(20)).toBe(3_600_000);
  });
});
