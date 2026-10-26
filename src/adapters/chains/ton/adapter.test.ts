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
import { parsePlainComment, parseTransferNotification } from "./payload.ts";

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
  parent?: () => Json;
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
    else if (u.pathname === "/api/v3/transactionsByMessage") body = routes.parent?.() ?? { transactions: [] };
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

const notif1 = () => structuredClone(fixture("testnet-notification-1-tx.json"));
const parent1 = () => structuredClone(fixture("testnet-notification-1-jetton-wallet-tx.json"));
const candidate: TransferCandidate = {
  network: TESTNET,
  txHash: b64ToHex("abqMy1QtE6azS+MTURibE1gQiK547HIFMlk7+KEed+4="),
  from: SENDER,
  to: owner,
  amount: Money.of(USDT, 1_227_528n),
  at: new Date(1792965972 * 1000),
  memo: "586935205",
};

function verifyJetton(patchTx: (t: Json) => void = () => {}, patchParent: (t: Json) => void = () => {}) {
  const tx = notif1();
  patchTx(tx.transactions[0]);
  const parent = parent1();
  patchParent(parent.transactions[0]);
  return adapter(fake({ tx: () => tx, parent: () => parent }).fn).verify(candidate, USDT, [owner]);
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

  it("parses the recorded transfer_notification: amount, sender, comment", () => {
    const body = notif1().transactions[0].in_msg.message_content.body;
    expect(parseTransferNotification(body)).toEqual({
      queryId: 0n,
      amount: 1_227_528n,
      sender: SENDER,
      comment: "586935205",
    });
  });

  it("reads comments inline or by reference, ignores binary comments and malformed bodies", () => {
    const comment = (text: string) => beginCell().storeUint(0, 32).storeStringTail(text).endCell();
    const notification = (payload: (b: ReturnType<typeof beginCell>) => void) => {
      const b = beginCell().storeUint(0x7362d09c, 32).storeUint(0, 64).storeCoins(5n).storeAddress(null);
      payload(b);
      return b.endCell().toBoc().toString("base64");
    };
    expect(
      parseTransferNotification(notification((b) => b.storeBit(1).storeRef(comment("INV2345A"))))?.comment,
    ).toBe("INV2345A");
    expect(
      parseTransferNotification(
        notification((b) => b.storeBit(0).storeSlice(comment("INV2345A").beginParse())),
      )?.comment,
    ).toBe("INV2345A");
    expect(
      parseTransferNotification(notification((b) => b.storeBit(0).storeUint(0xff, 8)))?.comment,
    ).toBeNull();
    expect(parseTransferNotification(notification((b) => b.storeBit(0)))?.sender).toBeNull();
    expect(parseTransferNotification("not-a-boc")).toBeNull();
    expect(parsePlainComment(comment("hello").toBoc().toString("base64"))).toBe("hello");
    expect(parsePlainComment(null)).toBeNull();
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
  it("jetton: only notifications from our jetton-wallet, with amount and memo hints", async () => {
    const { fn, calls } = fake({ list: () => fixture("testnet-owner-transactions.json") });
    const res = await adapter(fn).fetchIncoming(USDT, [owner], null, 50);
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toMatchObject({
      account: OWNER,
      sort: "asc",
      start_utime: "1792965900",
    });
    expect(res.candidates.map((c) => [c.amount.units, c.memo, c.from])).toEqual([
      [1_227_528n, "586935205", SENDER],
      [expect.any(BigInt), expect.any(String), SENDER],
    ]);
    expect(JSON.parse(res.next)).toEqual({ [OWNER]: 1792966158 });
  });

  it("native: plain transfers with their exact (dust) amounts; jetton notifications are not GRAM", async () => {
    const { fn } = fake({ list: () => fixture("testnet-owner-transactions.json") });
    const res = await adapter(fn).fetchIncoming(GRAM, [owner], null, 50);
    expect(res.candidates.map((c) => c.amount.units)).toEqual([6035n, 7511n, 7511n]);
  });

  it("a forged notification from a foreign jetton-wallet is not even a candidate", async () => {
    const list = structuredClone(fixture("testnet-owner-transactions.json"));
    for (const t of list.transactions)
      if (t.in_msg?.opcode === "0x7362d09c") t.in_msg.source = `0:${"cd".repeat(32)}`;
    const res = await adapter(fake({ list: () => list }).fn).fetchIncoming(USDT, [owner], null, 50);
    expect(res.candidates).toEqual([]);
  });

  it("re-reads an overlap window from the cursor (duplicates are dropped by the database)", async () => {
    const { fn, calls } = fake({ list: () => ({ transactions: [] }) });
    const a = adapter(fn);
    await a.fetchIncoming(USDT, [owner], JSON.stringify({ [OWNER]: 1792970000 }), 50);
    expect(calls[0]?.searchParams.get("start_utime")).toBe(String(1792970000 - 600));
    await a.fetchIncoming(USDT, [owner], JSON.stringify({ [OWNER]: 1792966000 }), 50);
    expect(calls[1]?.searchParams.get("start_utime")).toBe("1792965900"); // never before startFrom
  });
});

describe("verify jetton (finalized truth)", () => {
  it("final: recorded payment — amount, sender, memo, lt as index, block time", async () => {
    const r = await verifyJetton();
    expect(r.status).toBe("final");
    if (r.status !== "final") return;
    expect(r.transfers).toHaveLength(1);
    const t = r.transfers[0];
    expect(t?.ref.index).toBe(105448048000011n);
    expect(t?.amount.units).toBe(1_227_528n);
    expect(t?.from).toBe(SENDER);
    expect(t?.memo).toBe("586935205");
    expect(t?.at.getTime()).toBe(1792965972 * 1000);
  });

  it("the usual 'aborted' notification (no gas) is accepted; success is checked on the jetton-wallet", async () => {
    expect(notif1().transactions[0].description.aborted).toBe(true);
    expect((await verifyJetton()).status).toBe("final");
  });

  it("non-final or emulated: pending, never credited", async () => {
    expect((await verifyJetton((t) => (t.finality = "confirmed"))).status).toBe("pending");
    expect((await verifyJetton((t) => (t.emulated = true))).status).toBe("pending");
    expect(
      (
        await verifyJetton(
          () => {},
          (p) => (p.finality = "pending"),
        )
      ).status,
    ).toBe("pending");
  });

  it("fake jetton-wallet / fake master: a notification from another jetton-wallet is no transfer of the asset", async () => {
    const r = await verifyJetton((t) => (t.in_msg.source = `0:${"cd".repeat(32)}`));
    expect(r).toEqual({ status: "final", transfers: [] });
  });

  it("failed jetton-wallet transaction is rejected", async () => {
    expect(
      (
        await verifyJetton(
          () => {},
          (p) => (p.description.aborted = true),
        )
      ).status,
    ).toBe("rejected");
    expect(
      (
        await verifyJetton(
          () => {},
          (p) => (p.description.action.success = false),
        )
      ).status,
    ).toBe("rejected");
  });

  it("notification amount must equal the amount credited by internal_transfer", async () => {
    const forged = beginCell()
      .storeUint(0x7362d09c, 32)
      .storeUint(0, 64)
      .storeCoins(999_000_000n)
      .storeAddress(null)
      .storeBit(0)
      .endCell()
      .toBoc()
      .toString("base64");
    const r = await verifyJetton((t) => (t.in_msg.message_content.body = forged));
    expect(r).toEqual({ status: "rejected", reason: "notification amount differs from credited amount" });
  });

  it("bounce: outgoing messages from the wallet reject the payment", async () => {
    const r = await verifyJetton((t) =>
      t.out_msgs.push({ ...t.in_msg, source: OWNER, destination: JETTON_WALLET }),
    );
    expect(r.status).toBe("rejected");
  });

  it("wrong opcode or another wallet is not our transfer", async () => {
    expect(await verifyJetton((t) => (t.in_msg.opcode = "0x00000000"))).toEqual({
      status: "final",
      transfers: [],
    });
    expect((await verifyJetton((t) => (t.account = GRAM_OWNER))).status).toBe("rejected");
  });

  it("a parent transaction that is not indexed yet keeps the candidate pending", async () => {
    const r = await adapter(fake({ tx: () => notif1(), parent: () => ({ transactions: [] }) }).fn).verify(
      candidate,
      USDT,
      [owner],
    );
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
