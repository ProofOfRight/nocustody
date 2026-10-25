// SPDX-License-Identifier: Apache-2.0
import { parseDecimal } from "./decimal.ts";
import { DomainError, invariant } from "./errors.ts";

/** Exact positive-or-zero rational number num/den with bigint parts, always normalised (gcd 1, den > 0). */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function rational(num: bigint, den: bigint = 1n): Rational {
  invariant(den !== 0n, "rational.zero_den", "denominator must not be zero");
  invariant(num >= 0n && den > 0n, "rational.negative", "rates are non-negative");
  const g = gcd(num, den) || 1n;
  return Object.freeze({ num: num / g, den: den / g });
}

/** Exact rational from a decimal string such as "92.3456". */
export function rationalFromDecimal(text: string): Rational {
  const frac = text.includes(".") ? (text.split(".")[1] ?? "").length : 0;
  return rational(parseDecimal(text, frac), 10n ** BigInt(frac));
}

export function mul(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

export function inverse(a: Rational): Rational {
  if (a.num === 0n) throw new DomainError("rational.zero_inverse", "cannot invert zero");
  return rational(a.den, a.num);
}

export function compareRational(a: Rational, b: Rational): -1 | 0 | 1 {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** Integer division rounding toward +∞, for non-negative operands. */
export function ceilDiv(n: bigint, d: bigint): bigint {
  invariant(n >= 0n && d > 0n, "rational.ceil_div", "ceilDiv expects n >= 0, d > 0");
  return (n + d - 1n) / d;
}

/** Decimal string with up to `digits` fractional digits, rounded down; for display and audit only. */
export function rationalToDecimal(a: Rational, digits: number): string {
  const scaled = (a.num * 10n ** BigInt(digits)) / a.den;
  const s = scaled.toString().padStart(digits + 1, "0");
  return digits === 0 ? s : `${s.slice(0, -digits)}.${s.slice(-digits)}`.replace(/\.?0+$/, "");
}
