// SPDX-License-Identifier: Apache-2.0
import type { Asset } from "../../domain/asset.ts";
import { currency, isIsoCurrency, parseFiat } from "../../domain/currency.ts";
import { DomainError } from "../../domain/errors.ts";
import type { LockedPrice } from "../../domain/invoice.ts";
import { Money } from "../../domain/money.ts";
import { convertToAsset, type ResolvedRate, withMarkup } from "../../domain/pricing.ts";
import { rationalToDecimal } from "../../domain/rational.ts";
import type { AssetCatalog, PricingSettings } from "../catalog.ts";
import { ApplicationError } from "../errors.ts";
import type { RateService } from "../rates.ts";

export interface PriceInput {
  /** Decimal string, never a float. */
  readonly amount: string;
  /** ISO 4217 code enabled in config, or the asset's price symbol (e.g. "USDT") for prices already in crypto. */
  readonly currency: string;
  readonly assetId: string;
}

export interface Quote {
  readonly asset: Asset;
  /** Amount in the asset before any unique-amount step, rounded up. */
  readonly base: Money;
  /** Null when the price is already in the asset. */
  readonly price: LockedPrice | null;
}

/** Converts a price into the asset with a fresh rate (cross rates, markup, rounding up). No side effects. */
export class QuotePrice {
  readonly #catalog: AssetCatalog;
  readonly #pricing: PricingSettings;
  readonly #rates: RateService;

  constructor(catalog: AssetCatalog, pricing: PricingSettings, rates: RateService) {
    this.#catalog = catalog;
    this.#pricing = pricing;
    this.#rates = rates;
  }

  async execute(input: PriceInput, now: Date): Promise<Quote> {
    const settings = this.#catalog.get(input.assetId);
    const asset = settings.asset;
    if (input.currency === settings.priceSymbol) {
      return { asset, base: Money.parse(asset, input.amount), price: null };
    }
    if (!isIsoCurrency(input.currency) || !this.#pricing.currencies.has(input.currency)) {
      throw new ApplicationError("pricing.currency_disabled", `currency ${input.currency} is not enabled`);
    }
    const fiat = parseFiat(currency(input.currency), input.amount);
    let resolved: ResolvedRate;
    try {
      resolved = (await this.#rates.resolve(input.currency, settings.priceSymbol, now)).rate;
    } catch (e) {
      if (e instanceof DomainError && e.code === "pricing.no_rate") {
        throw new ApplicationError(
          "pricing.no_rate",
          `no fresh rate ${input.currency} → ${settings.priceSymbol}`,
        );
      }
      throw e;
    }
    const rate = withMarkup(resolved.rate, this.#pricing.markupBps.get(input.currency) ?? 0);
    return {
      asset,
      base: convertToAsset(fiat, asset, rate),
      price: {
        amount: input.amount,
        currency: input.currency,
        rate: `${rate.num}/${rate.den}`,
        rateSource: [...new Set(resolved.path.map((h) => h.quote.source))].join(","),
        rateAt: resolved.at,
        ratePath: [
          resolved.from,
          ...resolved.path.map(
            (h) => `${h.inverted ? h.quote.base : h.quote.quote}@${rationalToDecimal(h.quote.rate, 8)}`,
          ),
        ].join(" → "),
      },
    };
  }
}
