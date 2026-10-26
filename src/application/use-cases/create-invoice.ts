// SPDX-License-Identifier: Apache-2.0
import { Invoice } from "../../domain/invoice.ts";
import type { AssetCatalog, PricingSettings } from "../catalog.ts";
import { ApplicationError } from "../errors.ts";
import type { Clock, IdGenerator, IntegrityGuard, UnitOfWork } from "../ports.ts";
import type { RateService } from "../rates.ts";
import type { StrategyResolver } from "../strategies/strategy.ts";
import { QuotePrice } from "./quote-price.ts";

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
    const { uow, catalog, strategies, clock, ids, integrity } = this.#deps;
    // Never hand out payment instructions if the pinned addresses/contracts may have been tampered with.
    const intact = await integrity.check();
    if (!intact.ok) throw new ApplicationError("integrity.pin_violation", intact.reason);
    const settings = catalog.get(input.assetId);
    const now = clock.now();
    const { base, price } = await new QuotePrice(catalog, this.#deps.pricing, this.#deps.rates).execute(
      { amount: input.priceAmount, currency: input.priceCurrency, assetId: input.assetId },
      now,
    );
    if (base.isZero()) throw new ApplicationError("invoice.zero_amount", "price converts to zero");

    return uow.run(async (repos) => {
      // Depeg protection: the monitor blocks new invoices priced in an asset that lost its peg.
      const depeg = await repos.guards.get(`depeg:${settings.priceSymbol}`);
      if (depeg?.blocked) throw new ApplicationError("pricing.depeg_block", depeg.reason);
      // Idempotent creation by merchant order id.
      const existing = await repos.invoices.findByMerchantOrderId(input.merchantOrderId);
      if (existing) return { invoice: existing, created: false };

      const id = ids.newId();
      const expiresAt = new Date(now.getTime() + settings.ttlMs);
      const until = new Date(expiresAt.getTime() + settings.graceMs);
      const { instructions } = await strategies(settings).allocate(
        { invoiceId: id, settings, base, from: now, until },
        repos,
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
          memo: instructions.memo,
          amount: instructions.amount.toDecimalString(),
          base: base.toDecimalString(),
          rate: price?.rate ?? null,
          rateSource: price?.rateSource ?? null,
        },
      });
      return { invoice, created: true };
    });
  }
}

export interface CreateInvoiceDeps {
  readonly uow: UnitOfWork;
  readonly catalog: AssetCatalog;
  readonly pricing: PricingSettings;
  readonly rates: RateService;
  readonly strategies: StrategyResolver;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly integrity: IntegrityGuard;
}
