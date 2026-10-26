// SPDX-License-Identifier: Apache-2.0
// TON chain adapter: USDT (and other) jettons and the native coin GRAM, one wallet per merchant, invoice by memo.
//  - candidates: transactions of the receiving wallet from toncenter v3 (indexer; untrusted hint);
//  - truth: the same transaction re-read by hash must be finalized (masterchain), not emulated, without outgoing
//    messages (no bounce). Jettons: the notification must come from OUR jetton-wallet (pinned, checked with
//    get_wallet_address at startup), and the jetton-wallet transaction that credited the balance (internal_transfer)
//    must be finalized and successful, with the same amount. GRAM: the amount is what the credit phase credited.
// The notification transaction itself is usually "aborted" (no gas for 1 nanoton) — that is normal and not checked.
import { Address, beginCell, Cell } from "@ton/core";
import type {
  ChainAdapter,
  FetchResult,
  TransferCandidate,
  VerificationResult,
  VerifiedTransfer,
} from "../../../application/ports.ts";
import type { Asset } from "../../../domain/asset.ts";
import { type ChainAddress, chainAddress } from "../../../domain/chain-address.ts";
import type { PaymentInstructions } from "../../../domain/invoice.ts";
import { Money } from "../../../domain/money.ts";
import type { NetworkId } from "../../../domain/network.ts";
import { txRef } from "../../../domain/tx-ref.ts";
import type { JsonHttpClient } from "../../http/json-client.ts";
import { canonicalTon, friendlyTon, parseTonAddress } from "./address.ts";
import {
  OP_INTERNAL_TRANSFER,
  OP_TRANSFER_NOTIFICATION,
  parseInternalTransferAmount,
  parsePlainComment,
  parseTransferNotification,
} from "./payload.ts";
import {
  isFinalized,
  runGetMethodSchema,
  type TonTransaction,
  tonTransactionSchema,
  tonTransactionsSchema,
} from "./schemas.ts";

export interface TonAdapterOptions {
  readonly network: NetworkId;
  readonly client: JsonHttpClient;
  readonly startFrom: Date;
  readonly overlapMs: number;
  /** Pinned jetton-wallet per (asset id, owner raw address). */
  readonly jettonWallets: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly maxPagesPerAddress?: number;
}

type Cursor = Record<string, number>; // owner → last seen utime (seconds)

const opcode = (n: number) => `0x${n.toString(16).padStart(8, "0")}`;
const b64ToHex = (b64: string) => Buffer.from(b64, "base64").toString("hex");
const hexToB64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

export class TonAdapter implements ChainAdapter {
  readonly network: NetworkId;
  readonly #o: TonAdapterOptions;

  constructor(o: TonAdapterOptions) {
    if (!o.network.startsWith("ton:")) throw new Error(`not a TON network: ${o.network}`);
    this.network = o.network;
    this.#o = o;
  }

  get #testnet(): boolean {
    return this.network !== "ton:mainnet";
  }

  supports(asset: Asset): boolean {
    if (asset.network !== this.network) return false;
    return asset.kind === "native" ? asset.contract === null : asset.contract !== null;
  }

  validateAddress(raw: string): ChainAddress {
    return chainAddress(this.network, parseTonAddress(raw));
  }

  formatAddress(address: ChainAddress): string {
    return friendlyTon(address.value, this.#testnet);
  }

  buildPaymentUri(instr: PaymentInstructions): string | null {
    const asset = instr.amount.asset;
    const params = new URLSearchParams();
    if (asset.kind === "token" && asset.contract)
      params.set("jetton", friendlyTon(asset.contract, this.#testnet));
    params.set("amount", instr.amount.units.toString());
    if (instr.memo) params.set("text", instr.memo);
    return `ton://transfer/${friendlyTon(instr.address.value, this.#testnet)}?${params.toString()}`;
  }

  /**
   * Startup check: every pinned jetton-wallet must be what the pinned master returns for the owner.
   * Protects against a fake jetton-wallet in config. Returns the list of problems (empty = ok).
   */
  async checkJettonWallets(assets: readonly Asset[]): Promise<string[]> {
    const problems: string[] = [];
    for (const asset of assets) {
      if (asset.network !== this.network || asset.kind !== "token" || !asset.contract) continue;
      for (const [owner, pinned] of this.#o.jettonWallets.get(asset.id) ?? new Map()) {
        const actual = await this.#jettonWalletOf(asset.contract, owner);
        if (actual !== pinned)
          problems.push(`${asset.id}: jetton-wallet of ${owner} is ${actual}, config has ${pinned}`);
      }
    }
    return problems;
  }

  async #jettonWalletOf(master: string, owner: string): Promise<string> {
    const arg = beginCell().storeAddress(Address.parse(owner)).endCell().toBoc().toString("base64");
    const res = await this.#o.client.post(
      "/api/v3/runGetMethod",
      { address: master, method: "get_wallet_address", stack: [{ type: "slice", value: arg }] },
      runGetMethodSchema,
    );
    const item = res.stack[0];
    if (res.exit_code !== 0 || !item || (item.type !== "cell" && item.type !== "slice")) {
      throw new Error(`get_wallet_address failed (exit code ${res.exit_code})`);
    }
    return Cell.fromBase64(item.value).beginParse().loadAddress().toRawString().toLowerCase();
  }

  #jettonWallet(asset: Asset, owner: string): string | null {
    return this.#o.jettonWallets.get(asset.id)?.get(owner) ?? null;
  }

  async fetchIncoming(
    asset: Asset,
    addresses: readonly ChainAddress[],
    cursor: string | null,
    limit: number,
  ): Promise<FetchResult> {
    if (!this.supports(asset)) throw new Error(`asset ${asset.id} is not supported by the TON adapter`);
    const state = parseCursor(cursor);
    const next: Cursor = { ...state };
    const out: TransferCandidate[] = [];
    const pageSize = Math.min(256, Math.max(1, limit));
    for (const owner of addresses) {
      const fromUtime = Math.max(
        Math.floor(this.#o.startFrom.getTime() / 1000),
        (state[owner.value] ?? 0) - Math.ceil(this.#o.overlapMs / 1000),
      );
      for (let page = 0; page < (this.#o.maxPagesPerAddress ?? 10); page++) {
        const res = await this.#o.client.get(
          "/api/v3/transactions",
          {
            account: owner.value,
            start_utime: String(fromUtime),
            sort: "asc",
            limit: String(pageSize),
            offset: String(page * pageSize),
          },
          tonTransactionsSchema,
        );
        for (const t of res.transactions) {
          next[owner.value] = Math.max(next[owner.value] ?? 0, t.now);
          const c = this.#candidate(asset, owner, t);
          if (c) out.push(c);
        }
        if (res.transactions.length < pageSize) break;
      }
    }
    return { candidates: out, next: JSON.stringify(next) };
  }

  /** Hint extraction; the verifier re-checks everything against finalized state. */
  #candidate(asset: Asset, owner: ChainAddress, t: TonTransaction): TransferCandidate | null {
    const m = t.in_msg;
    if (!m?.source || m.bounced) return null;
    const base = { network: this.network, txHash: b64ToHex(t.hash), to: owner, at: new Date(t.now * 1000) };
    if (asset.kind === "token") {
      const jw = this.#jettonWallet(asset, owner.value);
      if (!jw || canonicalTon(m.source) !== jw || m.opcode !== opcode(OP_TRANSFER_NOTIFICATION)) return null;
      const n = m.message_content?.body ? parseTransferNotification(m.message_content.body) : null;
      if (!n) return null;
      return { ...base, from: n.sender ?? "", amount: Money.of(asset, n.amount), memo: n.comment };
    }
    if (m.opcode !== null && m.opcode !== opcode(0)) return null;
    const value = BigInt(m.value ?? "0");
    if (value <= 0n) return null;
    return {
      ...base,
      from: canonicalTon(m.source),
      amount: Money.of(asset, value),
      memo: parsePlainComment(m.message_content?.body),
    };
  }

  async verify(
    c: TransferCandidate,
    asset: Asset,
    receiving: readonly ChainAddress[],
  ): Promise<VerificationResult> {
    const res = await this.#o.client.get(
      "/api/v3/transactions",
      { hash: hexToB64(c.txHash) },
      tonTransactionsSchema,
    );
    const t = res.transactions[0];
    if (!t) return { status: "pending", reason: "transaction not indexed yet" };
    if (b64ToHex(t.hash) !== c.txHash)
      return { status: "rejected", reason: "response for another transaction" };
    if (!isFinalized(t))
      return { status: "pending", reason: `not finalized (finality ${t.finality ?? "unknown"})` };
    const owner = receiving.find((a) => a.value === canonicalTon(t.account));
    if (!owner) return { status: "rejected", reason: "transaction is not on a watched wallet" };
    const m = t.in_msg;
    if (!m?.source) return { status: "rejected", reason: "no internal inbound message" };
    if (m.bounced) return { status: "rejected", reason: "inbound message is a bounce" };
    if (t.out_msgs.length !== 0)
      return { status: "rejected", reason: "wallet sent messages back (bounce or reply)" };
    const ref = txRef(this.network, c.txHash, BigInt(t.lt));
    const at = new Date(t.now * 1000);

    if (asset.kind === "token") return this.#verifyJetton(asset, owner, t, ref, at);

    // Native coin: what the credit phase actually credited.
    if (m.opcode !== null && m.opcode !== opcode(0)) return { status: "final", transfers: [] };
    if (t.description.destroyed) return { status: "rejected", reason: "account destroyed" };
    const credited = BigInt(t.description.credit_ph?.credit ?? "0");
    if (credited <= 0n) return { status: "rejected", reason: "nothing credited" };
    const transfer: VerifiedTransfer = {
      ref,
      from: canonicalTon(m.source),
      to: owner,
      amount: Money.of(asset, credited),
      at,
      memo: parsePlainComment(m.message_content?.body),
    };
    return { status: "final", transfers: [transfer] };
  }

  async #verifyJetton(
    asset: Asset,
    owner: ChainAddress,
    t: TonTransaction,
    ref: VerifiedTransfer["ref"],
    at: Date,
  ): Promise<VerificationResult> {
    const m = t.in_msg;
    const jw = this.#jettonWallet(asset, owner.value);
    // The asset is identified by OUR jetton-wallet of the pinned master — never by the indexer's jetton_master or metadata.
    if (!m?.source || !jw || canonicalTon(m.source) !== jw) return { status: "final", transfers: [] };
    if (m.opcode !== opcode(OP_TRANSFER_NOTIFICATION)) return { status: "final", transfers: [] };
    const n = m.message_content?.body ? parseTransferNotification(m.message_content.body) : null;
    if (!n) return { status: "rejected", reason: "malformed transfer_notification" };

    const parents = await this.#o.client.get(
      "/api/v3/transactionsByMessage",
      { msg_hash: m.hash, direction: "out" },
      tonTransactionsSchema,
    );
    const p = parents.transactions.find((x) => canonicalTon(x.account) === jw);
    if (!p) return { status: "pending", reason: "jetton-wallet transaction not indexed yet" };
    const parsed = tonTransactionSchema.parse(p);
    if (!isFinalized(parsed)) return { status: "pending", reason: "jetton-wallet transaction not finalized" };
    const d = parsed.description;
    if (d.aborted || d.compute_ph.success !== true || d.action?.success !== true) {
      return { status: "rejected", reason: "jetton-wallet transaction failed" };
    }
    if (parsed.in_msg?.opcode !== opcode(OP_INTERNAL_TRANSFER)) {
      return { status: "rejected", reason: "jetton-wallet transaction is not internal_transfer" };
    }
    const credited = parsed.in_msg.message_content?.body
      ? parseInternalTransferAmount(parsed.in_msg.message_content.body)
      : null;
    if (credited === null || credited !== n.amount) {
      return { status: "rejected", reason: "notification amount differs from credited amount" };
    }
    return {
      status: "final",
      transfers: [
        { ref, from: n.sender ?? "", to: owner, amount: Money.of(asset, n.amount), at, memo: n.comment },
      ],
    };
  }
}

function parseCursor(cursor: string | null): Cursor {
  if (!cursor) return {};
  const parsed: unknown = JSON.parse(cursor);
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid TON cursor");
  const out: Cursor = {};
  for (const [k, v] of Object.entries(parsed))
    if (typeof v === "number" && Number.isSafeInteger(v)) out[k] = v;
  return out;
}
