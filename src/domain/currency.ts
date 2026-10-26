// SPDX-License-Identifier: Apache-2.0
import { parseDecimal } from "./decimal.ts";
import { DomainError, invariant } from "./errors.ts";
import { ISO_4217_MINOR_UNITS } from "./iso4217.ts";

/** ISO 4217 currency: alphabetic code and number of minor-unit digits from the registry. */
export interface Currency {
  readonly code: string;
  readonly minorUnits: number;
}

export function currency(code: string): Currency {
  const minorUnits = Object.hasOwn(ISO_4217_MINOR_UNITS, code) ? ISO_4217_MINOR_UNITS[code] : undefined;
  if (minorUnits === undefined)
    throw new DomainError("currency.unknown", `unknown ISO 4217 currency ${code}`);
  return Object.freeze({ code, minorUnits });
}

export function isIsoCurrency(code: string): boolean {
  return Object.hasOwn(ISO_4217_MINOR_UNITS, code);
}

/** Non-negative amount in a fiat currency, in minor units (cents, fils, …). */
export interface FiatAmount {
  readonly currency: Currency;
  readonly minor: bigint;
}

export function fiatAmount(cur: Currency, minor: bigint): FiatAmount {
  invariant(minor >= 0n, "fiat.negative", "fiat amount must be non-negative");
  return Object.freeze({ currency: cur, minor });
}

/** "1234.50" in major units; more fractional digits than the currency has is an error (no rounding). */
export function parseFiat(cur: Currency, decimal: string): FiatAmount {
  return fiatAmount(cur, parseDecimal(decimal, cur.minorUnits));
}
