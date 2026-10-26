// SPDX-License-Identifier: Apache-2.0
// Ops adapters on recorded responses: alert sinks, USDT/USD sources, second sources (Tronscan, tonapi), AML blocklist.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Alert } from "../application/ports.ts";
import { defineAsset } from "../domain/asset.ts";
import { chainAddress } from "../domain/chain-address.ts";
import { networkId } from "../domain/network.ts";
import { AlertRouter, TelegramAlertSink } from "./alerts/sinks.ts";
import { BlocklistAmlScreener } from "./aml/blocklist.ts";
import { friendlyTon, parseTonAddress } from "./chains/ton/address.ts";
import { TonapiSource } from "./chains/ton/tonapi.ts";
import { parseTronAddress } from "./chains/tron/address.ts";
import { TronscanSource } from "./chains/tron/tronscan.ts";
import { type FetchFn, JsonHttpClient } from "./http/json-client.ts";
import { CoinbaseUsdtUsd, KrakenUsdtUsd } from "./pricing/peg-sources.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const client = (json: unknown, calls: URL[] = []) => {
  const fetch: FetchFn = async (url) => {
    calls.push(new URL(url));
    return new Response(JSON.stringify(json), { status: 200 });
  };
  return new JsonHttpClient({
    baseUrl: "https://example.org",
    timeoutMs: 1_000,
    maxResponseBytes: 1_000_000,
    fetch,
    sleep: async () => {},
  });
};

describe("alerts", () => {
  it("drops repeats of the same key within the cooldown; one failing sink does not stop others", async () => {
    let t = 0;
    const got: Alert[] = [];
    const failures: unknown[] = [];
    const router = new AlertRouter(
      [{ send: async (a) => void got.push(a) }, { send: async () => Promise.reject(new Error("down")) }],
      30_000,
      (e) => failures.push(e),
      () => t,
    );
    const a: Alert = { key: "k", severity: "warning", message: "m" };
    await router.send(a);
    await router.send(a);
    t = 31_000;
    await router.send(a);
    expect(got).toHaveLength(2);
    expect(failures).toHaveLength(2);
  });

  it("forgets keys whose cooldown has passed, so the map does not grow with uptime", async () => {
    let t = 0;
    const router = new AlertRouter(
      [{ send: async () => {} }],
      30_000,
      () => {},
      () => t,
    );
    for (let i = 0; i < 100; i++) {
      await router.send({ key: `never-final:tron/tx${i}`, severity: "warning", message: "m" });
    }
    expect(router.tracked).toBe(100);
    t = 30_000;
    await router.send({ key: "scanner-lag:tron", severity: "critical", message: "m" });
    expect(router.tracked).toBe(1);
  });

  it("telegram: send-only call, and errors never contain the bot token", async () => {
    const token = `123456:${"A".repeat(35)}`;
    const calls: Array<{ url: string; body: string }> = [];
    const sink = new TelegramAlertSink({
      token,
      chatId: "-100123",
      timeoutMs: 1_000,
      fetch: async (url, init) => {
        calls.push({ url, body: String(init.body) });
        return new Response("{}", { status: 401 });
      },
    });
    const err = await sink
      .send({ key: "k", severity: "critical", message: "scanner down" })
      .catch((e: unknown) => e);
    expect(calls[0]?.url.endsWith("/sendMessage")).toBe(true);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ chat_id: "-100123" });
    expect(String(err)).toBe("Error: telegram: HTTP 401");
    expect(String(err)).not.toContain(token);
  });
});

describe("USDT/USD sources (recorded)", () => {
  it("Kraken and Coinbase", async () => {
    const k = await new KrakenUsdtUsd(client(read("./pricing/fixtures/kraken-usdtusd.json"))).price();
    const c = await new CoinbaseUsdtUsd(client(read("./pricing/fixtures/coinbase-usdt-usd.json"))).price();
    for (const p of [k, c]) expect(Number(p.num) / Number(p.den)).toBeGreaterThan(0.99);
  });

  it("an unexpected answer is an error, not a price", async () => {
    await expect(
      new KrakenUsdtUsd(client({ error: ["EQuery:Unknown asset pair"], result: {} })).price(),
    ).rejects.toThrow();
  });
});

describe("second sources (recorded)", () => {
  it("Tronscan: incoming transfers of the contract to the address, successful only", async () => {
    const NILE = networkId("tron:nile");
    const asset = defineAsset({
      id: "usdt-nile",
      network: NILE,
      kind: "token",
      contract: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
      decimals: 6,
      symbol: "USDT",
    });
    const to = chainAddress(NILE, "TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq");
    const fx = read("./chains/tron/fixtures/nile-tronscan-transfers.json");
    fx.token_transfers.push({
      ...fx.token_transfers[0],
      transaction_id: "f".repeat(64),
      finalResult: "FAILED",
    });
    fx.token_transfers.push({
      ...fx.token_transfers[0],
      transaction_id: "e".repeat(64),
      contract_address: "TFakeToken",
    });
    const calls: URL[] = [];
    const list = await new TronscanSource(NILE, client(fx, calls)).incoming(
      asset,
      to,
      [],
      new Date(1792970000000),
    );
    expect(calls[0]?.pathname).toBe("/api/new/token_trc20/transfers");
    expect(calls[0]?.searchParams.get("toAddress")).toBe(to.value);
    expect(list.map((c) => [c.txHash.slice(0, 10), c.amount.units])).toEqual([
      ["a010a24cf5", 15_000_000n],
      ["364157c883", 2_000_000_000n],
      ["320a48d17d", 1_000_000n],
    ]);
  });

  it("tonapi: internal_transfer on our jetton-wallet with amount and memo; plain GRAM transfers", async () => {
    const TESTNET = networkId("ton:testnet");
    const owner = chainAddress(TESTNET, "0:326bcaf1f252ca9e3458fe73348566afe805f7c5b40339277260bcb2fc8762b0");
    const jw = chainAddress(TESTNET, "0:58594ddbf5aae9eff2baf115da69590be38e07e89e79768915fda3089c190f6b");
    const usdt = defineAsset({
      id: "usdt",
      network: TESTNET,
      kind: "token",
      contract: "0:f418a04cf196ebc959366844a6cdf53a6fd6fff1eadafc892f05210bba31593e",
      decimals: 6,
      symbol: "USDT",
    });
    const gram = defineAsset({
      id: "gram",
      network: TESTNET,
      kind: "native",
      contract: null,
      decimals: 9,
      symbol: "GRAM",
    });
    const fx = read("./chains/ton/fixtures/testnet-tonapi-transactions.json");
    const receiving = [{ address: owner, status: "active" as const, tokenAccount: jw }];
    // Jettons: internal_transfer on OUR jetton-wallet (found even without a notification to the owner).
    const calls: URL[] = [];
    const jwFx = read("./chains/ton/fixtures/testnet-tonapi-jetton-wallet-transactions.json");
    const jettons = await new TonapiSource(TESTNET, client(jwFx, calls)).incoming(
      usdt,
      owner,
      receiving,
      new Date(1792965900 * 1000),
    );
    expect(calls[0]?.pathname).toBe(`/v2/blockchain/accounts/${jw.value}/transactions`);
    expect(jettons[0]).toMatchObject({ memo: "2473565594", to: owner });
    expect(jettons[0]?.amount.units).toBe(1_009_774n);
    expect(jettons[0]?.from).toBe("0:06dceffaa6fac2a300f40b1afb7814351ab8e13241b5e99f63aa4c2d6f5985f4");
    expect(jettons[0]?.txHash).toBe("9bbb6e27fb677d746f0df613b9a86a41ae94874498ce831badb4758aefd8765e");
    expect(jettons.length).toBe(8); // outgoing jetton_transfer messages are skipped
    const native = await new TonapiSource(TESTNET, client(fx)).incoming(
      gram,
      owner,
      receiving,
      new Date(1792965900 * 1000),
    );
    expect(native.map((c) => c.amount.units)).toEqual([6035n, 7511n, 7511n, expect.any(BigInt)]);
    // without a pinned jetton-wallet nothing can be attributed to the jetton
    expect(await new TonapiSource(TESTNET, client(fx)).incoming(usdt, owner, [], new Date(0))).toEqual([]);
  });
});

describe("AML blocklist", () => {
  it("holds senders on the list (bare or network-prefixed), ignores comments", async () => {
    const s = new BlocklistAmlScreener(
      [
        "# sanctions",
        "TBad111111111111111111111111111111",
        "tron:mainnet:TBad2222222222222222222222222222222  # note",
        "",
      ],
      (_network, raw) => raw,
    );
    expect(s.size).toBe(2);
    const input = (from: string) => ({
      network: networkId("tron:mainnet"),
      from,
      txRef: { network: networkId("tron:mainnet"), txHash: "a".repeat(64), index: 0n },
      amount: undefined as never,
    });
    expect((await s.screen(input("TBad111111111111111111111111111111"))).verdict).toBe("hold");
    expect((await s.screen(input("TBad2222222222222222222222222222222"))).verdict).toBe("hold");
    expect((await s.screen(input("TGood11111111111111111111111111111"))).verdict).toBe("clear");
  });

  it("normalises entries with the network's address parser: a TON address in friendly form matches the raw form the chain reports", async () => {
    const OWNER = "0:326bcaf1f252ca9e3458fe73348566afe805f7c5b40339277260bcb2fc8762b0";
    const TRON_ADDR = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
    const normalise = (network: string | null, raw: string): string => {
      if (network?.startsWith("ton:")) return parseTonAddress(raw);
      if (network?.startsWith("tron:")) return parseTronAddress(raw);
      try {
        return parseTronAddress(raw);
      } catch {
        return parseTonAddress(raw);
      }
    };
    const s = new BlocklistAmlScreener(
      [friendlyTon(OWNER, false), `ton:mainnet:${friendlyTon(OWNER, true)}`, TRON_ADDR],
      normalise,
    );
    const input = (network: string, from: string) => ({
      network: networkId(network),
      from,
      txRef: { network: networkId(network), txHash: "a".repeat(64), index: 0n },
      amount: undefined as never,
    });
    expect((await s.screen(input("ton:mainnet", OWNER))).verdict).toBe("hold");
    expect((await s.screen(input("ton:testnet", OWNER))).verdict).toBe("hold"); // bare entry: any network
    expect((await s.screen(input("tron:mainnet", TRON_ADDR))).verdict).toBe("hold");
    expect((await s.screen(input("tron:mainnet", TRON_ADDR.toLowerCase()))).verdict).toBe("clear"); // base58 is case-sensitive
    // an entry that is no address at all is a start-up error, not a silently useless line
    expect(() => new BlocklistAmlScreener(["not-an-address"], normalise)).toThrow(/line 1/);
  });
});
