// SPDX-License-Identifier: Apache-2.0
// Periodic loop of a process role: one step at a time (a slow cycle never overlaps the next), an exception in one
// cycle never ends the loop, and a stop request wakes the loop from its sleep at once so SIGTERM is honoured within
// the deployment's grace period instead of after a full poll interval.

export interface LoopOptions {
  readonly intervalMs: number;
  /** Aborting ends the loop after the current step; a sleeping loop returns immediately. */
  readonly signal: AbortSignal;
  readonly onError: (error: unknown) => void;
  readonly onCycle?: (result: unknown) => void;
}

/** Sleeps for `ms`, or until `signal` aborts, whichever comes first. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runLoop(step: () => Promise<unknown>, o: LoopOptions): Promise<void> {
  while (!o.signal.aborted) {
    try {
      const result = await step();
      o.onCycle?.(result);
    } catch (e) {
      // A failing provider, endpoint or database must not crash the loop; the next cycle retries.
      o.onError(e);
    }
    if (o.signal.aborted) return;
    await sleep(o.intervalMs, o.signal);
  }
}
