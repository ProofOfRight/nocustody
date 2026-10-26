// SPDX-License-Identifier: Apache-2.0
// Second source for TON reconciliation: tonapi GET /v2/blockchain/accounts/{id}/transactions. Applies the same
// filters as the primary adapter (notification from OUR jetton-wallet; plain native transfers) and returns hints
// only — every reconciled transaction is still verified through toncenter by the primary adapter.
import { z } from "zod";
import type { ReceivingAddress } from "../../../application/catalog.ts";
import type { SecondarySource, TransferCandidate } from "../../../application/ports.ts";
import type { Asset } from "../../../domain/asset.ts";
import type { ChainAddress } from "../../../domain/chain-address.ts";
import { Money } from "../../../domain/money.ts";
import type { NetworkId } from "../../../domain/network.ts";
import type { JsonHttpClient } from "../../http/json-client.ts";
import { canonicalTon } from "./address.ts";

const tx = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  lt: z.number().int(),
  utime: z.number().int(),
  in_msg: z
    .object({
      msg_type: z.string(),
      source: z.object({ address: z.string() }).nullable().optional(),
      value: z.number().int().nonnegative().optional(),
      op_code: z.string().optional(),
      bounced: z.boolean().optional(),
      decoded_body: z.unknown().optional(),
    })
    .nullable()
    .optional(),
});
const page = z.object({ transactions: z.array(tx) });
const notifyBody = z.object({
  amount: z.string().regex(/^\d{1,40}$/),
  sender: z.string().optional(),
  forward_payload: z
    .object({
      value: z.object({ sum_type: z.string(), value: z.object({ text: z.string() }).optional() }).optional(),
    })
    .optional(),
});

export class TonapiSource implements SecondarySource {
  readonly name = "tonapi";
  readonly network: NetworkId;
  readonly #client: JsonHttpClient;
  readonly #pageSize = 100;
  readonly #maxPages = 10;

  constructor(network: NetworkId, client: JsonHttpClient) {
    this.network = network;
    this.#client = client;
  }

  supports(asset: Asset): boolean {
    return asset.network === this.network;
  }

  async incoming(
    asset: Asset,
    address: ChainAddress,
    receiving: readonly ReceivingAddress[],
    from: Date,
  ): Promise<TransferCandidate[]> {
    const jettonWallet =
      receiving.find((r) => r.address.value === address.value)?.tokenAccount?.value ?? null;
    if (asset.kind === "token" && !jettonWallet) return [];
    const out: TransferCandidate[] = [];
    const fromUtime = Math.floor(from.getTime() / 1000);
    // Newest first, paging backwards with before_lt, until the window start is crossed.
    let beforeLt: number | null = null;
    for (let i = 0; i < this.#maxPages; i++) {
      const query: Record<string, string> = { limit: String(this.#pageSize), sort_order: "desc" };
      if (beforeLt !== null) query.before_lt = String(beforeLt);
      const r = await this.#client.get(`/v2/blockchain/accounts/${address.value}/transactions`, query, page);
      let crossed = false;
      for (const t of r.transactions) {
        beforeLt = t.lt;
        if (t.utime < fromUtime) {
          crossed = true;
          continue;
        }
        const c = this.#candidate(asset, address, jettonWallet, t);
        if (c) out.push(c);
      }
      if (crossed || r.transactions.length < this.#pageSize) break;
    }
    return out;
  }

  #candidate(
    asset: Asset,
    address: ChainAddress,
    jettonWallet: string | null,
    t: z.infer<typeof tx>,
  ): TransferCandidate | null {
    const m = t.in_msg;
    if (m?.msg_type !== "int_msg" || !m.source?.address || m.bounced) return null;
    const base = { network: this.network, txHash: t.hash, to: address, at: new Date(t.utime * 1000) };
    if (asset.kind === "token") {
      if (m.op_code !== "0x7362d09c" || canonicalTon(m.source.address) !== jettonWallet) return null;
      const body = notifyBody.safeParse(m.decoded_body);
      if (!body.success) return null;
      const fp = body.data.forward_payload?.value;
      return {
        ...base,
        from: body.data.sender ? canonicalTon(body.data.sender) : "",
        amount: Money.of(asset, BigInt(body.data.amount)),
        memo: fp?.sum_type === "TextComment" ? (fp.value?.text ?? null) : null,
      };
    }
    if (m.op_code !== undefined && m.op_code !== "0x00000000") return null;
    if (!m.value || m.value <= 0) return null;
    const text = (m.decoded_body as { text?: unknown } | undefined)?.text;
    return {
      ...base,
      from: canonicalTon(m.source.address),
      amount: Money.of(asset, BigInt(m.value)),
      memo: typeof text === "string" ? text : null,
    };
  }
}
