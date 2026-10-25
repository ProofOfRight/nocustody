// SPDX-License-Identifier: Apache-2.0
import { invariant } from "./errors.ts";
import type { NetworkId } from "./network.ts";

/**
 * An address on a network in the canonical form produced by that network's adapter.
 * Format validation and normalisation belong to the chain adapter; the domain only compares canonical values.
 */
export interface ChainAddress {
  readonly network: NetworkId;
  readonly value: string;
}

export function chainAddress(network: NetworkId, value: string): ChainAddress {
  invariant(
    value.length > 0 && value.length <= 128 && !/\s/.test(value),
    "address.invalid",
    `invalid address for ${network}`,
  );
  return Object.freeze({ network, value });
}

export function sameAddress(a: ChainAddress, b: ChainAddress): boolean {
  return a.network === b.network && a.value === b.value;
}
