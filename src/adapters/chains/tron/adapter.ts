// SPDX-License-Identifier: Apache-2.0
// TRON / TRC20 chain adapter (docs/adr/0009-independent-finality-check.md):
//  - candidates: TronGrid v1 TRC20 history per receiving address (indexer; untrusted hint);
//  - truth: /walletsolidity/gettransactioninfobyid — solidified, receipt SUCCESS, Transfer log emitted by the
//    contract from config, recipient in the pinned list, amount from the log.
import type {
  ChainAdapter,
  FetchResult,
  TransferCandidate,
  VerificationResult,
  VerifiedTransfer,
} from "../../../application/ports.ts";
import type { Asset } from "../../../domain/asset.ts";
import { type ChainAddress, chainAddress } from "../../../domain/chain-address.ts";
import { Money } from "../../../domain/money.ts";
import type { NetworkId } from "../../../domain/network.ts";
import { txRef } from "../../../domain/tx-ref.ts";
import type { JsonHttpClient } from "../../http/json-client.ts";
import { parseTronAddress, tronAddressFromHex, tronAddressToHex20 } from "./address.ts";
import { solidTxInfoSchema, trc20HistorySchema } from "./schemas.ts";

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface TronAdapterOptions {
  readonly network: NetworkId;
  readonly client: JsonHttpClient;
  /** Scan start when there is no cursor yet. */
  readonly startFrom: Date;
  /** Each scan re-reads this much before the cursor, so late-indexed transfers are not skipped. */
  readonly overlapMs: number;
  /** Fingerprint pages followed per address per call. */
  readonly maxPagesPerAddress?: number;
}

/** Cursor: last seen block timestamp (ms) per receiving address. */
type Cursor = Record<string, number>;

export class TronAdapter implements ChainAdapter {
  readonly network: NetworkId;
  readonly #o: TronAdapterOptions;

  constructor(o: TronAdapterOptions) {
    if (!o.network.startsWith("tron:")) throw new Error(`not a TRON network: ${o.network}`);
    this.network = o.network;
    this.#o = o;
  }

  supports(asset: Asset): boolean {
    return asset.network === this.network && asset.kind === "token" && asset.contract !== null;
  }

  validateAddress(raw: string): ChainAddress {
    return chainAddress(this.network, parseTronAddress(raw));
  }

  buildPaymentUri(): string | null {
    // No wallet-independent TRC20 payment URI is standardised; support in wallets is unverified (open question).
    return null;
  }

  async fetchIncoming(
    asset: Asset,
    addresses: readonly ChainAddress[],
    cursor: string | null,
    limit: number,
  ): Promise<FetchResult> {
    const contract = this.#contract(asset);
    const state = parseCursor(cursor);
    const next: Cursor = { ...state };
    const out: TransferCandidate[] = [];
    const seen = new Set<string>();
    for (const address of addresses) {
      const from = Math.max(this.#o.startFrom.getTime(), (state[address.value] ?? 0) - this.#o.overlapMs);
      const query: Record<string, string> = {
        only_to: "true",
        only_confirmed: "true",
        contract_address: contract,
        min_timestamp: String(from),
        order_by: "block_timestamp,asc",
        limit: String(Math.min(200, Math.max(1, limit))),
      };
      for (let page = 0; page < (this.#o.maxPagesPerAddress ?? 10); page++) {
        const res = await this.#o.client.get(
          `/v1/accounts/${address.value}/transactions/trc20`,
          query,
          trc20HistorySchema,
        );
        for (const row of res.data) {
          next[address.value] = Math.max(next[address.value] ?? 0, row.block_timestamp);
          // Hint filtering only; the verifier re-checks everything against solidified state.
          if (row.type !== "Transfer" || row.token_info.address !== contract || row.to !== address.value)
            continue;
          if (seen.has(row.transaction_id)) continue;
          seen.add(row.transaction_id);
          out.push({
            network: this.network,
            txHash: row.transaction_id.toLowerCase(),
            from: row.from,
            to: address,
            amount: Money.of(asset, BigInt(row.value)),
            at: new Date(row.block_timestamp),
            memo: null,
          });
        }
        if (!res.meta.fingerprint || res.data.length === 0) break;
        query.fingerprint = res.meta.fingerprint; // all other parameters must stay the same
      }
    }
    return { candidates: out, next: JSON.stringify(next) };
  }

  async verify(
    candidate: TransferCandidate,
    asset: Asset,
    receiving: readonly ChainAddress[],
  ): Promise<VerificationResult> {
    const contractHex = tronAddressToHex20(this.#contract(asset));
    const info = await this.#o.client.post(
      "/walletsolidity/gettransactioninfobyid",
      { value: candidate.txHash },
      solidTxInfoSchema,
    );
    if (!("id" in info)) return { status: "pending", reason: "not solidified yet" };
    if (info.id.toLowerCase() !== candidate.txHash)
      return { status: "rejected", reason: "response for another tx" };
    if (info.result !== undefined && info.result !== "SUCCESS") {
      return { status: "rejected", reason: `transaction result ${info.result}` };
    }
    if (info.receipt.result !== "SUCCESS") {
      return { status: "rejected", reason: `receipt result ${info.receipt.result ?? "missing"}` };
    }
    const ours = new Map(receiving.map((a) => [tronAddressToHex20(a.value), a]));
    const transfers: VerifiedTransfer[] = [];
    for (const [index, log] of (info.log ?? []).entries()) {
      // The asset is the contract that emitted the log — never the token name or symbol.
      if (log.address.toLowerCase() !== contractHex) continue;
      if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      const toTopic = (log.topics[2] ?? "").toLowerCase();
      const to = ours.get(toTopic.slice(-40));
      if (!to || !/^0{24}/.test(toTopic)) continue;
      const data = (log.data ?? "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(data)) continue;
      transfers.push({
        ref: txRef(this.network, candidate.txHash, BigInt(index)),
        from: tronAddressFromHex(log.topics[1] ?? ""),
        to,
        amount: Money.of(asset, BigInt(`0x${data}`)),
        at: new Date(info.blockTimeStamp),
        memo: null,
      });
    }
    return { status: "final", transfers };
  }

  #contract(asset: Asset): string {
    if (!this.supports(asset) || asset.contract === null)
      throw new Error(`asset ${asset.id} is not a TRC20 token here`);
    return asset.contract;
  }
}

function parseCursor(cursor: string | null): Cursor {
  if (!cursor) return {};
  const parsed: unknown = JSON.parse(cursor);
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid TRON cursor");
  const out: Cursor = {};
  for (const [k, v] of Object.entries(parsed))
    if (typeof v === "number" && Number.isSafeInteger(v)) out[k] = v;
  return out;
}
