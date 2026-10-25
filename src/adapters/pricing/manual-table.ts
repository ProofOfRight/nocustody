// SPDX-License-Identifier: Apache-2.0
import type { RateProvider } from "../../application/ports.ts";
import { type RateQuote, rateQuote } from "../../domain/pricing.ts";
import { rationalFromDecimal } from "../../domain/rational.ts";

export interface ManualRate {
  readonly base: string;
  readonly quote: string;
  /** Decimal string, e.g. "1" or "92.35". */
  readonly rate: string;
  /** When the operator set this rate; its age is measured from here. */
  readonly setAt: Date;
  readonly maxAgeMs: number;
}

/** Rates typed in by the operator (config). Zero external requests; the default provider. */
export class ManualRateTable implements RateProvider {
  readonly name = "manual";
  readonly #quotes: readonly RateQuote[];

  constructor(rates: readonly ManualRate[]) {
    this.#quotes = rates.map((r) =>
      rateQuote({
        base: r.base,
        quote: r.quote,
        rate: rationalFromDecimal(r.rate),
        source: "manual",
        at: r.setAt,
        maxAgeMs: r.maxAgeMs,
      }),
    );
  }

  async quotes(): Promise<readonly RateQuote[]> {
    return this.#quotes;
  }
}
