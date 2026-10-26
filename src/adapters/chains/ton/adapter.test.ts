// SPDX-License-Identifier: Apache-2.0
// Contract tests for the TON adapter on recorded testnet responses (see fixtures/README.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beginCell } from "@ton/core";
import { describe, expect, it } from "vitest";
import type { TransferCandidate } from "../../../application/ports.ts";
import { defineAsset } from "../../../domain/asset.ts";
import { chainAddress } from "../../../domain/chain-address.ts";
import { Money } from "../../../domain/money.ts";
import { networkId } from "../../../domain/network.ts";
import { type FetchFn, JsonHttpClient } from "../../http/json-client.ts";
import { TonAdapter } from "./adapter.ts";
import { friendlyTon, parseTonAddress } from "./address.ts";
import { parseInternalTransfer, parsePlainComment } from "./payload.ts";

// biome-ignore lint/suspicious/noExplicitAny: recorded fixtures are free-form JSON that tests mutate
type Json = Record<string, any>;
const fixture = (name: string): Json =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

const TESTNET = networkId("ton:testnet");
const MASTER = "0:f418a04cf196ebc959366844a6cdf53a6fd6fff1eadafc892f05210bba31593e";
const OWNER = "0:326bcaf1f252ca9e3458fe73348566afe805f7c5b40339277260bcb2fc8762b0";
const JETTON_WALLET = "0:58594ddbf5aae9eff2baf115da69590be38e07e89e79768915fda3089c190f6b";
const SENDER = "0:06dceffaa6fac2a300f40b1afb7814351ab8e13241b5e99f63aa4c2d6f5985f4";
const GRAM_OWNER = "0:b35713e641a7ae5b0a4c7ba1df1afa8dd34184fbd4e12313bee5c3e6820d20ed";
const USDT = defineAsset({
  id: "usdt-ton",
  network: TESTNET,
  kind: "token",
  contract: MASTER,
  decimals: 6,
  symbol: "USDT",
});
const GRAM = defineAsset({
  id: "gram",
  network: TESTNET,
  kind: "native",
  contract: null,
  decimals: 9,
  symbol: "GRAM",
});
const owner = chainAddress(TESTNET, OWNER);
const gramOwner = chainAddress(TESTNET, GRAM_OWNER);
const b64ToHex = (b: string) => Buffer.from(b, "base64").toString("hex");

interface Routes {
  tx?: (hash: string) => Json;
  list?: () => Json;
  getMethod?: () => Json;
}

function fake(routes: Routes) {
  const calls: URL[] = [];
  const fn: FetchFn = async (url) => {
    const u = new URL(url);
    calls.push(u);
    let body: Json = {};
    if (u.pathname === "/api/v3/transactions" && u.searchParams.get("hash"))
      body = routes.tx?.(u.searchParams.get("hash") ?? "") ?? { transactions: [] };
    else if (u.pathname === "/api/v3/transactions") body = routes.list?.() ?? { transactions: [] };
    else if (u.pathname === "/api/v3/runGetMethod") body = routes.getMethod?.() ?? {};
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fn, calls };
}

function adapter(fetch: FetchFn, jettonWallet = JETTON_WALLET) {
  const client = new JsonHttpClient({
    baseUrl: "https://testnet.toncenter.com",
    timeoutMs: 1_000,
    maxResponseBytes: 1_000_000,
    fetch,
    sleep: async () => {},
  });
  return new TonAdapter({
    network: TESTNET,
    client,
    startFrom: new Date(1792965900 * 1000),
    overlapMs: 600_000,
    jettonWallets: new Map([[USDT.id, new Map([[OWNER, jettonWallet]])]]),
  });
}

// The jetton-wallet transaction that processed internal_transfer (1.227528 USDT, comment 586935205).
const credit1 = () => structuredClone(fixture("testnet-jetton-wallet-credit-tx.json"));
const candidate: TransferCandidate = {
  network: TESTNET,
  txHash: b64ToHex("2zQiu6B4z7FomO7A/ZpJjxTD0L03JK3p/Cmk9yB6riE="),
  from: SENDER,
  to: owner,
  amount: Money.of(USDT, 1_227_528n),
  at: new Date(1792965972 * 1000),
  memo: "586935205",
};

/** internal_transfer body as a sender's jetton wallet builds it. */
function internalTransfer(amount: bigint, forwardTon: bigint, comment: string | null): string {
  const b = beginCell()
    .storeUint(0x178d4519, 32)
    .storeUint(0, 64)
    .storeCoins(amount)
    .storeAddress(null)
    .storeAddress(null)
    .storeCoins(forwardTon);
  if (comment === null) b.storeBit(0);
  else b.storeBit(1).storeRef(beginCell().storeUint(0, 32).storeStringTail(comment).endCell());
  return b.endCell().toBoc().toString("base64");
}

function verifyJetton(patch: (t: Json) => void = () => {}) {
  const tx = credit1();
  patch(tx.transactions[0]);
  const { fn, calls } = fake({ tx: () => tx });
  return { result: adapter(fn).verify(candidate, USDT, [owner]), calls };
}

describe("TON addresses and payloads", () => {
  it("normalises raw and friendly forms to canonical raw; basechain only", () => {
    const friendly = friendlyTon(OWNER, true);
    expect(friendly.startsWith("0Q") || friendly.startsWith("kQ")).toBe(true); // testnet, non-bounceable
    expect(parseTonAddress(friendly)).toBe(OWNER);
    expect(parseTonAddress(OWNER.toUpperCase().replace("0X", "0x"))).toBe(OWNER);
    expect(() => parseTonAddress(`-1:${"1".repeat(64)}`)).toThrow("basechain");
    expect(() => parseTonAddress("TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq")).toThrow();
  });

  it("parses the recorded internal_transfer: amount, sender, forward amount, comment", () => {
    const body = credit1().transactions[0].in_msg.message_content.body;
    expect(parseInternalTransfer(body)).toEqual({
      queryId: 0n,
      amount: 1_227_528n,
      from: SENDER,
      forwardTonAmount: 1n,
      comment: "586935205",
    });
  });

  it("reads comments inline or by reference, ignores binary comments and malformed bodies", () => {
    const comment = (text: string) => beginCell().storeUint(0, 32).storeStringTail(text).endCell();
    const transfer = (payload: (b: ReturnType<typeof beginCell>) => void) => {
      const b = beginCell()
        .storeUint(0x178d4519, 32)
        .storeUint(0, 64)
        .storeCoins(5n)
        .storeAddress(null)
        .storeAddress(null)
        .storeCoins(0n);
      payload(b);
      return b.endCell().toBoc().toString("base64");
    };
    expect(parseInternalTransfer(transfer((b) => b.storeBit(1).storeRef(comment("INV2345A"))))?.comment).toBe(
      "INV2345A",
    );
    expect(
      parseInternalTransfer(transfer((b) => b.storeBit(0).storeSlice(comment("INV2345A").beginParse())))
        ?.comment,
    ).toBe("INV2345A");
    expect(parseInternalTransfer(transfer((b) => b.storeBit(0).storeUint(0xff, 8)))?.comment).toBeNull();
    expect(parseInternalTransfer(transfer((b) => b.storeBit(0)))?.from).toBeNull();
    expect(parseInternalTransfer("not-a-boc")).toBeNull();
    expect(parsePlainComment(comment("hello").toBoc().toString("base64"))).toBe("hello");
    expect(parsePlainComment(null)).toBeNull();
    // TEP-74 binary comment: op 0 followed by the byte 0xff. UTF-8 decoding turns 0xff into U+FFFD, so the check
    // must look at the raw byte; the old test stored only 8 bits and never reached that branch.
    const binary = beginCell().storeUint(0, 32).storeUint(0xff, 8).storeUint(0xabcd, 16).endCell();
    expect(parsePlainComment(binary.toBoc().toString("base64"))).toBeNull();
    expect(parseInternalTransfer(transfer((b) => b.storeBit(1).storeRef(binary)))?.comment).toBeNull();
  });

  it("a comment with control characters is no comment: PostgreSQL refuses U+0000 and the row must still be written", () => {
    const comment = (text: string) => beginCell().storeUint(0, 32).storeStringTail(text).endCell();
    const b64 = (c: ReturnType<typeof comment>) => c.toBoc().toString("base64");
    expect(parsePlainComment(b64(comment("A\u0000B")))).toBeNull();
    expect(parsePlainComment(b64(comment("\u0000")))).toBeNull();
    expect(parsePlainComment(b64(comment("INV\u001b[31m")))).toBeNull();
    expect(parsePlainComment(b64(comment("bad � utf8")))).toBeNull();
    // Ordinary whitespace is text.
    expect(parsePlainComment(b64(comment("line one\nline two\ttab\r\n")))).toBe(
      "line one\nline two\ttab\r\n",
    );
    // The same filter applies to a jetton forward payload (inline and by reference).
    const transfer = (payload: (b: ReturnType<typeof beginCell>) => void) => {
      const b = beginCell()
        .storeUint(0x178d4519, 32)
        .storeUint(0, 64)
        .storeCoins(5n)
        .storeAddress(null)
        .storeAddress(null)
        .storeCoins(0n);
      payload(b);
      return b.endCell().toBoc().toString("base64");
    };
    const withNul = comment("INV\u00002345");
    expect(parseInternalTransfer(transfer((b) => b.storeBit(1).storeRef(withNul)))?.comment).toBeNull();
    expect(
      parseInternalTransfer(transfer((b) => b.storeBit(0).storeSlice(withNul.beginParse())))?.comment,
    ).toBeNull();
    expect(parseInternalTransfer(transfer((b) => b.storeBit(1).storeRef(withNul)))?.amount).toBe(5n);
  });
});

describe("jetton-wallet binding", () => {
  it("accepts the pinned jetton-wallet returned by get_wallet_address on the pinned master", async () => {
    const { fn, calls } = fake({ getMethod: () => fixture("testnet-get-wallet-address.json") });
    expect(await adapter(fn).checkJettonWallets([USDT])).toEqual([]);
    expect(calls[0]?.pathname).toBe("/api/v3/runGetMethod");
  });

  it("reports a fake jetton-wallet in config", async () => {
    const { fn } = fake({ getMethod: () => fixture("testnet-get-wallet-address.json") });
    const problems = await adapter(fn, `0:${"ab".repeat(32)}`).checkJettonWallets([USDT]);
    expect(problems).toHaveLength(1);
  });
});

describe("fetchIncoming (indexer candidates)", () => {
  it("jetton: internal_transfer on our jetton-wallet, with amount, sender and memo hints", async () => {
    const { fn, calls } = fake({ list: () => fixture("testnet-jetton-wallet-transactions.json") });
    const res = await adapter(fn).fetchIncoming(USDT, [owner], null, 50);
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toMatchObject({
      account: JETTON_WALLET,
      sort: "asc",
      start_utime: "1792965900",
    });
    expect(res.candidates.map((c) => [c.amount.units, c.memo, c.from, c.to.value])).toEqual([
      [1_227_528n, "586935205", SENDER, OWNER],
      [expect.any(BigInt), expect.any(String), SENDER, OWNER],
    ]);
    expect(res.candidates[0]?.txHash).toBe(candidate.txHash);
    expect(JSON.parse(res.next)).toEqual({ [JETTON_WALLET]: 1792966132 });
  });

  it("jetton: a payment sent with forward_ton_amount = 0 (no notification to the owner) is still found", async () => {
    const list = structuredClone(fixture("testnet-jetton-wallet-transactions.json"));
    const t = list.transactions[0];
    t.in_msg.message_content.body = internalTransfer(6_100_000n, 0n, null);
    t.out_msgs = t.out_msgs.filter((m: Json) => m.opcode !== "0x7362d09c");
    const res = await adapter(fake({ list: () => list }).fn).fetchIncoming(USDT, [owner], null, 50);
    expect(res.candidates[0]).toMatchObject({ memo: null, to: owner });
    expect(res.candidates[0]?.amount.units).toBe(6_100_000n);
  });

  it("jetton: resumes from a 0.1.0 owner cursor instead of rescanning from startFrom", async () => {
    const { fn, calls } = fake({ list: () => ({ transactions: [] }) });
    const res = await adapter(fn).fetchIncoming(USDT, [owner], JSON.stringify({ [OWNER]: 1792970000 }), 50);
    expect(calls[0]?.searchParams.get("account")).toBe(JETTON_WALLET);
    expect(calls[0]?.searchParams.get("start_utime")).toBe(String(1792970000 - 600));
    expect(JSON.parse(res.next)).toEqual({});
  });

  it("native: plain transfers with their exact (dust) amounts; jetton notifications are not GRAM", async () => {
    const { fn } = fake({ list: () => fixture("testnet-owner-transactions.json") });
    const res = await adapter(fn).fetchIncoming(GRAM, [owner], null, 50);
    expect(res.candidates.map((c) => c.amount.units)).toEqual([6035n, 7511n, 7511n]);
  });

  it("other messages to the jetton-wallet (outgoing transfer, excesses) are not candidates", async () => {
    const list = structuredClone(fixture("testnet-jetton-wallet-transactions.json"));
    list.transactions[0].in_msg.opcode = "0x0f8a7ea5";
    list.transactions[1].in_msg.opcode = "0xd53276db";
    const res = await adapter(fake({ list: () => list }).fn).fetchIncoming(USDT, [owner], null, 50);
    expect(res.candidates).toEqual([]);
  });

  it("without a pinned jetton-wallet the owner is not scanned for the jetton", async () => {
    const { fn, calls } = fake({ list: () => fixture("testnet-jetton-wallet-transactions.json") });
    const a = new TonAdapter({
      network: TESTNET,
      client: new JsonHttpClient({
        baseUrl: "https://x",
        timeoutMs: 1_000,
        maxResponseBytes: 1_000_000,
        fetch: fn,
      }),
      startFrom: new Date(0),
      overlapMs: 0,
      jettonWallets: new Map(),
    });
    expect((await a.fetchIncoming(USDT, [owner], null, 50)).candidates).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("re-reads an overlap window from the cursor (duplicates are dropped by the database)", async () => {
    const { fn, calls } = fake({ list: () => ({ transactions: [] }) });
    const a = adapter(fn);
    await a.fetchIncoming(USDT, [owner], JSON.stringify({ [JETTON_WALLET]: 1792970000 }), 50);
    expect(calls[0]?.searchParams.get("start_utime")).toBe(String(1792970000 - 600));
    await a.fetchIncoming(USDT, [owner], JSON.stringify({ [JETTON_WALLET]: 1792966000 }), 50);
    expect(calls[1]?.searchParams.get("start_utime")).toBe("1792965900"); // never before startFrom
  });
});

describe("verify jetton (finalized truth)", () => {
  it("final: recorded payment — amount, sender, memo, lt as index, block time; one query by hash", async () => {
    const { result, calls } = verifyJetton();
    const r = await result;
    expect(r.status).toBe("final");
    if (r.status !== "final") return;
    expect(r.transfers).toHaveLength(1);
    const t = r.transfers[0];
    expect(t?.ref.index).toBe(105448048000009n);
    expect(t?.amount.units).toBe(1_227_528n);
    expect(t?.from).toBe(SENDER);
    expect(t?.to).toEqual(owner);
    expect(t?.memo).toBe("586935205");
    expect(t?.at.getTime()).toBe(1792965972 * 1000);
    expect(calls.map((c) => c.pathname)).toEqual(["/api/v3/transactions"]);
  });

  it("forward_ton_amount = 0: credited without any notification to the owner", async () => {
    const r = await verifyJetton((t) => {
      t.in_msg.message_content.body = internalTransfer(6_100_000n, 0n, null);
      t.out_msgs = t.out_msgs.filter((m: Json) => m.opcode !== "0x7362d09c");
    }).result;
    expect(r.status === "final" && r.transfers.map((x) => [x.amount.units, x.memo])).toEqual([
      [6_100_000n, null],
    ]);
  });

  it("non-final or emulated: pending, never credited", async () => {
    expect((await verifyJetton((t) => (t.finality = "confirmed")).result).status).toBe("pending");
    expect((await verifyJetton((t) => (t.emulated = true)).result).status).toBe("pending");
    expect((await verifyJetton((t) => (t.mc_block_seqno = null)).result).status).toBe("pending");
  });

  it("fake jetton-wallet / fake master: a transaction on any other jetton-wallet is rejected", async () => {
    const r = await verifyJetton((t) => (t.account = `0:${"CD".repeat(32)}`)).result;
    expect(r).toEqual({ status: "rejected", reason: "transaction is not on a pinned jetton-wallet" });
  });

  it("forged internal_transfer: the jetton-wallet code refuses it, the failed transaction is rejected", async () => {
    for (const patch of [
      (t: Json) => (t.description.aborted = true),
      (t: Json) => (t.description.compute_ph.success = false),
      (t: Json) => (t.description.action.success = false),
      (t: Json) => (t.description.action = null),
    ]) {
      expect(await verifyJetton(patch).result).toEqual({
        status: "rejected",
        reason: "jetton-wallet transaction failed",
      });
    }
  });

  it("the amount is read from the internal_transfer the jetton-wallet processed", async () => {
    const r = await verifyJetton((t) => (t.in_msg.message_content.body = internalTransfer(7n, 1n, "X")))
      .result;
    expect(r.status === "final" && r.transfers[0]?.amount.units).toBe(7n);
    expect(
      await verifyJetton((t) => (t.in_msg.message_content.body = internalTransfer(0n, 1n, null))).result,
    ).toEqual({ status: "final", transfers: [] });
    expect(await verifyJetton((t) => (t.in_msg.message_content.body = "not-a-boc")).result).toEqual({
      status: "rejected",
      reason: "malformed internal_transfer",
    });
  });

  it("bounced inbound message is rejected", async () => {
    expect((await verifyJetton((t) => (t.in_msg.bounced = true)).result).status).toBe("rejected");
  });

  it("other messages to the jetton-wallet credit nothing", async () => {
    for (const op of ["0x0f8a7ea5", "0xd53276db", "0x7362d09c", "0x00000000"]) {
      expect(await verifyJetton((t) => (t.in_msg.opcode = op)).result).toEqual({
        status: "final",
        transfers: [],
      });
    }
  });

  it("a transaction that is not indexed yet keeps the candidate pending", async () => {
    const r = await adapter(fake({ tx: () => ({ transactions: [] }) }).fn).verify(candidate, USDT, [owner]);
    expect(r.status).toBe("pending");
  });
});

describe("verify GRAM (native coin)", () => {
  const gramCandidate: TransferCandidate = {
    network: TESTNET,
    txHash: b64ToHex("luY1ZQh6MaZWwzUzsgvTz811uv94QZiRcgGAr811ryk="),
    from: "x",
    to: gramOwner,
    amount: Money.of(GRAM, 1n),
    at: new Date(0),
    memo: null,
  };
  const verifyGram = (patch: (t: Json) => void = () => {}) => {
    const tx = structuredClone(fixture("testnet-gram-transfer-tx.json"));
    patch(tx.transactions[0]);
    return adapter(fake({ tx: () => tx }).fn).verify(gramCandidate, GRAM, [gramOwner]);
  };

  it("final: credited amount from the credit phase and the comment", async () => {
    const r = await verifyGram();
    expect(r.status === "final" && r.transfers[0]?.amount.units).toBe(484_836_197n);
    const withMemo = await verifyGram(
      (t) =>
        (t.in_msg.message_content.body = beginCell()
          .storeUint(0, 32)
          .storeStringTail("AB2C3D4E")
          .endCell()
          .toBoc()
          .toString("base64")),
    );
    expect(withMemo.status === "final" && withMemo.transfers[0]?.memo).toBe("AB2C3D4E");
  });

  it("the credited amount wins over the message value (indexer hint)", async () => {
    const r = await verifyGram((t) => (t.in_msg.value = "999999999999"));
    expect(r.status === "final" && r.transfers[0]?.amount.units).toBe(484_836_197n);
  });

  it("bounced or returned funds are rejected", async () => {
    expect((await verifyGram((t) => (t.in_msg.bounced = true))).status).toBe("rejected");
    expect((await verifyGram((t) => t.out_msgs.push({ ...t.in_msg }))).status).toBe("rejected");
  });

  it("non-final: pending", async () => {
    expect((await verifyGram((t) => (t.finality = "pending"))).status).toBe("pending");
  });
});

describe("display form", () => {
  it("shows payers the user-friendly non-bounceable testnet address", () => {
    const shown = adapter(fake({}).fn).formatAddress(owner);
    expect(shown).toBe(friendlyTon(OWNER, true));
    expect(parseTonAddress(shown)).toBe(OWNER);
  });
});

describe("payment URI", () => {
  it("ton://transfer with jetton master, amount in minimal units and memo", () => {
    const uri = adapter(fake({}).fn).buildPaymentUri({
      address: owner,
      amount: Money.of(USDT, 1_010_000n),
      memo: "AB2C3D4E",
    });
    const u = new URL(uri ?? "");
    expect(u.protocol).toBe("ton:");
    expect(u.searchParams.get("amount")).toBe("1010000");
    expect(u.searchParams.get("text")).toBe("AB2C3D4E");
    expect(parseTonAddress(u.searchParams.get("jetton") ?? "")).toBe(MASTER);
  });
});
