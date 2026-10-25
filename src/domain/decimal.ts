// SPDX-License-Identifier: Apache-2.0
import { DomainError, invariant } from "./errors.ts";

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * Parses a non-negative decimal string into an integer number of `scale`-th units ("10.01", 2 → 1001n).
 * Never rounds: more fractional digits than `scale` is an error. No signs, exponents or whitespace.
 */
export function parseDecimal(text: string, scale: number): bigint {
  invariant(Number.isInteger(scale) && scale >= 0, "decimal.scale", `invalid scale ${scale}`);
  const m = DECIMAL.exec(text);
  if (!m) throw new DomainError("decimal.syntax", `not a non-negative decimal: ${JSON.stringify(text)}`);
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > scale) {
    throw new DomainError("decimal.precision", `${text} has more than ${scale} fractional digits`);
  }
  return BigInt(whole + frac.padEnd(scale, "0"));
}

/** Formats integer units as a decimal string with exactly `scale` fractional digits (1001n, 2 → "10.01"). */
export function formatDecimal(units: bigint, scale: number): string {
  invariant(Number.isInteger(scale) && scale >= 0, "decimal.scale", `invalid scale ${scale}`);
  const sign = units < 0n ? "-" : "";
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, "0");
  if (scale === 0) return sign + digits;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
