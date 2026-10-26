// SPDX-License-Identifier: Apache-2.0
// Merchant REST API on node:http (no framework, ADR-0025). Driving adapter: translates HTTP to use cases; no
// business logic here. See docs/api.md and docs/api/openapi.yaml.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { ApplicationError, ConcurrencyError } from "../../application/errors.ts";
import type { ApiKeyRecord, ApiScope, ChainAdapter, Clock, UnitOfWork } from "../../application/ports.ts";
import type { CreateInvoice } from "../../application/use-cases/create-invoice.ts";
import type { QuotePrice } from "../../application/use-cases/quote-price.ts";
import { DomainError } from "../../domain/errors.ts";
import { INVOICE_STATUSES, type Invoice } from "../../domain/invoice.ts";
import { authenticate, isTokenShaped } from "./keys.ts";
import { type Lang, pickLanguage } from "./page/i18n.ts";
import { contentSecurityPolicy, isPayable, NETWORK_NAMES, renderPaymentPage } from "./page/render.ts";

export interface ApiDeps {
  readonly uow: UnitOfWork;
  readonly createInvoice: CreateInvoice;
  readonly quotePrice: QuotePrice;
  readonly adapters: readonly ChainAdapter[];
  readonly clock: Clock;
  readonly rateLimitPerMinute: number;
  readonly onError?: (err: unknown) => void;
  /** Hosted payment page at /pay/:id; null = disabled (headless only). */
  readonly paymentPage?: { readonly defaultLanguage: Lang; readonly publicRateLimitPerMinute: number } | null;
}

/** Request bodies above this size are refused with 413. */
export const BODY_LIMIT = 16 * 1024;

const STATUSES = INVOICE_STATUSES;

const decimal = z.string().regex(/^(0|[1-9]\d{0,30})(\.\d{1,36})?$/, 'decimal string, e.g. "10.50"');
const createSchema = z
  .object({
    merchant_order_id: z.string().min(1).max(128),
    price: z.object({ amount: decimal, currency: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/) }).strict(),
    asset: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  })
  .strict();
const listSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    since: z.string().datetime({ offset: true }).optional(), // RFC 3339, as the OpenAPI format date-time says
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const quoteSchema = z
  .object({ amount: decimal, currency: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/), asset: z.string() })
  .strict();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Application error code → HTTP status; every code here is listed in docs/api/openapi.yaml (contract test). */
export const APP_ERRORS: Readonly<Record<string, number>> = {
  "asset.unknown": 422,
  "pricing.currency_disabled": 422,
  "invoice.zero_amount": 422,
  "invoice.order_mismatch": 409,
  "pricing.no_rate": 503,
  "pricing.depeg_block": 503,
  "allocation.no_free_slot": 503,
  "allocation.no_address": 503,
  "allocation.memo_collision": 503,
  "integrity.pin_violation": 503,
};

export function invoiceDto(inv: Invoice, adapters: readonly ChainAdapter[]) {
  const s = inv.state;
  const adapter = adapters.find((a) => a.network === s.asset.network);
  return {
    id: s.id,
    merchant_order_id: s.merchantOrderId,
    status: s.status,
    asset: {
      id: s.asset.id,
      network: s.asset.network,
      symbol: s.asset.symbol,
      decimals: s.asset.decimals,
      contract: s.asset.contract,
    },
    payment: {
      address: s.instructions.address.value,
      address_display: adapter?.formatAddress?.(s.instructions.address) ?? s.instructions.address.value,
      amount: s.instructions.amount.toDecimalString(),
      amount_units: s.instructions.amount.units.toString(),
      memo: s.instructions.memo,
      uri: adapter?.buildPaymentUri(s.instructions) ?? null,
    },
    price: s.price
      ? {
          amount: s.price.amount,
          currency: s.price.currency,
          rate: s.price.rate,
          rate_source: s.price.rateSource,
          rate_at: s.price.rateAt?.toISOString() ?? null,
          rate_path: s.price.ratePath,
        }
      : null,
    received: inv.received().toDecimalString(),
    payments: s.payments.map((p) => ({
      transfer: p.transferKey,
      from: p.from,
      amount: p.amount.toDecimalString(),
      at: p.at.toISOString(),
    })),
    created_at: s.createdAt.toISOString(),
    expires_at: s.expiresAt.toISOString(),
    grace_until: s.graceUntil.toISOString(),
  };
}

interface Request {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: IncomingMessage["headers"];
  readonly body: unknown;
  readonly params: Record<string, string>;
  apiKey: ApiKeyRecord | null;
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
  /** Set for non-JSON responses (the payment page); body is then a string. */
  readonly html?: { readonly csp: string };
}

type Handler = (req: Request) => Promise<Reply>;

interface Route {
  readonly method: string;
  readonly path: string;
  readonly pattern: RegExp;
  readonly params: readonly string[];
  readonly scope: ApiScope | null;
  readonly handler: Handler;
}

const ok = (body: unknown, status = 200): Reply => ({ status, body });

function route(method: string, path: string, scope: ApiScope | null, handler: Handler): Route {
  const params: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:([a-z]+)/g, (_m, name: string) => {
      params.push(name);
      return "([^/]+)";
    })}$`,
  );
  return { method, path, pattern, params, scope, handler };
}

/** Reads the body up to BODY_LIMIT bytes; JSON only. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > BODY_LIMIT)
    throw new HttpError(413, "payload_too_large", `body larger than ${BODY_LIMIT} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT)
      throw new HttpError(413, "payload_too_large", `body larger than ${BODY_LIMIT} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  if (type !== "application/json") throw new HttpError(415, "unsupported_media_type", "use application/json");
  try {
    // Prototype pollution is not possible: parsed values are only read through strict zod schemas.
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "body is not valid JSON");
  }
}

function parseQuery(search: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of search) {
    if (Object.hasOwn(out, k))
      throw new HttpError(400, "invalid_request", `query parameter ${k} given twice`);
    out[k] = v;
  }
  return out;
}

export class ApiServer {
  readonly server: Server;
  readonly #d: ApiDeps;
  readonly #routes: readonly Route[];
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  #publicBucket = { tokens: 0, at: 0 };

  constructor(d: ApiDeps) {
    this.#d = d;
    this.#routes = this.#buildRoutes();
    this.server = createServer(
      { requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 },
      (req, res) => {
        void this.#handle(req, res);
      },
    );
    this.server.maxHeadersCount = 50;
  }

  /** The route table (method, path pattern, scope), for the contract test against docs/api/openapi.yaml. */
  get routes(): ReadonlyArray<{ method: string; path: string; scope: ApiScope | null }> {
    return this.#routes.map((r) => ({ method: r.method, path: r.path, scope: r.scope }));
  }

  async listen(host: string, port: number): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        // After start-up a server "error" (e.g. accept EMFILE) is reported, not left to crash the process once
        // the start-up listener has been used up.
        this.server.removeListener("error", reject);
        this.server.on("error", (err) => this.#d.onError?.(err));
        resolve();
      });
    });
    return this.server.address() as AddressInfo;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeIdleConnections();
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let reply: Reply;
    try {
      reply = await this.#dispatch(req);
    } catch (err) {
      reply = this.#error(err);
    }
    const body = reply.html ? String(reply.body) : JSON.stringify(reply.body);
    res.writeHead(reply.status, {
      "content-type": reply.html ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      ...(reply.html ? { "content-security-policy": reply.html.csp } : {}),
    });
    res.end(body);
  }

  async #dispatch(raw: IncomingMessage): Promise<Reply> {
    let url: URL;
    try {
      url = new URL(raw.url ?? "/", "http://localhost");
    } catch {
      // The HTTP parser lets request targets such as "//[" through; they are the client's fault, not a 500.
      throw new HttpError(400, "invalid_request", "malformed request target");
    }
    const method = raw.method ?? "GET";
    let found: { route: Route; match: RegExpExecArray } | null = null;
    let pathKnown = false;
    for (const r of this.#routes) {
      const match = r.pattern.exec(url.pathname);
      if (!match) continue;
      pathKnown = true;
      if (r.method === method) {
        found = { route: r, match };
        break;
      }
    }
    if (!found) {
      if (pathKnown) throw new HttpError(405, "method_not_allowed", "method not allowed");
      throw new HttpError(404, "not_found", "not found");
    }
    const params: Record<string, string> = {};
    found.route.params.forEach((name, i) => {
      try {
        params[name] = decodeURIComponent(found.match[i + 1] ?? "");
      } catch {
        throw new HttpError(400, "invalid_request", `malformed path parameter ${name}`);
      }
    });
    const req: Request = {
      method,
      path: url.pathname,
      query: parseQuery(url.searchParams),
      headers: raw.headers,
      body: method === "POST" ? await readJson(raw) : undefined,
      params,
      apiKey: null,
    };
    if (found.route.scope) req.apiKey = await this.#authorize(req, found.route.scope);
    return found.route.handler(req);
  }

  async #authorize(req: Request, scope: ApiScope): Promise<ApiKeyRecord> {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    // Anything that is not shaped like a key is refused here; the database is asked only for well-formed tokens.
    const key = isTokenShaped(token)
      ? await this.#d.uow.run(async (r) => {
          const k = await authenticate(token, r.apiKeys);
          if (k) await r.apiKeys.touch(k.id, this.#d.clock.now());
          return k;
        })
      : null;
    if (!key) throw new HttpError(401, "unauthorized", "missing or invalid API key");
    if (!key.scopes.includes(scope)) throw new HttpError(403, "forbidden", `the key lacks scope ${scope}`);
    // Token bucket per key.
    const limit = this.#d.rateLimitPerMinute;
    const now = Date.now();
    const b = this.#buckets.get(key.id) ?? { tokens: limit, at: now };
    b.tokens = Math.min(limit, b.tokens + ((now - b.at) / 60_000) * limit);
    b.at = now;
    if (b.tokens < 1) throw new HttpError(429, "rate_limited", "too many requests");
    b.tokens -= 1;
    this.#buckets.set(key.id, b);
    return key;
  }

  #dto(inv: Invoice) {
    const dto = invoiceDto(inv, this.#d.adapters);
    const page = this.#d.paymentPage ? `/pay/${encodeURIComponent(inv.id)}` : null;
    return { ...dto, payment: { ...dto.payment, page } };
  }

  /** One shared bucket for unauthenticated routes (behind a proxy all clients share an address anyway). */
  #takePublic(limit: number): void {
    const now = Date.now();
    const b = this.#publicBucket;
    if (b.at === 0) Object.assign(b, { tokens: limit, at: now });
    b.tokens = Math.min(limit, b.tokens + ((now - b.at) / 60_000) * limit);
    b.at = now;
    if (b.tokens < 1) throw new HttpError(429, "rate_limited", "too many requests");
    b.tokens -= 1;
  }

  async #publicInvoice(id: string): Promise<Invoice> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new HttpError(404, "not_found", "not found");
    const inv = await this.#d.uow.run((r) => r.invoices.findById(id));
    if (!inv) throw new HttpError(404, "not_found", "not found");
    return inv;
  }

  #error(err: unknown): Reply {
    const fail = (status: number, code: string, message: string) => ({
      status,
      body: { error: { code, message } },
    });
    if (err instanceof HttpError) return fail(err.status, err.code, err.message);
    if (err instanceof ApplicationError) return fail(APP_ERRORS[err.code] ?? 422, err.code, err.message);
    if (err instanceof DomainError) return fail(422, err.code, err.message);
    if (err instanceof ConcurrencyError) return fail(409, "conflict", "concurrent update, retry");
    this.#d.onError?.(err);
    return fail(500, "internal", "internal error");
  }

  #buildRoutes(): Route[] {
    const d = this.#d;
    const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
      const r = schema.safeParse(value);
      if (!r.success) {
        const i = r.error.issues[0];
        throw new HttpError(400, "invalid_request", `${i?.path.join(".") || "body"}: ${i?.message}`);
      }
      return r.data;
    };

    const page = d.paymentPage ?? null;
    const pageRoutes: Route[] = page
      ? [
          route("GET", "/pay/:id", null, async (req) => {
            this.#takePublic(page.publicRateLimitPerMinute);
            const inv = await this.#publicInvoice(req.params.id ?? "");
            const s = inv.state;
            const lang = pickLanguage(req.query.lang, req.headers["accept-language"], page.defaultLanguage);
            const nonce = randomBytes(18).toString("base64");
            const html = renderPaymentPage(
              {
                id: s.id,
                status: s.status,
                assetSymbol: s.asset.symbol,
                networkName: NETWORK_NAMES[s.asset.network] ?? s.asset.network,
                amount: s.instructions.amount.toDecimalString(),
                address: (() => {
                  const a = d.adapters.find((x) => x.network === s.asset.network);
                  return a?.formatAddress?.(s.instructions.address) ?? s.instructions.address.value;
                })(),
                memo: s.instructions.memo,
                uri:
                  d.adapters.find((a) => a.network === s.asset.network)?.buildPaymentUri(s.instructions) ??
                  null,
                expiresAt: s.expiresAt.toISOString(),
                graceUntil: s.graceUntil.toISOString(),
                statusUrl: `/pay/${encodeURIComponent(s.id)}/status`,
                payable: isPayable(s.status, s.graceUntil, d.clock.now()),
              },
              lang,
              nonce,
            );
            return { status: 200, body: html, html: { csp: contentSecurityPolicy(nonce) } };
          }),
          // Public status for the page: no order id, no payments, no sender addresses.
          route("GET", "/pay/:id/status", null, async (req) => {
            this.#takePublic(page.publicRateLimitPerMinute);
            const inv = await this.#publicInvoice(req.params.id ?? "");
            const s = inv.state;
            return ok({
              status: s.status,
              received: inv.received().toDecimalString(),
              expires_at: s.expiresAt.toISOString(),
              grace_until: s.graceUntil.toISOString(),
            });
          }),
        ]
      : [];

    return [
      ...pageRoutes,
      route("GET", "/health", null, async () => ok({ status: "ok" })),

      route("POST", "/v1/invoices", "invoices:write", async (req) => {
        const key = req.apiKey as ApiKeyRecord;
        const idem = req.headers["idempotency-key"];
        if (typeof idem !== "string" || !IDEMPOTENCY_KEY.test(idem)) {
          throw new HttpError(
            400,
            "idempotency_key_required",
            "Idempotency-Key header (1-128 of [A-Za-z0-9_.:-]) is required",
          );
        }
        const body = parse(createSchema, req.body);
        const requestSha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
        const replayed = await d.uow.run(async (r) => {
          const prev = await r.idempotency.find(key.id, idem);
          if (!prev) return null;
          if (prev.requestSha256 !== requestSha256) {
            throw new HttpError(
              422,
              "idempotency_mismatch",
              "Idempotency-Key was used with a different request",
            );
          }
          return r.invoices.findById(prev.invoiceId);
        });
        if (replayed) return ok(this.#dto(replayed));
        const { invoice, created } = await d.createInvoice.execute({
          merchantOrderId: body.merchant_order_id,
          priceAmount: body.price.amount,
          priceCurrency: body.price.currency,
          assetId: body.asset,
        });
        try {
          await d.uow.run((r) => r.idempotency.insert(key.id, idem, requestSha256, invoice.id));
        } catch (e) {
          // A concurrent request with the same key stored its row first: the stored body decides, as for a replay.
          const stored = await d.uow.run((r) => r.idempotency.find(key.id, idem));
          if (!stored) throw e;
          if (stored.requestSha256 !== requestSha256) {
            throw new HttpError(
              422,
              "idempotency_mismatch",
              "Idempotency-Key was used concurrently with a different request",
            );
          }
        }
        return ok(this.#dto(invoice), created ? 201 : 200);
      }),

      route("GET", "/v1/invoices/:id", "invoices:read", async (req) => {
        const id = req.params.id ?? "";
        if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new HttpError(404, "not_found", "invoice not found");
        const inv = await d.uow.run((r) => r.invoices.findById(id));
        if (!inv) throw new HttpError(404, "not_found", "invoice not found");
        return ok(this.#dto(inv));
      }),

      route("GET", "/v1/invoices", "invoices:read", async (req) => {
        const q = parse(listSchema, req.query);
        const list = await d.uow.run((r) =>
          r.invoices.search({
            limit: q.limit,
            ...(q.status ? { status: q.status } : {}),
            ...(q.since ? { since: new Date(q.since) } : {}),
          }),
        );
        return ok({ data: list.map((i) => this.#dto(i)) });
      }),

      route("GET", "/v1/quotes", "quotes:read", async (req) => {
        const q = parse(quoteSchema, req.query);
        const quote = await d.quotePrice.execute(
          { amount: q.amount, currency: q.currency, assetId: q.asset },
          d.clock.now(),
        );
        return ok({
          asset: quote.asset.id,
          amount: quote.base.toDecimalString(),
          price: quote.price
            ? {
                amount: quote.price.amount,
                currency: quote.price.currency,
                rate: quote.price.rate,
                rate_path: quote.price.ratePath,
              }
            : null,
          note: "indicative: the invoice locks its own rate and may add a unique-amount step",
        });
      }),
    ];
  }
}
