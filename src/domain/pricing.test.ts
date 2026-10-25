// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { currency, fiatAmount, formatFiat, isIsoCurrency, parseFiat } from "./currency.ts";
import { DomainError } from "./errors.ts";
import {
  convertToAsset,
  isFresh,
  priceFor,
  priceList,
  type RateQuote,
  rateQuote,
  resolveRate,
  withMarkup,
} from "./pricing.ts";
import { compareRational, rational, rationalFromDecimal, rationalToDecimal } from "./rational.ts";
import { USDT_TRON } from "./test-fixtures.ts";

const NOW = new Date("2026-10-26T12:00:00Z");
const MIN = 60_000;

function q(
  base: string,
  quote: string,
  rate: string,
  ageMs = 0,
  maxAgeMs = 10 * MIN,
  source = "manual",
): RateQuote {
  return rateQuote({
    base,
    quote,
    rate: rationalFromDecimal(rate),
    source,
    at: new Date(NOW.getTime() - ageMs),
    maxAgeMs,
  });
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : "not-a-domain-error";
  }
  return undefined;
};

describe("ISO 4217 registry", () => {
  it("knows minor units, including 0 and 3 digit currencies", () => {
    expect(currency("USD").minorUnits).toBe(2);
    expect(currency("JPY").minorUnits).toBe(0);
    expect(currency("BHD").minorUnits).toBe(3);
    expect(currency("KWD").minorUnits).toBe(3);
    expect(currency("IRR").minorUnits).toBe(2);
    expect(code(() => currency("XXX1"))).toBe("currency.unknown");
    expect(code(() => currency("toString"))).toBe("currency.unknown");
    expect(isIsoCurrency("USDT")).toBe(false);
  });

  it("parses fiat amounts in the currency's precision without rounding", () => {
    expect(parseFiat(currency("JPY"), "1500").minor).toBe(1500n);
    expect(code(() => parseFiat(currency("JPY"), "1500.5"))).toBe("decimal.precision");
    expect(parseFiat(currency("BHD"), "1.234").minor).toBe(1234n);
    expect(formatFiat(fiatAmount(currency("BHD"), 1234n))).toBe("1.234");
  });
});

describe("rationals", () => {
  it("are exact and normalised", () => {
    expect(rationalFromDecimal("92.50")).toEqual({ num: 185n, den: 2n });
    expect(compareRational(rational(1n, 3n), rational(2n, 6n))).toBe(0);
    expect(rationalToDecimal(rational(1n, 3n), 6)).toBe("0.333333");
  });
});

describe("quote freshness", () => {
  it("rejects stale quotes and quotes far in the future", () => {
    expect(isFresh(q("USD", "USDT", "1", 9 * MIN), NOW)).toBe(true);
    expect(isFresh(q("USD", "USDT", "1", 11 * MIN), NOW)).toBe(false);
    expect(isFresh(q("USD", "USDT", "1", -2 * MIN), NOW)).toBe(false);
  });

  it("never resolves a rate from a stale quote", () => {
    expect(code(() => resolveRate([q("USD", "USDT", "1", 11 * MIN)], "USD", "USDT", NOW))).toBe(
      "pricing.no_rate",
    );
  });
});

describe("cross rates", () => {
  const quotes = [
    q("USD", "USDT", "1"),
    q("USD", "JPY", "150"),
    q("USD", "IRR", "1050000"),
    q("BHD", "USD", "2.65"),
  ];

  it("goes through the base currency and records the path", () => {
    const r = resolveRate(quotes, "JPY", "USDT", NOW);
    expect(r.rate).toEqual(rational(1n, 150n));
    expect(r.path.map((h) => [h.quote.base, h.quote.quote, h.inverted])).toEqual([
      ["USD", "JPY", true],
      ["USD", "USDT", false],
    ]);
  });

  it("reports the oldest quote time on the path", () => {
    const r = resolveRate(
      [q("USD", "USDT", "1", 5 * MIN), q("USD", "JPY", "150", 1 * MIN)],
      "JPY",
      "USDT",
      NOW,
    );
    expect(r.at.getTime()).toBe(NOW.getTime() - 5 * MIN);
  });

  it("prefers the first quote among equally short paths (provider priority)", () => {
    const r = resolveRate(
      [q("USD", "USDT", "1", 0, MIN, "a"), q("USD", "USDT", "0.99", 0, MIN, "b")],
      "USD",
      "USDT",
      NOW,
    );
    expect(r.path[0]?.quote.source).toBe("a");
  });

  it("fails without a connecting path", () => {
    expect(code(() => resolveRate(quotes, "EUR", "USDT", NOW))).toBe("pricing.no_rate");
  });
});

describe("conversion to the asset", () => {
  const quotes = [
    q("USD", "USDT", "1"),
    q("USD", "JPY", "150"),
    q("USD", "IRR", "1050000"),
    q("BHD", "USD", "2.65"),
  ];
  const convert = (cur: string, amount: string): string => {
    const price = parseFiat(currency(cur), amount);
    const rate = resolveRate(quotes, cur, "USDT", NOW).rate;
    return convertToAsset(price, USDT_TRON, rate).toDecimalString();
  };

  it("JPY (0 minor digits)", () => {
    expect(convert("JPY", "1500")).toBe("10.000000");
    expect(convert("JPY", "1")).toBe("0.006667"); // 0.0066666… rounded up
  });

  it("BHD (3 minor digits)", () => {
    expect(convert("BHD", "3.775")).toBe("10.003750");
    expect(convert("BHD", "0.001")).toBe("0.002650");
  });

  it("IRR (large numbers)", () => {
    expect(convert("IRR", "10500000")).toBe("10.000000");
    expect(convert("IRR", "123456789012.34")).toBe("117577.894298");
  });

  it("applies markup per currency", () => {
    const rate = withMarkup(rational(1n), 150);
    expect(convertToAsset(parseFiat(currency("USD"), "10"), USDT_TRON, rate).toDecimalString()).toBe(
      "10.150000",
    );
    expect(code(() => withMarkup(rational(1n), -1))).toBe("pricing.markup");
  });

  it("always rounds up: the merchant never receives less than the price", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.constantFrom("JPY", "USD", "BHD", "IRR"),
        (minor, num, den, cur) => {
          const c = currency(cur);
          const rate = rational(num, den);
          const units = convertToAsset(fiatAmount(c, minor), USDT_TRON, rate).units;
          // exact value in asset units = minor * num * 10^6 / (den * 10^minorUnits)
          const exactN = minor * rate.num * 10n ** 6n;
          const exactD = rate.den * 10n ** BigInt(c.minorUnits);
          expect(units * exactD >= exactN).toBe(true);
          expect((units - 1n) * exactD < exactN || units === 0n).toBe(true);
        },
      ),
    );
  });
});

describe("price lists", () => {
  it("holds one price per currency", () => {
    const list = priceList([parseFiat(currency("CNY"), "68"), parseFiat(currency("USD"), "9.99")]);
    expect(priceFor(list, "CNY")?.minor).toBe(6800n);
    expect(priceFor(list, "EUR")).toBeUndefined();
    expect(code(() => priceList([parseFiat(currency("USD"), "1"), parseFiat(currency("USD"), "2")]))).toBe(
      "pricelist.duplicate",
    );
  });
});
