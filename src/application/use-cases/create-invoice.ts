// SPDX-License-Identifier: Apache-2.0
import type { Asset } from "../../domain/asset.ts";
import { currency, isIsoCurrency, parseFiat } from "../../domain/currency.ts";
import { DomainError } from "../../domain/errors.ts";
import { Invoice, type LockedPrice } from "../../domain/invoice.ts";
import { Money } from "../../domain/money.ts";
import { convertToAsset, type ResolvedRate, withMarkup } from "../../domain/pricing.ts";
import { rationalToDecimal } from "../../domain/rational.ts";
import type { AssetCatalog, PricingSettings } from "../catalog.ts";
import { ApplicationError } from "../errors.ts";
import type { Clock, IdGenerator, UnitOfWork } from "../ports.ts";
import type { RateService } from "../rates.ts";
import type { PaymentInstructionStrategy } from "../strategies/unique-amount.ts";

export interface CreateInvoiceInput {
  readonly merchantOrderId: string;
  /** Decimal string, never a float. */
  readonly priceAmount: string;
  /** ISO 4217 code enabled in config, or the asset's price symbol (e.g. "USDT") for prices already in crypto. */
  readonly priceCurrency: string;
  readonly assetId: string;
}

export interface CreateInvoiceResult {
  readonly invoice: Invoice;
  readonly created: boolean;
}

export class CreateInvoice {
  readonly #deps: CreateInvoiceDeps;

  constructor(deps: CreateInvoiceDeps) {
    this.#deps = deps;
  }

  async execute(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    const { uow, catalog, strategy, clock, ids } = this.#deps;
    const settings = catalog.get(input.assetId);
    const now = clock.now();
    const { base, price } = await this.#price(input, settings.asset, settings.priceSymbol, now);
    if (base.isZero()) throw new ApplicationError("invoice.zero_amount", "price converts to zero");

    return uow.run(async (repos) => {
      // Idempotent creation by merchant order id.
      const existing = await repos.invoices.findByMerchantOrderId(input.merchantOrderId);
      if (existing) return { invoice: existing, created: false };

      const id = ids.newId();
      const expiresAt = new Date(now.getTime() + settings.ttlMs);
      const until = new Date(expiresAt.getTime() + settings.graceMs);
      const { instructions } = await strategy.allocate(
        { invoiceId: id, settings, base, from: now, until },
        repos.slots,
      );
      const invoice = Invoice.create(
        {
          id,
          merchantOrderId: input.merchantOrderId,
          instructions,
          price,
          ttlMs: settings.ttlMs,
          graceMs: settings.graceMs,
        },
        now,
      );
      await repos.invoices.insert(invoice);
      await repos.outbox.append(invoice.pullEvents());
      await repos.audit.record({
        at: now,
        actor: "invoicing",
        subject: id,
        decision: "created",
        reason: "invoice created",
        data: {
          address: instructions.address.value,
          amount: instructions.amount.toDecimalString(),
          base: base.toDecimalString(),
          rate: price?.rate ?? null,
          rateSource: price?.rateSource ?? null,
        },
      });
      return { invoice, created: true };
    });
  }

  async #price(
    input: CreateInvoiceInput,
    asset: Asset,
    priceSymbol: string,
    now: Date,
  ): Promise<{ base: Money; price: LockedPrice | null }> {
    if (input.priceCurrency === priceSymbol)
      return { base: Money.parse(asset, input.priceAmount), price: null };
    if (!isIsoCurrency(input.priceCurrency) || !this.#deps.pricing.currencies.has(input.priceCurrency)) {
      throw new ApplicationError(
        "pricing.currency_disabled",
        `currency ${input.priceCurrency} is not enabled`,
      );
    }
    const fiat = parseFiat(currency(input.priceCurrency), input.priceAmount);
    let resolved: ResolvedRate;
    try {
      resolved = (await this.#deps.rates.resolve(input.priceCurrency, priceSymbol, now)).rate;
    } catch (e) {
      if (e instanceof DomainError && e.code === "pricing.no_rate") {
        throw new ApplicationError(
          "pricing.no_rate",
          `no fresh rate ${input.priceCurrency} → ${priceSymbol}`,
        );
      }
      throw e;
    }
    const rate = withMarkup(resolved.rate, this.#deps.pricing.markupBps.get(input.priceCurrency) ?? 0);
    return {
      base: convertToAsset(fiat, asset, rate),
      price: {
        amount: input.priceAmount,
        currency: input.priceCurrency,
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

export interface CreateInvoiceDeps {
  readonly uow: UnitOfWork;
  readonly catalog: AssetCatalog;
  readonly pricing: PricingSettings;
  readonly rates: RateService;
  readonly strategy: PaymentInstructionStrategy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
