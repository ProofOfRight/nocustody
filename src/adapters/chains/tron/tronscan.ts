// SPDX-License-Identifier: Apache-2.0
// Second source for TRON reconciliation: Tronscan GET /api/new/token_trc20/transfers. Returns hints only — every
// reconciled transfer is still verified through /walletsolidity by the primary adapter.
import { z } from "zod";
import type { ReceivingAddress } from "../../../application/catalog.ts";
import type { SecondarySource, TransferCandidate } from "../../../application/ports.ts";
import type { Asset } from "../../../domain/asset.ts";
import type { ChainAddress } from "../../../domain/chain-address.ts";
import { Money } from "../../../domain/money.ts";
import type { NetworkId } from "../../../domain/network.ts";
import type { JsonHttpClient } from "../../http/json-client.ts";

const transfers = z.object({
  token_transfers: z.array(
    z.object({
      transaction_id: z.string().regex(/^[0-9a-fA-F]{64}$/),
      block_ts: z.number().int().nonnegative(),
      from_address: z.string(),
      to_address: z.string(),
      contract_address: z.string(),
      quant: z.string().regex(/^\d{1,78}$/),
      finalResult: z.string().optional(),
    }),
  ),
});

export class TronscanSource implements SecondarySource {
  readonly name = "tronscan";
  readonly network: NetworkId;
  readonly #client: JsonHttpClient;
  readonly #pageSize = 50;
  readonly #maxPages = 10;

  constructor(network: NetworkId, client: JsonHttpClient) {
    this.network = network;
    this.#client = client;
  }

  supports(asset: Asset): boolean {
    return asset.network === this.network && asset.kind === "token" && asset.contract !== null;
  }

  async incoming(
    asset: Asset,
    address: ChainAddress,
    _receiving: readonly ReceivingAddress[],
    from: Date,
  ): Promise<TransferCandidate[]> {
    const out = new Map<string, TransferCandidate>();
    for (let page = 0; page < this.#maxPages; page++) {
      const r = await this.#client.get(
        "/api/new/token_trc20/transfers",
        {
          toAddress: address.value,
          contract_address: asset.contract ?? "",
          start_timestamp: String(from.getTime()),
          limit: String(this.#pageSize),
          start: String(page * this.#pageSize),
        },
        transfers,
      );
      for (const t of r.token_transfers) {
        if (t.to_address !== address.value || t.contract_address !== asset.contract) continue;
        if (t.finalResult !== undefined && t.finalResult !== "SUCCESS") continue;
        const txHash = t.transaction_id.toLowerCase();
        if (!out.has(txHash)) {
          out.set(txHash, {
            network: this.network,
            txHash,
            from: t.from_address,
            to: address,
            amount: Money.of(asset, BigInt(t.quant)),
            at: new Date(t.block_ts),
            memo: null,
          });
        }
      }
      if (r.token_transfers.length < this.#pageSize) break;
    }
    return [...out.values()];
  }
}
