// SPDX-License-Identifier: Apache-2.0
import { invariant } from "./errors.ts";
import { type NetworkId, networkId } from "./network.ts";

/**
 * Identity of one transfer: transaction hash plus an index unique within the transaction
 * (log index on TRON/EVM, logical time on TON, instruction index on Solana). Idempotency key.
 */
export interface TxRef {
  readonly network: NetworkId;
  readonly txHash: string;
  readonly index: bigint;
}

export function txRef(network: NetworkId, txHash: string, index: bigint): TxRef {
  invariant(/^[0-9A-Za-z_-]{16,128}$/.test(txHash), "txref.hash", `invalid tx hash for ${network}`);
  invariant(index >= 0n, "txref.index", "transfer index must be non-negative");
  return Object.freeze({ network, txHash, index });
}

export function txRefKey(ref: TxRef): string {
  return `${ref.network}/${ref.txHash}/${ref.index}`;
}

/** Inverse of `txRefKey`; throws on anything that is not a key it produced. */
export function parseTxRefKey(key: string): TxRef {
  const parts = key.split("/");
  invariant(parts.length === 3, "txref.key", `malformed transfer key ${key}`);
  const [network, txHash, index] = parts as [string, string, string];
  invariant(/^\d+$/.test(index), "txref.key", `malformed transfer index in ${key}`);
  return txRef(networkId(network), txHash, BigInt(index));
}
