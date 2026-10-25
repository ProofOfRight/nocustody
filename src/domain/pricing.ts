// SPDX-License-Identifier: Apache-2.0
import type { Asset } from "./asset.ts";
import type { FiatAmount } from "./currency.ts";
import { DomainError, invariant } from "./errors.ts";
import { Money } from "./money.ts";
import { ceilDiv, inverse, mul, type Rational, rational } from "./rational.ts";

/**
 * Price symbol: an ISO 4217 code ("USD", "JPY") or a crypto pricing symbol configured for assets ("USDT", "GRAM").
 * Pricing symbols are configuration, not on-chain identity: the on-chain asset is always identified by its contract.
 */
export type PriceSymbol = string;

const SYMBOL = /^[A-Z][A-Z0-9]{1,9}$/;

/** 1 major unit of `base` costs `rate` major units of `quote`. */
export interface RateQuote {
  readonly base: PriceSymbol;
  readonly quote: PriceSymbol;
  readonly rate: Rational;
  readonly source: string;
  readonly at: Date;
  /** Quotes older than this are never used. */
  readonly maxAgeMs: number;
}

export function rateQuote(q: RateQuote): RateQuote {
  invariant(SYMBOL.test(q.base) && SYMBOL.test(q.quote), "quote.symbol", `invalid pair ${q.base}/${q.quote}`);
  invariant(q.base !== q.quote, "quote.symbol", "base and quote must differ");
  invariant(q.rate.num > 0n, "quote.rate", "rate must be positive");
  invariant(
    Number.isInteger(q.maxAgeMs) && q.maxAgeMs > 0,
    "quote.max_age",
    "maxAgeMs must be a positive integer",
  );
  invariant(!Number.isNaN(q.at.getTime()), "quote.at", "invalid quote timestamp");
  return Object.freeze({ ...q });
}

/** Allowed clock skew for quotes timestamped slightly in the future. */
export const QUOTE_FUTURE_SKEW_MS = 60_000;

export function isFresh(q: RateQuote, now: Date): boolean {
  const age = now.getTime() - q.at.getTime();
  return age <= q.maxAgeMs && age >= -QUOTE_FUTURE_SKEW_MS;
}

/** One hop of a resolved path; `inverted` when the quote was used in the quote → base direction. */
export interface RateHop {
  readonly quote: RateQuote;
  readonly inverted: boolean;
}

export interface ResolvedRate {
  readonly from: PriceSymbol;
  readonly to: PriceSymbol;
  /** 1 major unit of `from` = `rate` major units of `to`. */
  readonly rate: Rational;
  readonly path: readonly RateHop[];
  /** Timestamp of the oldest quote on the path. */
  readonly at: Date;
}

/**
 * Finds the shortest chain of fresh quotes from `from` to `to` (cross rate through a base currency, e.g.
 * JPY → USD → USDT). Quotes may be used in either direction. Among equally short paths the first in input order
 * wins, so callers pass quotes in provider priority order. Throws `pricing.no_rate` if no fresh path exists.
 */
export function resolveRate(
  quotes: readonly RateQuote[],
  from: PriceSymbol,
  to: PriceSymbol,
  now: Date,
  maxHops = 3,
): ResolvedRate {
  if (from === to) return { from, to, rate: rational(1n), path: [], at: now };
  const fresh = quotes.filter((q) => isFresh(q, now));
  let frontier: Array<{ symbol: PriceSymbol; path: RateHop[] }> = [{ symbol: from, path: [] }];
  const visited = new Set([from]);
  for (let depth = 0; depth < maxHops && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      for (const q of fresh) {
        const step: Array<[PriceSymbol, boolean]> = [];
        if (q.base === node.symbol) step.push([q.quote, false]);
        if (q.quote === node.symbol) step.push([q.base, true]);
        for (const [symbol, inverted] of step) {
          if (visited.has(symbol)) continue;
          const path = [...node.path, { quote: q, inverted }];
          if (symbol === to) return finish(from, to, path);
          visited.add(symbol);
          next.push({ symbol, path });
        }
      }
    }
    frontier = next;
  }
  throw new DomainError("pricing.no_rate", `no fresh rate ${from} → ${to}`);
}

function finish(from: PriceSymbol, to: PriceSymbol, path: RateHop[]): ResolvedRate {
  let rate = rational(1n);
  let at = path[0]?.quote.at ?? new Date(0);
  for (const hop of path) {
    rate = mul(rate, hop.inverted ? inverse(hop.quote.rate) : hop.quote.rate);
    if (hop.quote.at < at) at = hop.quote.at;
  }
  return Object.freeze({ from, to, rate, path, at });
}

/** Markup (spread) in basis points applied to the rate, e.g. 150 = +1.5 %. */
export function withMarkup(rate: Rational, markupBps: number): Rational {
  invariant(
    Number.isInteger(markupBps) && markupBps >= 0 && markupBps <= 10_000,
    "pricing.markup",
    "markup 0..10000 bps",
  );
  return mul(rate, rational(BigInt(10_000 + markupBps), 10_000n));
}

/**
 * Converts a fiat price into the asset, rounding **up** to the asset's minimal unit (the merchant never receives
 * less than the price). `rate`: 1 major unit of the fiat currency = `rate` major units of the asset.
 */
export function convertToAsset(price: FiatAmount, asset: Asset, rate: Rational): Money {
  const n = price.minor * rate.num * 10n ** BigInt(asset.decimals);
  const d = rate.den * 10n ** BigInt(price.currency.minorUnits);
  return Money.of(asset, ceilDiv(n, d));
}

/** Merchant-defined prices of one item in several currencies ("round" prices instead of converted ones). */
export interface PriceList {
  readonly prices: ReadonlyMap<string, FiatAmount>;
}

export function priceList(amounts: readonly FiatAmount[]): PriceList {
  const prices = new Map<string, FiatAmount>();
  for (const a of amounts) {
    invariant(!prices.has(a.currency.code), "pricelist.duplicate", `duplicate price in ${a.currency.code}`);
    prices.set(a.currency.code, a);
  }
  return Object.freeze({ prices });
}

export function priceFor(list: PriceList, currencyCode: string): FiatAmount | undefined {
  return list.prices.get(currencyCode);
}
