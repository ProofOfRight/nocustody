// SPDX-License-Identifier: Apache-2.0
// TON chain adapter: USDT (and other) jettons and the native coin GRAM, one wallet per merchant, invoice by memo.
//  - candidates: transactions from toncenter v3 (indexer; untrusted hint). GRAM: the receiving wallet's own
//    transactions. Jettons: the transactions of OUR jetton-wallet (pinned, checked with get_wallet_address at startup)
//    that process internal_transfer. The owner's transfer_notification is not used: the jetton wallet sends it only
//    when the payer sets forward_ton_amount > 0 (TEP-74), so a payment without it would be missed.
//  - truth: the same transaction re-read by hash must be finalized (masterchain) and not emulated.
//    Jettons: it must be on our pinned jetton-wallet, process internal_transfer and succeed (compute and action).
//    The standard jetton-wallet code accepts internal_transfer only from the master or from a wallet of the same
//    master, so a forged one fails there. Amount, sender and memo come from the internal_transfer body.
//    GRAM: no outgoing messages (no bounce); the amount is what the credit phase credited.
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
import { parseTimeCursor, type TimeCursor } from "../cursor.ts";
import { canonicalTon, friendlyTon, parseTonAddress } from "./address.ts";
import {
  OP_ENCRYPTED_COMMENT,
  OP_INTERNAL_TRANSFER,
  OP_TEXT_COMMENT,
  parseInternalTransfer,
  parsePlainComment,
} from "./payload.ts";
import { isFinalized, runGetMethodSchema, type TonTransaction, tonTransactionsSchema } from "./schemas.ts";

export interface TonAdapterOptions {
  readonly network: NetworkId;
  readonly client: JsonHttpClient;
  readonly startFrom: Date;
  readonly overlapMs: number;
  /** Pinned jetton-wallet per (asset id, owner raw address). */
  readonly jettonWallets: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly maxPagesPerAddress?: number;
}

type Cursor = TimeCursor; // scanned account (wallet or jetton-wallet) → last seen utime (seconds)

const opcode = (n: number) => `0x${n.toString(16).padStart(8, "0")}`;
/**
 * A coin transfer a payer made: no body, a text comment, or an encrypted comment (wallets offer "encrypt comment";
 * the gateway cannot read it, so the payment is matched by its amount or ends as transfer.unmatched, never lost).
 * Any other op is a contract message (jetton notification, excess, …) and is not GRAM paid to us.
 */
const isPlainTransfer = (op: string | null): boolean =>
  op === null || op === opcode(OP_TEXT_COMMENT) || op === opcode(OP_ENCRYPTED_COMMENT);
/** The memo of a plain transfer; an encrypted comment is unreadable, so the payment carries none. */
const plainMemo = (op: string | null, body: string | null | undefined): string | null =>
  op === opcode(OP_ENCRYPTED_COMMENT) ? null : parsePlainComment(body);
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
    const state = parseTimeCursor(cursor, "TON");
    const next: Cursor = { ...state };
    const out: TransferCandidate[] = [];
    const pageSize = Math.min(256, Math.max(1, limit));
    for (const owner of addresses) {
      const token = asset.kind === "token";
      const account = token ? this.#jettonWallet(asset, owner.value) : owner.value;
      if (!account) continue;
      // 0.1.0 scanned jetton assets on the owner's wallet: resume from that cursor rather than from startFrom.
      const seen = state[account] ?? (token ? state[owner.value] : undefined) ?? 0;
      if (token) delete next[owner.value];
      const fromUtime = Math.max(
        Math.floor(this.#o.startFrom.getTime() / 1000),
        seen - Math.ceil(this.#o.overlapMs / 1000),
      );
      for (let page = 0; page < (this.#o.maxPagesPerAddress ?? 10); page++) {
        const res = await this.#o.client.get(
          "/api/v3/transactions",
          {
            account,
            start_utime: String(fromUtime),
            sort: "asc",
            limit: String(pageSize),
            offset: String(page * pageSize),
          },
          tonTransactionsSchema,
        );
        for (const t of res.transactions) {
          next[account] = Math.max(next[account] ?? 0, t.now);
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
      if (m.opcode !== opcode(OP_INTERNAL_TRANSFER)) return null;
      const it = m.message_content?.body ? parseInternalTransfer(m.message_content.body) : null;
      if (!it || it.amount <= 0n) return null;
      return { ...base, from: it.from ?? "", amount: Money.of(asset, it.amount), memo: it.comment };
    }
    if (!isPlainTransfer(m.opcode)) return null;
    const value = BigInt(m.value ?? "0");
    if (value <= 0n) return null;
    return {
      ...base,
      from: canonicalTon(m.source),
      amount: Money.of(asset, value),
      memo: plainMemo(m.opcode, m.message_content?.body),
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
      return { status: "pending", reason: "provider answered about another transaction" }; // provider fault
    if (!isFinalized(t))
      return { status: "pending", reason: `not finalized (finality ${t.finality ?? "unknown"})` };
    const ref = txRef(this.network, c.txHash, BigInt(t.lt));
    const at = new Date(t.now * 1000);
    if (asset.kind === "token") return this.#verifyJetton(asset, receiving, t, ref, at);

    const owner = receiving.find((a) => a.value === canonicalTon(t.account));
    if (!owner) return { status: "rejected", reason: "transaction is not on a watched wallet" };
    const m = t.in_msg;
    if (!m?.source) return { status: "rejected", reason: "no internal inbound message" };
    if (m.bounced) return { status: "rejected", reason: "inbound message is a bounce" };
    if (t.out_msgs.length !== 0)
      return { status: "rejected", reason: "wallet sent messages back (bounce or reply)" };

    // Native coin: what the credit phase actually credited.
    if (!isPlainTransfer(m.opcode)) return { status: "final", transfers: [] };
    if (t.description.destroyed) return { status: "rejected", reason: "account destroyed" };
    const credited = BigInt(t.description.credit_ph?.credit ?? "0");
    if (credited <= 0n) return { status: "rejected", reason: "nothing credited" };
    const transfer: VerifiedTransfer = {
      ref,
      from: canonicalTon(m.source),
      to: owner,
      amount: Money.of(asset, credited),
      at,
      memo: plainMemo(m.opcode, m.message_content?.body),
    };
    return { status: "final", transfers: [transfer] };
  }

  async #verifyJetton(
    asset: Asset,
    receiving: readonly ChainAddress[],
    t: TonTransaction,
    ref: VerifiedTransfer["ref"],
    at: Date,
  ): Promise<VerificationResult> {
    // The asset is identified by OUR jetton-wallet of the pinned master — never by the indexer's jetton_master or metadata.
    const account = canonicalTon(t.account);
    const owner = receiving.find((a) => this.#jettonWallet(asset, a.value) === account);
    if (!owner) return { status: "rejected", reason: "transaction is not on a pinned jetton-wallet" };
    const m = t.in_msg;
    if (!m?.source) return { status: "rejected", reason: "no internal inbound message" };
    if (m.bounced) return { status: "rejected", reason: "inbound message is a bounce" };
    // Outgoing transfers, excesses and other messages to the jetton-wallet credit nothing.
    if (m.opcode !== opcode(OP_INTERNAL_TRANSFER)) return { status: "final", transfers: [] };
    const d = t.description;
    if (d.aborted || d.compute_ph.success !== true || d.action?.success !== true) {
      return { status: "rejected", reason: "jetton-wallet transaction failed" };
    }
    const it = m.message_content?.body ? parseInternalTransfer(m.message_content.body) : null;
    if (!it) return { status: "rejected", reason: "malformed internal_transfer" };
    if (it.amount <= 0n) return { status: "final", transfers: [] };
    return {
      status: "final",
      transfers: [
        { ref, from: it.from ?? "", to: owner, amount: Money.of(asset, it.amount), at, memo: it.comment },
      ],
    };
  }
}
