// SPDX-License-Identifier: Apache-2.0
import { connect } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { AssetCatalog, type AssetSettings } from "../../application/catalog.ts";
import { ApplicationError } from "../../application/errors.ts";
import type { ApiScope } from "../../application/ports.ts";
import { RateService } from "../../application/rates.ts";
import { UniqueAmountStrategy } from "../../application/strategies/unique-amount.ts";
import { FakeChain } from "../../application/testing/fake-chain.ts";
import { InMemoryStore } from "../../application/testing/in-memory.ts";
import { CreateInvoice } from "../../application/use-cases/create-invoice.ts";
import { QuotePrice } from "../../application/use-cases/quote-price.ts";
import { STRICT_AMOUNT_POLICY, uniqueAmountPolicy } from "../../domain/amount-policy.ts";
import { chainAddress } from "../../domain/chain-address.ts";
import { TRON, USDT_TRON } from "../../domain/test-fixtures.ts";
import { ManualRateTable } from "../pricing/manual-table.ts";
import { newApiKey } from "./keys.ts";
import { ApiServer } from "./server.ts";

const T0 = new Date("2026-10-26T12:00:00Z");
const servers: ApiServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

interface InjectOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  payload?: object | string;
}

/** Real HTTP round trip against a server on a random port. */
async function client(api: ApiServer) {
  servers.push(api);
  const { port } = await api.listen("127.0.0.1", 0);
  return {
    api,
    /** Sends raw bytes (what fetch would refuse to send) and returns the status line of the answer. */
    raw: (request: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => socket.write(request));
        let data = "";
        socket.on("data", (c) => {
          data += c;
          if (data.includes("\r\n\r\n")) {
            socket.end();
            resolve(data.split("\r\n")[0] ?? "");
          }
        });
        socket.on("error", reject);
      }),
    inject: async (o: InjectOptions) => {
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      let body: string | undefined;
      if (o.payload !== undefined) {
        body = typeof o.payload === "string" ? o.payload : JSON.stringify(o.payload);
        headers["content-type"] ??= "application/json";
      }
      const res = await fetch(`http://127.0.0.1:${port}${o.url}`, {
        method: o.method ?? "GET",
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      const text = await res.text();
      return { statusCode: res.status, headers: res.headers, body: text, json: () => JSON.parse(text) };
    },
  };
}
const ADDR = chainAddress(TRON, "TAddrA111111111111111111111111111");

async function setup(
  opts: {
    rateLimit?: number;
    failing?: boolean | Error;
    page?: boolean;
    publicLimit?: number;
    returnOrigins?: string[];
  } = {},
) {
  const store = new InMemoryStore();
  const settings: AssetSettings = {
    asset: USDT_TRON,
    priceSymbol: "USDT",
    strategy: "unique-amount",
    addresses: [{ address: ADDR, status: "active", tokenAccount: null }],
    amountPolicy: STRICT_AMOUNT_POLICY,
    uniqueAmount: uniqueAmountPolicy({ stepUnits: 10_000n, maxSlots: 99 }),
    ttlMs: 1_800_000,
    graceMs: 3_600_000,
    amlThresholdUnits: 0n,
  };
  const catalog = new AssetCatalog([settings]);
  const pricing = { currencies: new Set(["USD", "JPY"]), markupBps: new Map<string, number>() };
  const rates = new RateService([
    new ManualRateTable([
      { base: "USD", quote: "USDT", rate: "1", setAt: T0, maxAgeMs: 3_600_000 },
      { base: "USD", quote: "JPY", rate: "150", setAt: T0, maxAgeMs: 3_600_000 },
    ]),
  ]);
  const clock = { now: () => T0 };
  let n = 0;
  const uniqueAmount = new UniqueAmountStrategy();
  const createInvoice = new CreateInvoice({
    uow: store,
    catalog,
    pricing,
    rates,
    strategies: () => uniqueAmount,
    clock,
    ids: { newId: () => `inv-${++n}` },
    integrity: { check: async () => ({ ok: true }) },
  });
  const errors: unknown[] = [];
  const app = await client(
    new ApiServer({
      uow: store,
      createInvoice: opts.failing
        ? ({
            execute: async () =>
              Promise.reject(
                opts.failing instanceof Error ? opts.failing : new Error("secret db password in message"),
              ),
          } as unknown as CreateInvoice)
        : createInvoice,
      quotePrice: new QuotePrice(catalog, pricing, rates),
      adapters: [new FakeChain(TRON)],
      clock,
      rateLimitPerMinute: opts.rateLimit ?? 1_000,
      paymentPage: opts.page
        ? {
            defaultLanguage: "en",
            publicRateLimitPerMinute: opts.publicLimit ?? 1_000,
            returnOrigins: new Set(opts.returnOrigins ?? []),
          }
        : null,
      onError: (e) => errors.push(e),
    }),
  );
  const key = async (scopes: ApiScope[]) => {
    const k = newApiKey("test", scopes);
    await store.run((r) => r.apiKeys.insert(k.record));
    return { token: k.token, id: k.record.id };
  };
  const rw = await key(["invoices:read", "invoices:write", "quotes:read"]);
  const auth = (token = rw.token) => ({ authorization: `Bearer ${token}` });
  const body = { merchant_order_id: "o1", price: { amount: "10", currency: "USD" }, asset: "usdt-tron" };
  const create = (b: unknown = body, idem = "k1", token = rw.token) =>
    app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...auth(token), "idempotency-key": idem },
      payload: b as object,
    });
  return { app, store, key, auth, create, body, errors, rw };
}

/** Counts transactions the store runs, to see what a request costs in database work. */
function countRuns(store: InMemoryStore): () => number {
  let n = 0;
  const run = store.run.bind(store);
  store.run = async (work) => {
    n++;
    return run(work);
  };
  return () => n;
}

describe("merchant API", () => {
  it("health needs no key and reveals nothing", async () => {
    const { app } = await setup();
    const r = await app.inject({ url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: "ok" });
  });

  it("rejects missing, malformed, unknown and revoked keys, and keys without the scope", async () => {
    const { app, key, store, create, auth } = await setup();
    expect((await app.inject({ url: "/v1/invoices" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/invoices", headers: auth("nck_bad") })).statusCode).toBe(401);
    const unknown = newApiKey("x", ["invoices:read"]).token;
    expect((await app.inject({ url: "/v1/invoices", headers: auth(unknown) })).statusCode).toBe(401);
    const readOnly = await key(["invoices:read"]);
    expect((await create(undefined, "k1", readOnly.token)).statusCode).toBe(403);
    await store.run((r) => r.apiKeys.revoke(readOnly.id, new Date()));
    expect((await app.inject({ url: "/v1/invoices", headers: auth(readOnly.token) })).statusCode).toBe(401);
    // a valid id with a wrong secret
    const wrong = `${readOnly.token.slice(0, 17)}${"A".repeat(43)}`;
    expect((await app.inject({ url: "/v1/invoices", headers: auth(wrong) })).statusCode).toBe(401);
  });

  it("creates an invoice with payment instructions and locked rate", async () => {
    const { create } = await setup();
    const r = await create({
      merchant_order_id: "o1",
      price: { amount: "1500", currency: "JPY" },
      asset: "usdt-tron",
    });
    expect(r.statusCode).toBe(201);
    const inv = r.json();
    expect(inv).toMatchObject({
      merchant_order_id: "o1",
      status: "awaiting_payment",
      payment: { address: ADDR.value, amount: "10.010000", amount_units: "10010000", memo: null },
      price: { amount: "1500", currency: "JPY", rate_source: "manual" },
      asset: { id: "usdt-tron", contract: USDT_TRON.contract },
    });
  });

  it("keeps a price in the asset's own symbol exactly as sent, with null rate fields", async () => {
    const { create } = await setup();
    const r = await create({
      merchant_order_id: "o1",
      price: { amount: "3.00", currency: "USDT" },
      asset: "usdt-tron",
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ payment: { amount: "3.010000" } });
    expect(r.json().price).toEqual({
      amount: "3.00",
      currency: "USDT",
      rate: null,
      rate_source: null,
      rate_at: null,
      rate_path: null,
    });
  });

  it("is idempotent by Idempotency-Key; the same key with another body is refused", async () => {
    const { create, body } = await setup();
    const first = await create();
    const again = await create();
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
    const other = await create({ ...body, merchant_order_id: "o2" });
    expect(other.statusCode).toBe(422);
    expect(other.json().error.code).toBe("idempotency_mismatch");
    expect((await create(body, "")).statusCode).toBe(400);
  });

  it("a concurrent create with the same Idempotency-Key and another body is refused, not silently accepted", async () => {
    const { create, body, store } = await setup();
    // Both requests find no stored row (the race), so both create; the second insert of the key then collides.
    const run = store.run.bind(store);
    let misses = 2;
    store.run = async (work) =>
      run((repos) =>
        work({
          ...repos,
          idempotency: {
            ...repos.idempotency,
            find: async (k, key) => (misses-- > 0 ? null : repos.idempotency.find(k, key)),
          },
        }),
      );
    expect((await create(body, "race")).statusCode).toBe(201);
    const second = await create({ ...body, merchant_order_id: "o2" }, "race");
    expect(second.statusCode).toBe(422);
    expect(second.json().error.code).toBe("idempotency_mismatch");
  });

  it("asks the database only for tokens shaped like a key; junk is refused without a transaction", async () => {
    const { app, store } = await setup();
    const runs = countRuns(store);
    for (const token of ["x", "nck_", "nck_000000000000_short", "a".repeat(200)]) {
      const r = await app.inject({ url: "/v1/invoices", headers: { authorization: `Bearer ${token}` } });
      expect(r.statusCode).toBe(401);
    }
    expect(runs()).toBe(0);
    // a well-formed but unknown key costs exactly one lookup
    const r = await app.inject({
      url: "/v1/invoices",
      headers: { authorization: `Bearer nck_000000000000_${"A".repeat(43)}` },
    });
    expect(r.statusCode).toBe(401);
    expect(runs()).toBe(1);
  });

  it("a malformed request target is the client's error (400), never a logged 500", async () => {
    const { app, errors } = await setup();
    for (const target of ["//[", "http://["]) {
      const line = await app.raw(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      expect(line, target).toContain(" 400 ");
    }
    expect(errors).toEqual([]);
  });

  it("a server error after start-up is reported and does not crash the process", async () => {
    const { app, errors } = await setup();
    const boom = new Error("accept EMFILE");
    expect(() => app.api.server.emit("error", boom)).not.toThrow();
    expect(errors).toEqual([boom]);
  });

  it("validates strictly: decimal strings only, no unknown fields, body size limit", async () => {
    const { create, app, auth, body } = await setup();
    expect((await create({ ...body, price: { amount: 10.5, currency: "USD" } })).statusCode).toBe(400);
    expect((await create({ ...body, price: { amount: "1e3", currency: "USD" } })).statusCode).toBe(400);
    expect((await create({ ...body, admin: true })).statusCode).toBe(400);
    const big = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...auth(), "idempotency-key": "k9", "content-type": "application/json" },
      payload: JSON.stringify({ ...body, merchant_order_id: "x".repeat(20_000) }),
    });
    expect(big.statusCode).toBe(413);
  });

  it("maps application errors to stable codes", async () => {
    const { create, body } = await setup();
    const r = await create({ ...body, price: { amount: "10", currency: "EUR" } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("pricing.currency_disabled");
    const precision = await create({ ...body, price: { amount: "10.001", currency: "USD" } }, "k2");
    expect(precision.json().error.code).toBe("decimal.precision");
  });

  it("never leaks internal errors", async () => {
    const { create, errors } = await setup({ failing: true });
    const r = await create();
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain("password");
    expect(r.json()).toEqual({ error: { code: "internal", message: "internal error" } });
    expect(errors).toHaveLength(1);
  });

  it("an operator-side application error is 500 with its code, one never expected in a request is 500 internal", async () => {
    const memo = await setup({ failing: new ApplicationError("allocation.bad_memo", "generator detail") });
    const r = await memo.create();
    expect(r.statusCode).toBe(500); // was 422: the code had no status and fell back to a client error
    expect(r.json()).toEqual({ error: { code: "allocation.bad_memo", message: "internal error" } });
    expect(memo.errors).toHaveLength(1);
    const cli = await setup({ failing: new ApplicationError("invoice.not_found", "inv-1 detail") });
    const r2 = await cli.create();
    expect(r2.statusCode).toBe(500);
    expect(r2.json()).toEqual({ error: { code: "internal", message: "internal error" } });
    expect(cli.errors).toHaveLength(1);
  });

  it("accepts RFC 3339 timestamps with an offset in since, as the OpenAPI format date-time promises", async () => {
    const { app, auth, create } = await setup();
    await create();
    const r = await app.inject({
      url: "/v1/invoices?since=2026-10-26T11%3A00%3A00%2B03%3A00",
      headers: auth(),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toHaveLength(1);
    expect((await app.inject({ url: "/v1/invoices?since=yesterday", headers: auth() })).statusCode).toBe(400);
  });

  it("gets and lists invoices", async () => {
    const { create, app, auth, body } = await setup();
    const id = (await create()).json().id;
    await create({ ...body, merchant_order_id: "o2" }, "k2");
    expect((await app.inject({ url: `/v1/invoices/${id}`, headers: auth() })).json().id).toBe(id);
    expect((await app.inject({ url: "/v1/invoices/nope", headers: auth() })).statusCode).toBe(404);
    const list = await app.inject({ url: "/v1/invoices?status=awaiting_payment&limit=10", headers: auth() });
    expect(list.json().data).toHaveLength(2);
    expect((await app.inject({ url: "/v1/invoices?status=bogus", headers: auth() })).statusCode).toBe(400);
  });

  it("pages through invoices with next_before, newest first, without gaps or repeats", async () => {
    const { create, app, auth, body } = await setup();
    // created in the same millisecond: the order between them is decided by id
    for (let i = 1; i <= 5; i++) await create({ ...body, merchant_order_id: `p${i}` }, `kp${i}`);
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const qs: string = before ? `&before=${encodeURIComponent(before)}` : "";
      const r = await app.inject({ url: `/v1/invoices?limit=2${qs}`, headers: auth() });
      expect(r.statusCode).toBe(200);
      const page = r.json() as { data: Array<{ merchant_order_id: string }>; next_before: string | null };
      seen.push(...page.data.map((x) => x.merchant_order_id));
      before = page.next_before;
      pages++;
    } while (before && pages < 10);
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(new Set(seen).size).toBe(5);
    const bad = await app.inject({ url: "/v1/invoices?before=not-a-cursor", headers: auth() });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_request");
  });

  it("quotes without creating an invoice", async () => {
    const { app, auth, store } = await setup();
    const r = await app.inject({
      url: "/v1/quotes?amount=1500&currency=JPY&asset=usdt-tron",
      headers: auth(),
    });
    expect(r.json()).toMatchObject({ asset: "usdt-tron", amount: "10.000000" });
    const direct = await app.inject({
      url: "/v1/quotes?amount=3&currency=USDT&asset=usdt-tron",
      headers: auth(),
    });
    expect(direct.json()).toMatchObject({
      amount: "3.000000",
      price: { amount: "3", currency: "USDT", rate: null, rate_path: null },
    });
    expect(store.data.invoices.size).toBe(0);
  });

  it("transport rules: 404/405, JSON only, no duplicated query parameters, safe response headers", async () => {
    const { app, auth } = await setup();
    expect((await app.inject({ url: "/v2/nothing" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/v1/invoices", headers: auth() })).statusCode).toBe(
      405,
    );
    const form = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...auth(), "idempotency-key": "k1", "content-type": "application/x-www-form-urlencoded" },
      payload: "a=1",
    });
    expect(form.statusCode).toBe(415);
    const broken = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...auth(), "idempotency-key": "k1" },
      payload: "{not json",
    });
    expect(broken.json().error.code).toBe("invalid_json");
    const dup = await app.inject({ url: "/v1/invoices?limit=1&limit=2", headers: auth() });
    expect(dup.statusCode).toBe(400);
    const r = await app.inject({ url: "/health" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("an own __proto__ key in the body is an unknown field and is refused", async () => {
    const { app, auth } = await setup();
    const raw =
      '{"merchant_order_id":"o1","price":{"amount":"1","currency":"USD"},"asset":"usdt-tron","__proto__":{"x":1}}';
    const r = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...auth(), "idempotency-key": "k1" },
      payload: raw,
    });
    expect(r.statusCode).toBe(400);
  });

  it("rate-limits per key", async () => {
    const { app, auth } = await setup({ rateLimit: 3 });
    const codes = [];
    for (let i = 0; i < 5; i++)
      codes.push((await app.inject({ url: "/v1/invoices", headers: auth() })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});

describe("hosted payment page", () => {
  it("is disabled by default", async () => {
    const { app, create } = await setup();
    const id = (await create()).json().id;
    expect((await app.inject({ url: `/pay/${id}` })).statusCode).toBe(404);
  });

  it("serves the page with a strict CSP whose nonce matches the inline script", async () => {
    const { app, create } = await setup({ page: true });
    const inv = (await create()).json();
    expect(inv.payment.page).toBe(`/pay/${inv.id}`);
    const r = await app.inject({ url: inv.payment.page, headers: { "accept-language": "fa" } });
    expect(r.statusCode).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = r.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(r.body).toContain(`<script nonce="${nonce}">`);
    expect(r.body).toContain('dir="rtl"');
    expect(r.body).toContain("Fake tron:mainnet"); // the network's name comes from its adapter
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    const again = await app.inject({ url: inv.payment.page });
    expect(again.headers.get("content-security-policy")).not.toBe(csp); // fresh nonce per response
  });

  it("after the grace period the page shows the status only, never an address a newer invoice may own", async () => {
    const { app, create, store } = await setup({ page: true });
    const inv = (await create()).json();
    // move the invoice past its grace period in the store (the server's clock is fixed at T0)
    const state = store.data.invoices.get(inv.id);
    if (!state) throw new Error("invoice missing");
    store.data.invoices.set(inv.id, {
      ...state,
      status: "expired",
      expiresAt: new Date(T0.getTime() - 7_200_000),
      graceUntil: new Date(T0.getTime() - 3_600_000),
    });
    const r = await app.inject({ url: inv.payment.page });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(inv.payment.address);
    expect(r.body).not.toContain("<svg");
    expect(r.body).toContain("This invoice has expired");
    // still inside grace: the address is shown (a late payment is credited as paid_late)
    store.data.invoices.set(inv.id, {
      ...state,
      status: "expired",
      expiresAt: new Date(T0.getTime() - 60_000),
      graceUntil: new Date(T0.getTime() + 3_600_000),
    });
    expect((await app.inject({ url: inv.payment.page })).body).toContain(inv.payment.address);
  });

  it("return URLs: only https on a configured origin; stored, returned and shown as links", async () => {
    const { app, create, body, store } = await setup({ page: true, returnOrigins: ["https://shop.example"] });
    const urls = { success_url: "https://shop.example/thanks?o=1", cancel_url: "https://shop.example/cart" };
    for (const [n, bad] of [
      "http://shop.example/x",
      "https://evil.example/x",
      "https://shop.example.evil.example/x",
      "https://user:pw@shop.example/x",
      "javascript:alert(1)",
      "not a url",
    ].entries()) {
      const r = await create({ ...body, success_url: bad }, `bad-${n}`);
      expect(r.statusCode, bad).toBe(422);
      expect(r.json().error.code, bad).toBe("return_url_not_allowed");
    }
    const r = await create({ ...body, ...urls });
    expect(r.statusCode).toBe(201);
    const inv = r.json();
    expect(inv).toMatchObject(urls);
    // awaiting payment: the cancel link only
    const page = (await app.inject({ url: inv.payment.page })).body;
    expect(page).toMatch(/<a class="back" id="back-cancel" href="https:\/\/shop\.example\/cart"[^>]*>/);
    expect(page).toMatch(/<a class="btn" id="back-success"[^>]* hidden>/);
    // received: the success button, the cancel link hidden
    const state = store.data.invoices.get(inv.id);
    if (!state) throw new Error("invoice missing");
    store.data.invoices.set(inv.id, { ...state, status: "completed" });
    const paid = (await app.inject({ url: inv.payment.page })).body;
    expect(paid).toContain('href="https://shop.example/thanks?o=1" rel="noopener noreferrer">');
    expect(paid).toMatch(/id="back-cancel"[^>]* hidden>/);
    // a URL changed in the database to an origin that is not configured is never shown
    store.data.invoices.set(inv.id, { ...state, status: "completed", successUrl: "https://evil.example/" });
    expect((await app.inject({ url: inv.payment.page })).body).not.toContain("evil.example");
  });

  it("return URLs are refused when no origin is configured (or the page is off)", async () => {
    for (const s of [await setup({ page: true }), await setup()]) {
      const r = await s.create({ ...s.body, cancel_url: "https://shop.example/cart" });
      expect(r.statusCode).toBe(422);
      expect(r.json().error.code).toBe("return_url_not_allowed");
      const plain = (await s.create(s.body, "k2")).json();
      expect(plain).toMatchObject({ success_url: null, cancel_url: null });
    }
  });

  it("public status reveals only status, received amount and deadlines", async () => {
    const { app, create } = await setup({ page: true });
    const id = (await create()).json().id;
    const r = await app.inject({ url: `/pay/${id}/status` });
    expect(Object.keys(r.json()).sort()).toEqual(["expires_at", "grace_until", "received", "status"]);
    expect((await app.inject({ url: "/pay/nope/status" })).statusCode).toBe(404);
  });

  it("public routes are rate-limited", async () => {
    const { app, create } = await setup({ page: true, publicLimit: 2 });
    const id = (await create()).json().id;
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ url: `/pay/${id}/status` })).statusCode);
    expect(codes).toEqual([200, 200, 429, 429]);
  });
});
