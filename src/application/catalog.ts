// SPDX-License-Identifier: Apache-2.0
import type { AmountPolicy, UniqueAmountPolicy } from "../domain/amount-policy.ts";
import { type Asset, sameAsset } from "../domain/asset.ts";
import type { ChainAddress } from "../domain/chain-address.ts";
import type { NetworkId } from "../domain/network.ts";
import type { PriceSymbol } from "../domain/pricing.ts";
import { ApplicationError } from "./errors.ts";

export interface ReceivingAddress {
  readonly address: ChainAddress;
  /**
   * active: used for new invoices and watched; draining: watched only; retired: neither watched nor shown to payers,
   * kept in the pin so that its invoices stay readable (history, AML decisions). ADR-0037.
   */
  readonly status: "active" | "draining" | "retired";
  /**
   * Account that holds the token for this owner, where the network has one (TON jetton-wallet, later Solana ATA).
   * Pinned like the address itself; null when not applicable.
   */
  readonly tokenAccount: ChainAddress | null;
}

/** Everything the application needs to know about one accepted asset; built from the pinned config. */
export interface AssetSettings {
  readonly asset: Asset;
  readonly priceSymbol: PriceSymbol;
  /** How payments are told apart: unique amount per address, or memo (comment) with unique amount as fallback. */
  readonly strategy: "unique-amount" | "memo";
  readonly addresses: readonly ReceivingAddress[];
  readonly amountPolicy: AmountPolicy;
  readonly uniqueAmount: UniqueAmountPolicy;
  readonly ttlMs: number;
  readonly graceMs: number;
  /** Payments below this total (minimal units) complete without AML screening; 0 screens everything. */
  readonly amlThresholdUnits: bigint;
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
      for (const other of byId.values()) {
        if (sameAsset(other.asset, a.asset)) {
          throw new ApplicationError(
            "config.duplicate_asset",
            `${other.asset.id} and ${a.asset.id} are the same on-chain asset`,
          );
        }
      }
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
}

export function watchedAddresses(settings: AssetSettings): ChainAddress[] {
  return settings.addresses.filter((a) => a.status !== "retired").map((a) => a.address);
}

/**
 * Whether an invoice's stored address may be shown to a payer: it must be a pinned, non-retired address of the
 * invoice's asset. A stored address outside the pin (a removed address, or a row written behind the gateway's back)
 * is never shown; ADR-0037.
 */
export function isShownAddress(settings: AssetSettings, address: string): boolean {
  return settings.addresses.some((a) => a.address.value === address && a.status !== "retired");
}

/** Whether `address` is in the pinned list of the asset, whatever its status. */
export function isPinnedAddress(settings: AssetSettings, address: string): boolean {
  return settings.addresses.some((a) => a.address.value === address);
}

/** Stored (asset, address) pairs whose address is not in the asset's pinned list at all (ADR-0037). */
export function unpinnedUsage<U extends { readonly assetId: string; readonly address: string }>(
  catalog: AssetCatalog,
  usage: readonly U[],
): U[] {
  return usage.filter((u) => !isPinnedAddress(catalog.get(u.assetId), u.address));
}
