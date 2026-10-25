// SPDX-License-Identifier: Apache-2.0
import { type Asset, sameAsset } from "./asset.ts";
import { formatDecimal, parseDecimal } from "./decimal.ts";
import { DomainError, invariant } from "./errors.ts";

/** Non-negative amount of an asset in its minimal units. Immutable; arithmetic only within one asset. */
export class Money {
  readonly asset: Asset;
  readonly units: bigint;

  private constructor(asset: Asset, units: bigint) {
    invariant(units >= 0n, "money.negative", `negative amount ${units} of ${asset.id}`);
    this.asset = asset;
    this.units = units;
    Object.freeze(this);
  }

  static of(asset: Asset, units: bigint): Money {
    return new Money(asset, units);
  }

  static zero(asset: Asset): Money {
    return new Money(asset, 0n);
  }

  /** "10.01" in display units of the asset; more fractional digits than the asset has is an error. */
  static parse(asset: Asset, decimal: string): Money {
    return new Money(asset, parseDecimal(decimal, asset.decimals));
  }

  plus(other: Money): Money {
    this.assertSameAsset(other);
    return new Money(this.asset, this.units + other.units);
  }

  minus(other: Money): Money {
    this.assertSameAsset(other);
    return new Money(this.asset, this.units - other.units);
  }

  /** Signed difference this − other in minimal units. */
  diff(other: Money): bigint {
    this.assertSameAsset(other);
    return this.units - other.units;
  }

  compare(other: Money): -1 | 0 | 1 {
    const d = this.diff(other);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }

  equals(other: Money): boolean {
    return sameAsset(this.asset, other.asset) && this.units === other.units;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  toDecimalString(): string {
    return formatDecimal(this.units, this.asset.decimals);
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.asset.symbol}`;
  }

  private assertSameAsset(other: Money): void {
    if (!sameAsset(this.asset, other.asset)) {
      throw new DomainError("money.asset_mismatch", `cannot combine ${this.asset.id} with ${other.asset.id}`);
    }
  }
}
