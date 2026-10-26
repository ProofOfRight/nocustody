// SPDX-License-Identifier: Apache-2.0
import { type RateQuote, type ResolvedRate, resolveRate } from "../domain/pricing.ts";
import type { RateProvider } from "./ports.ts";

/**
 * Chain of rate providers in priority order. Quotes from all reachable providers are combined; `resolveRate` takes
 * the shortest cross-rate path and, among equally short ones, the quote of the earlier provider. A failing provider
 * is skipped and reported to `onFailure`, so one provider being down is visible in the log and never a silent
 * fallback.
 */
export class RateService {
  readonly #providers: readonly RateProvider[];
  readonly #onFailure: (provider: string, error: unknown) => void;

  constructor(
    providers: readonly RateProvider[],
    onFailure: (provider: string, error: unknown) => void = () => {},
  ) {
    this.#providers = providers;
    this.#onFailure = onFailure;
  }

  async resolve(from: string, to: string, now: Date): Promise<{ rate: ResolvedRate }> {
    const quotes: RateQuote[] = [];
    for (const p of this.#providers) {
      try {
        quotes.push(...(await p.quotes()));
      } catch (e) {
        this.#onFailure(p.name, e);
      }
    }
    return { rate: resolveRate(quotes, from, to, now) };
  }
}
