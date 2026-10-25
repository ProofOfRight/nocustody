// SPDX-License-Identifier: Apache-2.0
import { invariant } from "./errors.ts";
import type { NetworkId } from "./network.ts";

/**
 * An asset on a network. Identity is (network, kind, contract); decimals come from config.
 * `symbol` is for display only and must never be used to identify an asset.
 */
export interface Asset {
  readonly id: string;
  readonly network: NetworkId;
  readonly kind: "native" | "token";
  readonly contract: string | null;
  readonly decimals: number;
  readonly symbol: string;
}

const ASSET_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function defineAsset(input: Asset): Asset {
  invariant(ASSET_ID.test(input.id), "asset.id", `invalid asset id ${JSON.stringify(input.id)}`);
  invariant(
    Number.isInteger(input.decimals) && input.decimals >= 0 && input.decimals <= 36,
    "asset.decimals",
    `invalid decimals ${input.decimals} for ${input.id}`,
  );
  if (input.kind === "token") {
    invariant(
      typeof input.contract === "string" && input.contract.length > 0,
      "asset.contract",
      `token ${input.id} needs a contract`,
    );
  } else {
    invariant(input.contract === null, "asset.contract", `native asset ${input.id} must not have a contract`);
  }
  return Object.freeze({ ...input });
}

/** Same on-chain asset. Deliberately ignores `symbol` and `id`. */
export function sameAsset(a: Asset, b: Asset): boolean {
  return (
    a.network === b.network && a.kind === b.kind && a.contract === b.contract && a.decimals === b.decimals
  );
}
