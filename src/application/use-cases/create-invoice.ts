// SPDX-License-Identifier: Apache-2.0
import { currency, isIsoCurrency, parseFiat } from "../../domain/currency.ts";
import { Invoice, type LockedPrice } from "../../domain/invoice.ts";
import { Money } from "../../domain/money.ts";
import type { AssetCatalog, AssetSettings, PricingSettings } from "../catalog.ts";
import { ApplicationError, ConcurrencyError } from "../errors.ts";
import type { AlertSink, Clock, IdGenerator, IntegrityGuard, Repositories, UnitOfWork } from "../ports.ts";
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
  /**
   * Return URLs for the payment page, already checked against the configured origins by the caller. Not part of the
   * order: a retry with other URLs gets the existing invoice with the URLs it was created with.
   */
  readonly successUrl?: string | null;
  readonly cancelUrl?: string | null;
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
    // Never hand out payment instructions if the pinned addresses/contracts may have been tampered with. The reason
    // (it may name the config path or quote the file) goes to the guard's log and alert, not to the API caller.
    const intact = await integrity.check();
    if (!intact.ok) {
      throw new ApplicationError(
        "integrity.pin_violation",
        "pinned configuration check failed; new invoices are blocked until the operator restores it",
      );
    }
    const settings = catalog.get(input.assetId);
    const now = clock.now();

    // Idempotent creation by merchant order id: the same order returns its invoice, a changed order is refused.
    const existing = async (repos: Repositories): Promise<CreateInvoiceResult | null> => {
      const found = await repos.invoices.findByMerchantOrderId(input.merchantOrderId);
      if (!found) return null;
      if (!sameOrder(found, input, settings)) {
        throw new ApplicationError(
          "invoice.order_mismatch",
          `merchant order ${input.merchantOrderId} already has an invoice with another price or asset`,
        );
      }
      return { invoice: found, created: false };
    };
    // An existing order is answered before anything is quoted: a rate that went stale or a depeg block since the
    // invoice was created must not turn a retry into a 503.
    const known = await uow.run(existing);
    if (known) return known;

    const { base, price } = await new QuotePrice(catalog, this.#deps.pricing, this.#deps.rates).execute(
      { amount: input.priceAmount, currency: input.priceCurrency, assetId: input.assetId },
      now,
    );
    if (base.isZero()) throw new ApplicationError("invoice.zero_amount", "price converts to zero");

    try {
      return await uow.run(async (repos) => {
        await this.#checkDepeg(repos, settings.priceSymbol, now);
        return (await existing(repos)) ?? this.#create(repos, input, settings, base, price, now);
      });
    } catch (e) {
      if (e instanceof ApplicationError && e.code === "allocation.no_free_slot") {
        // Every active address is full for this price: merchants see 503 until slots free up; the operator must know.
        await this.#deps.alerts
          ?.send({
            key: `slots-exhausted:${settings.asset.id}`,
            severity: "critical",
            message: `${settings.asset.id}: no free amount slot (${settings.uniqueAmount.maxSlots} per address, ${settings.addresses.filter((a) => a.status === "active").length} active address(es)); add addresses or shorten ttl/grace`,
          })
          .catch(() => undefined);
        throw e;
      }
      // A concurrent request for the same order won the insert; answer with its invoice.
      if (!(e instanceof ConcurrencyError)) throw e;
      const won = await uow.run(existing);
      if (!won) throw e;
      return won;
    }
  }

  /**
   * Depeg protection: the monitor blocks new invoices priced in an asset that lost its peg. When it is configured for
   * this symbol, no reading or a stale one blocks as well: a guard that only ever fails open is no guard.
   */
  async #checkDepeg(repos: Repositories, symbol: string, now: Date): Promise<void> {
    const guard = await repos.guards.get(`depeg:${symbol}`);
    if (guard?.blocked) throw new ApplicationError("pricing.depeg_block", guard.reason);
    const cfg = this.#deps.depeg;
    if (!cfg || cfg.symbol !== symbol) return;
    if (!guard) {
      throw new ApplicationError(
        "pricing.depeg_block",
        `no ${symbol} depeg reading yet (is the monitor running?)`,
      );
    }
    const age = now.getTime() - guard.updatedAt.getTime();
    if (age > cfg.maxGuardAgeMs) {
      throw new ApplicationError(
        "pricing.depeg_block",
        `${symbol} depeg reading is ${Math.round(age / 60_000)} min old (is the monitor running?)`,
      );
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
        successUrl: input.successUrl ?? null,
        cancelUrl: input.cancelUrl ?? null,
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
function sameOrder(invoice: Invoice, input: CreateInvoiceInput, settings: AssetSettings): boolean {
  const s = invoice.state;
  if (s.asset.id !== input.assetId) return false;
  if (s.price) {
    if (s.price.currency !== input.priceCurrency || !isIsoCurrency(s.price.currency)) return false;
    const cur = currency(s.price.currency);
    return parseFiat(cur, s.price.amount).minor === parseFiat(cur, input.priceAmount).minor;
  }
  if (input.priceCurrency !== settings.priceSymbol) return false;
  const extra = s.expected.diff(Money.parse(settings.asset, input.priceAmount));
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
  /**
   * Depeg protection as configured: invoices priced in `symbol` need a guard reading not older than `maxGuardAgeMs`
   * that says "not blocked". Missing or stale (the monitor is not running) fails closed.
   */
  readonly depeg?: { readonly symbol: string; readonly maxGuardAgeMs: number } | null;
  /** Operator alerts: slots of an asset exhausted (every active address full). */
  readonly alerts?: AlertSink;
}
