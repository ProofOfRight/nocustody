// SPDX-License-Identifier: Apache-2.0
import { type RateQuote, type ResolvedRate, resolveRate } from "../domain/pricing.ts";
import type { RateProvider } from "./ports.ts";

export interface RateFailure {
  readonly provider: string;
  readonly error: string;
}

/**
 * Chain of rate providers in priority order. Quotes from all reachable providers are combined in that order, so a
 * fresh quote from a higher-priority provider wins and lower ones are the fallback. A failing provider is skipped.
 */
export class RateService {
  readonly #providers: readonly RateProvider[];

  constructor(providers: readonly RateProvider[]) {
    this.#providers = providers;
  }

  async resolve(
    from: string,
    to: string,
    now: Date,
  ): Promise<{ rate: ResolvedRate; failures: RateFailure[] }> {
    const quotes: RateQuote[] = [];
    const failures: RateFailure[] = [];
    for (const p of this.#providers) {
      try {
        quotes.push(...(await p.quotes()));
      } catch (e) {
        failures.push({ provider: p.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { rate: resolveRate(quotes, from, to, now), failures };
  }
}
