// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { runLoop, sleep } from "./loop.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("process role loop", () => {
  it("keeps running after an exception in one cycle and never overlaps cycles", async () => {
    const ac = new AbortController();
    const errors: unknown[] = [];
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const loop = runLoop(
      async () => {
        calls++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await wait(30); // slower than the interval
        running--;
        if (calls === 2) throw new Error("provider down");
        return calls;
      },
      { intervalMs: 5, signal: ac.signal, onError: (e) => errors.push(e) },
    );
    await wait(200);
    ac.abort();
    await loop;
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(maxRunning).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it("a stop request interrupts the sleep: shutdown does not wait for the poll interval", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const loop = runLoop(async () => undefined, {
      intervalMs: 60 * 60_000, // an hour, like the reconcile interval
      signal: ac.signal,
      onError: () => undefined,
    });
    await wait(20);
    ac.abort();
    await loop;
    expect(Date.now() - started).toBeLessThan(2_000);
    // and a loop asked to stop before it started does not run a step
    let ran = false;
    await runLoop(
      async () => {
        ran = true;
      },
      { intervalMs: 1, signal: ac.signal, onError: () => undefined },
    );
    expect(ran).toBe(false);
  });

  it("sleep resolves early on abort and leaves no timer behind", async () => {
    const ac = new AbortController();
    const p = sleep(60_000, ac.signal);
    ac.abort();
    await expect(p).resolves.toBeUndefined();
    await expect(sleep(1, ac.signal)).resolves.toBeUndefined(); // already aborted
  });
});
