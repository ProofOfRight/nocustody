// SPDX-License-Identifier: Apache-2.0
import { currency, isIsoCurrency, parseFiat } from "../../domain/currency.ts";
import { Invoice, type LockedPrice } from "../../domain/invoice.ts";
import type { Money } from "../../domain/money.ts";
import type { AssetCatalog, AssetSettings, PricingSettings } from "../catalog.ts";
import { ApplicationError, ConcurrencyError } from "../errors.ts";
import type { Clock, IdGenerator, IntegrityGuard, Repositories, UnitOfWork } from "../ports.ts";
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
    const { uow, catalog, clock, integrity } = this.#deps;
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

    // Idempotent creation by merchant order id: the same order returns its invoice, a changed order is refused.
    const existing = async (repos: Repositories): Promise<CreateInvoiceResult | null> => {
      const found = await repos.invoices.findByMerchantOrderId(input.merchantOrderId);
      if (!found) return null;
      if (!sameOrder(found, input, settings, base)) {
        throw new ApplicationError(
          "invoice.order_mismatch",
          `merchant order ${input.merchantOrderId} already has an invoice with another price or asset`,
        );
      }
      return { invoice: found, created: false };
    };

    try {
      return await uow.run(async (repos) => {
        // Depeg protection: the monitor blocks new invoices priced in an asset that lost its peg.
        const depeg = await repos.guards.get(`depeg:${settings.priceSymbol}`);
        if (depeg?.blocked) throw new ApplicationError("pricing.depeg_block", depeg.reason);
        return (await existing(repos)) ?? this.#create(repos, input, settings, base, price, now);
      });
    } catch (e) {
      // A concurrent request for the same order won the insert; answer with its invoice.
      if (!(e instanceof ConcurrencyError)) throw e;
      const won = await uow.run(existing);
      if (!won) throw e;
      return won;
    }
  }

  async #create(
    repos: Repositories,
    input: CreateInvoiceInput,
    settings: AssetSettings,
    base: Money,
    price: LockedPrice | null,
    now: Date,
  ): Promise<CreateInvoiceResult> {
    const { strategies, ids } = this.#deps;
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
  }
}

/**
 * Whether an existing invoice was created from the same order: same asset and, for a fiat price, the same amount and
 * currency; for a price given in the asset itself, the invoice amount is the base plus a unique-amount step (0..max).
 */
function sameOrder(
  invoice: Invoice,
  input: CreateInvoiceInput,
  settings: AssetSettings,
  base: Money,
): boolean {
  const s = invoice.state;
  if (s.asset.id !== input.assetId) return false;
  if (s.price) {
    if (s.price.currency !== input.priceCurrency || !isIsoCurrency(s.price.currency)) return false;
    const cur = currency(s.price.currency);
    return parseFiat(cur, s.price.amount).minor === parseFiat(cur, input.priceAmount).minor;
  }
  if (input.priceCurrency !== settings.priceSymbol) return false;
  const extra = s.expected.diff(base);
  const { stepUnits, maxSlots } = settings.uniqueAmount;
  return extra >= 0n && extra % stepUnits === 0n && extra / stepUnits <= BigInt(maxSlots);
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
