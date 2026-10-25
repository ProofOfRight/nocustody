// SPDX-License-Identifier: Apache-2.0
import { invariant } from "./errors.ts";

/** Network identifier `<family>:<chain>`, e.g. `tron:mainnet`, `tron:nile`, `ton:mainnet`, `evm:56`. */
export type NetworkId = string & { readonly __brand: "NetworkId" };

const NETWORK_ID = /^[a-z][a-z0-9]*:[a-z0-9][a-z0-9-]*$/;

export function networkId(value: string): NetworkId {
  invariant(NETWORK_ID.test(value), "network.invalid", `invalid network id ${JSON.stringify(value)}`);
  return value as NetworkId;
}

export function networkFamily(id: NetworkId): string {
  return id.slice(0, id.indexOf(":"));
}
