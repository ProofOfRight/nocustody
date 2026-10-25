// SPDX-License-Identifier: Apache-2.0
import type { AmountPolicy, UniqueAmountPolicy } from "../domain/amount-policy.ts";
import type { Asset } from "../domain/asset.ts";
import type { ChainAddress } from "../domain/chain-address.ts";
import type { NetworkId } from "../domain/network.ts";
import type { PriceSymbol } from "../domain/pricing.ts";
import { ApplicationError } from "./errors.ts";

export interface ReceivingAddress {
  readonly address: ChainAddress;
  /** active: used for new invoices and watched; draining: watched only. */
  readonly status: "active" | "draining";
}

/** Everything the application needs to know about one accepted asset; built from the pinned config. */
export interface AssetSettings {
  readonly asset: Asset;
  readonly priceSymbol: PriceSymbol;
  readonly addresses: readonly ReceivingAddress[];
  readonly amountPolicy: AmountPolicy;
  readonly uniqueAmount: UniqueAmountPolicy;
  readonly ttlMs: number;
  readonly graceMs: number;
}

export interface PricingSettings {
  /** ISO 4217 codes merchants may price in. */
  readonly currencies: ReadonlySet<string>;
  /** Markup in basis points per currency; missing = 0. */
  readonly markupBps: ReadonlyMap<string, number>;
}

export class AssetCatalog {
  readonly #byId: ReadonlyMap<string, AssetSettings>;

  constructor(assets: readonly AssetSettings[]) {
    const byId = new Map<string, AssetSettings>();
    for (const a of assets) {
      if (byId.has(a.asset.id))
        throw new ApplicationError("config.duplicate_asset", `duplicate asset ${a.asset.id}`);
      byId.set(a.asset.id, a);
    }
    this.#byId = byId;
  }

  get(assetId: string): AssetSettings {
    const s = this.#byId.get(assetId);
    if (!s) throw new ApplicationError("asset.unknown", `asset ${assetId} is not enabled`);
    return s;
  }

  forNetwork(network: NetworkId): AssetSettings[] {
    return [...this.#byId.values()].filter((s) => s.asset.network === network);
  }

  all(): AssetSettings[] {
    return [...this.#byId.values()];
  }
}

export function watchedAddresses(settings: AssetSettings): ChainAddress[] {
  return settings.addresses.map((a) => a.address);
}
