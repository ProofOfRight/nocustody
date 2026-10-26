// SPDX-License-Identifier: Apache-2.0
// Contract tests for the TRON adapter on recorded Nile responses (see fixtures/README.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TransferCandidate } from "../../../application/ports.ts";
import { defineAsset } from "../../../domain/asset.ts";
import { chainAddress } from "../../../domain/chain-address.ts";
import { Money } from "../../../domain/money.ts";
import { networkId } from "../../../domain/network.ts";
import { type FetchFn, JsonHttpClient, ProviderError } from "../../http/json-client.ts";
import { TRANSFER_TOPIC, TronAdapter } from "./adapter.ts";
import { parseTronAddress, tronAddressFromHex, tronAddressToHex20 } from "./address.ts";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

const NILE = networkId("tron:nile");
const USDT_CONTRACT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const USDT_HEX = "eca9bc828a3005b9a3b909f2cc5c2a54794de05f";
const OURS = "TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq";
const OURS_HEX = "379346817bd5482778a4dfc059b2f98ce9d23c16";
const TX = "320a48d17dee9e25a1a56c48bd207b4dda550c2fb2e0c76e3e7b9f49fd70262c";
const USDT = defineAsset({
  id: "usdt-nile",
  network: NILE,
  kind: "token",
  contract: USDT_CONTRACT,
  decimals: 6,
  symbol: "USDT",
});
const ADDR = chainAddress(NILE, OURS);

interface Call {
  url: URL;
  init: RequestInit;
}

function fakeFetch(handler: (url: URL, body: unknown) => { status?: number; json?: unknown; text?: string }) {
  const calls: Call[] = [];
  const fn: FetchFn = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    const r = handler(u, init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  };
  return { fn, calls };
}

function adapter(fetch: FetchFn, extra: Partial<ConstructorParameters<typeof JsonHttpClient>[0]> = {}) {
  const client = new JsonHttpClient({
    baseUrl: "https://nile.trongrid.io",
    apiKeyHeader: "TRON-PRO-API-KEY",
    timeoutMs: 1_000,
    maxResponseBytes: 1_000_000,
    fetch,
    sleep: async () => {},
    ...extra,
  });
  return new TronAdapter({
    network: NILE,
    client,
    startFrom: new Date("2026-10-01T00:00:00Z"),
    overlapMs: 600_000,
  });
}

const candidate: TransferCandidate = {
  network: NILE,
  txHash: TX,
  from: "TSEFaG9p9vYyLT6oUspvgvWgUiCao2nzds",
  to: ADDR,
  amount: Money.of(USDT, 1_000_000n),
  at: new Date(1792970475000),
  memo: null,
};

/** The recorded receipt with modifications. */
function receipt(patch: (r: Record<string, unknown> & { log: Array<Record<string, unknown>> }) => void) {
  const r = structuredClone(fixture("nile-solid-txinfo.json")) as Record<string, unknown> & {
    log: Array<Record<string, unknown>>;
  };
  patch(r);
  return r;
}

const verifyWith = (json: unknown) => adapter(fakeFetch(() => ({ json })).fn).verify(candidate, USDT, [ADDR]);

const topic = (hex20: string) => `${"0".repeat(24)}${hex20}`;
const amountData = (units: bigint) => units.toString(16).padStart(64, "0");

describe("TRON addresses", () => {
  it("round-trips base58check and hex", () => {
    expect(tronAddressToHex20(OURS)).toBe(OURS_HEX);
    expect(tronAddressFromHex(OURS_HEX)).toBe(OURS);
    expect(tronAddressFromHex(`41${USDT_HEX}`)).toBe(USDT_CONTRACT);
    expect(tronAddressFromHex(topic(OURS_HEX))).toBe(OURS);
    expect(tronAddressToHex20("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(
      "a614f803b6fd780986a42c78ec9c7f77e6ded13c",
    );
  });

  it("rejects bad checksums, wrong prefixes and malformed input", () => {
    const tampered = `${OURS.slice(0, -1)}${OURS.endsWith("q") ? "r" : "q"}`;
    expect(() => parseTronAddress(tampered)).toThrow("checksum");
    expect(() => parseTronAddress("0x379346817bd5482778a4dfc059b2f98ce9d23c16")).toThrow();
    expect(() => parseTronAddress(`${OURS} `)).toThrow();
    expect(() => tronAddressFromHex(`ff${"1".repeat(22)}${OURS_HEX}`)).toThrow("padded");
  });
});

describe("fetchIncoming (indexer candidates)", () => {
  it("queries confirmed incoming transfers of the configured contract and parses the recording", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { ...fixture("nile-trc20-history.json"), meta: {} } }));
    const res = await adapter(fn).fetchIncoming(USDT, [ADDR], null, 50);
    const q = calls[0]?.url.searchParams;
    expect(calls[0]?.url.pathname).toBe(`/v1/accounts/${OURS}/transactions/trc20`);
    expect(Object.fromEntries(q ?? [])).toMatchObject({
      only_to: "true",
      only_confirmed: "true",
      contract_address: USDT_CONTRACT,
      order_by: "block_timestamp,asc",
      min_timestamp: String(new Date("2026-10-01T00:00:00Z").getTime()),
    });
    expect(res.candidates).toHaveLength(2);
    expect(res.candidates[0]).toMatchObject({ txHash: TX, from: "TSEFaG9p9vYyLT6oUspvgvWgUiCao2nzds" });
    expect(res.candidates[0]?.amount.units).toBe(1_000_000n);
    expect(JSON.parse(res.next)).toEqual({ [OURS]: 1792970475000 });
  });

  it("follows fingerprint pages with the same parameters and re-reads an overlap window from the cursor", async () => {
    const page1 = { ...fixture("nile-trc20-history.json"), meta: { fingerprint: "FP1" } };
    const { fn, calls } = fakeFetch((u) => ({
      json: u.searchParams.get("fingerprint") ? { success: true, data: [], meta: {} } : page1,
    }));
    const a = adapter(fn);
    const first = await a.fetchIncoming(USDT, [ADDR], null, 50);
    const p0 = Object.fromEntries(calls[0]?.url.searchParams ?? []);
    const p1 = Object.fromEntries(calls[1]?.url.searchParams ?? []);
    expect(p1).toEqual({ ...p0, fingerprint: "FP1" });
    await a.fetchIncoming(USDT, [ADDR], first.next, 50);
    expect(calls[2]?.url.searchParams.get("min_timestamp")).toBe(String(1792970475000 - 600_000));
  });

  it("drops rows of other tokens and de-duplicates rows of one transaction", async () => {
    const h = fixture("nile-trc20-history.json") as { data: Array<Record<string, unknown>> };
    const row = h.data[0] as Record<string, unknown>;
    const fake = {
      ...row,
      transaction_id: "f".repeat(64),
      token_info: { address: "TFakeUsdtFakeUsdtFakeUsdtFakeUsdt1" },
    };
    const json = { success: true, data: [row, row, fake], meta: {} };
    const res = await adapter(fakeFetch(() => ({ json })).fn).fetchIncoming(USDT, [ADDR], null, 50);
    expect(res.candidates.map((c) => c.txHash)).toEqual([TX]);
    // several transfers of one transaction to us: the hint carries the largest, so a dust row listed first cannot
    // make the whole transaction "dust" and hide the real payment (the verifier reads every log anyway)
    const dust = { ...row, value: "1" };
    const big = { ...row, value: "10010000" };
    const multi = { success: true, data: [dust, big, { ...row, value: "5" }], meta: {} };
    const r2 = await adapter(fakeFetch(() => ({ json: multi })).fn).fetchIncoming(USDT, [ADDR], null, 50);
    expect(r2.candidates.map((c) => [c.txHash, c.amount.units])).toEqual([[TX, 10_010_000n]]);
  });
});

describe("verify (solidified truth)", () => {
  it("final: the recorded SUCCESS receipt yields one transfer with its log index, sender and amount", async () => {
    const r = await verifyWith(fixture("nile-solid-txinfo.json"));
    expect(r.status).toBe("final");
    if (r.status !== "final") return;
    expect(r.transfers).toHaveLength(1);
    const t = r.transfers[0];
    expect(t?.ref).toEqual({ network: NILE, txHash: TX, index: 0n });
    expect(t?.from).toBe("TSEFaG9p9vYyLT6oUspvgvWgUiCao2nzds");
    expect(t?.to.value).toBe(OURS);
    expect(t?.amount.units).toBe(1_000_000n);
    expect(t?.at.getTime()).toBe(1792970475000); // block time: decides "late" vs "on time"
  });

  it("calls only the solidity endpoint", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: fixture("nile-solid-txinfo.json") }));
    await adapter(fn).verify(candidate, USDT, [ADDR]);
    expect(calls.map((c) => `${c.init.method} ${c.url.pathname}`)).toEqual([
      "POST /walletsolidity/gettransactioninfobyid",
    ]);
  });

  it("non-final: an empty answer from walletsolidity is pending, never credited", async () => {
    expect(await verifyWith({})).toEqual({ status: "pending", reason: "not solidified yet" });
  });

  it("failed transaction: receipt REVERT / OUT_OF_ENERGY or result FAILED is rejected", async () => {
    for (const result of ["REVERT", "OUT_OF_ENERGY"]) {
      const r = await verifyWith(receipt((x) => (x.receipt = { result })));
      expect(r).toEqual({ status: "rejected", reason: `receipt result ${result}` });
    }
    expect((await verifyWith(receipt((x) => (x.result = "FAILED")))).status).toBe("rejected");
    expect((await verifyWith(receipt((x) => (x.receipt = {})))).status).toBe("rejected");
  });

  it("fake token: a Transfer log from another contract is not a transfer of the asset", async () => {
    const r = await verifyWith(
      receipt((x) => {
        x.log = x.log.map((l) => ({ ...l, address: "a614f803b6fd780986a42c78ec9c7f77e6ded13d" }));
      }),
    );
    expect(r).toEqual({ status: "final", transfers: [] });
  });

  it("several transfers in one transaction: each log to us becomes a transfer with its own index", async () => {
    const stranger = "1111111111111111111111111111111111111111";
    const sender = "b25a663c1368f37a254b2fb258b2d4e75fb659c1";
    const transferLog = (to: string, units: bigint) => ({
      address: USDT_HEX,
      topics: [TRANSFER_TOPIC, topic(sender), topic(to)],
      data: amountData(units),
    });
    const approval = {
      address: USDT_HEX,
      topics: [
        "8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
        topic(sender),
        topic(OURS_HEX),
      ],
      data: amountData(5n),
    };
    const r = await verifyWith(
      receipt((x) => {
        x.log = [
          transferLog(OURS_HEX, 10_010_000n),
          transferLog(stranger, 7n),
          approval,
          transferLog(OURS_HEX, 10_020_000n),
        ];
      }),
    );
    expect(r.status).toBe("final");
    if (r.status !== "final") return;
    expect(r.transfers.map((t) => [t.ref.index, t.amount.units])).toEqual([
      [0n, 10_010_000n],
      [3n, 10_020_000n],
    ]);
  });

  it("dust: tiny transfers are reported with their exact amount (the application drops them)", async () => {
    const r = await verifyWith(receipt((x) => (x.log = x.log.map((l) => ({ ...l, data: amountData(1n) })))));
    expect(r.status === "final" && r.transfers[0]?.amount.units).toBe(1n);
  });

  it("an answer about another transaction is a provider fault (pending, retried), never a decision; malformed topics are ignored", async () => {
    expect((await verifyWith(receipt((x) => (x.id = "0".repeat(64))))).status).toBe("pending");
    const r = await verifyWith(
      receipt((x) => (x.log = x.log.map((l) => ({ ...l, topics: (l.topics as string[]).slice(0, 2) })))),
    );
    expect(r).toEqual({ status: "final", transfers: [] });
  });

  it("an unexpected response shape is a provider error, not a decision", async () => {
    await expect(verifyWith({ id: 42 })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("HTTP client", () => {
  it("accepts only https and never leaves the configured host", async () => {
    expect(
      () => new JsonHttpClient({ baseUrl: "http://nile.trongrid.io", timeoutMs: 1, maxResponseBytes: 1 }),
    ).toThrow("https");
    const { fn } = fakeFetch(() => ({ json: {} }));
    const client = new JsonHttpClient({
      baseUrl: "https://nile.trongrid.io",
      timeoutMs: 1_000,
      maxResponseBytes: 1_000,
      fetch: fn,
    });
    const { z } = await import("zod");
    await expect(client.get("https://evil.example/x", {}, z.object({}))).rejects.toThrow(
      "outside the configured provider",
    );
  });

  it("retries 429/5xx with backoff, does not retry 400, refuses redirects", async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() =>
      ++n < 3 ? { status: 429 } : { json: fixture("nile-solid-txinfo.json") },
    );
    const delays: number[] = [];
    const a = adapter(fn, { sleep: async (ms) => void delays.push(ms) });
    expect((await a.verify(candidate, USDT, [ADDR])).status).toBe("final");
    expect(calls).toHaveLength(3);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
    expect(calls[0]?.init.redirect).toBe("error");

    const bad = fakeFetch(() => ({ status: 400 }));
    await expect(adapter(bad.fn).verify(candidate, USDT, [ADDR])).rejects.toMatchObject({
      retryable: false,
      status: 400,
    });
    expect(bad.calls).toHaveLength(1);
  });

  it("enforces the response size limit", async () => {
    const big = fakeFetch(() => ({ text: JSON.stringify({ pad: "x".repeat(5_000) }) }));
    await expect(
      adapter(big.fn, { maxResponseBytes: 1_000 }).verify(candidate, USDT, [ADDR]),
    ).rejects.toThrow("too large");
  });

  it("sends the API key header only when configured", async () => {
    const without = fakeFetch(() => ({ json: {} }));
    await adapter(without.fn).verify(candidate, USDT, [ADDR]);
    expect(new Headers(without.calls[0]?.init.headers).has("TRON-PRO-API-KEY")).toBe(false);
    const withKey = fakeFetch(() => ({ json: {} }));
    await adapter(withKey.fn, { apiKey: "k-123" }).verify(candidate, USDT, [ADDR]);
    expect(new Headers(withKey.calls[0]?.init.headers).get("TRON-PRO-API-KEY")).toBe("k-123");
  });
});
