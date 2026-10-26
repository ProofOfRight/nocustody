// SPDX-License-Identifier: Apache-2.0
// Merchant REST API (Fastify). Driving adapter: translates HTTP to use cases; no business logic here.
// See docs/api.md and docs/api/openapi.yaml.
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { AssetCatalog } from "../../application/catalog.ts";
import { ApplicationError, ConcurrencyError } from "../../application/errors.ts";
import type { ApiKeyRecord, ApiScope, ChainAdapter, Clock, UnitOfWork } from "../../application/ports.ts";
import type { CreateInvoice } from "../../application/use-cases/create-invoice.ts";
import type { QuotePrice } from "../../application/use-cases/quote-price.ts";
import { DomainError } from "../../domain/errors.ts";
import type { Invoice, InvoiceStatus } from "../../domain/invoice.ts";
import { authenticate } from "./keys.ts";

export interface ApiDeps {
  readonly uow: UnitOfWork;
  readonly catalog: AssetCatalog;
  readonly createInvoice: CreateInvoice;
  readonly quotePrice: QuotePrice;
  readonly adapters: readonly ChainAdapter[];
  readonly clock: Clock;
  readonly rateLimitPerMinute: number;
  readonly trustProxy: boolean;
  readonly onError?: (err: unknown) => void;
}

const STATUSES = [
  "awaiting_payment",
  "confirming",
  "paid",
  "underpaid",
  "overpaid",
  "paid_late",
  "expired",
  "cancelled",
  "aml_pending",
  "aml_hold",
  "completed",
  "rejected",
] as const satisfies readonly InvoiceStatus[];

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
    since: z.string().datetime().optional(),
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

const APP_ERRORS: Readonly<Record<string, number>> = {
  "asset.unknown": 422,
  "pricing.currency_disabled": 422,
  "invoice.zero_amount": 422,
  "pricing.no_rate": 503,
  "allocation.no_free_slot": 503,
  "allocation.no_address": 503,
  "allocation.memo_collision": 503,
  "integrity.pin_violation": 503,
};

declare module "fastify" {
  interface FastifyRequest {
    apiKey: ApiKeyRecord | null;
  }
}

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

export function buildApi(d: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    trustProxy: d.trustProxy,
    return503OnClosing: true,
  });
  const buckets = new Map<string, { tokens: number; at: number }>();

  app.decorateRequest("apiKey", null);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError)
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ApplicationError) {
      return reply
        .code(APP_ERRORS[err.code] ?? 422)
        .send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof DomainError)
      return reply.code(422).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ConcurrencyError) {
      return reply.code(409).send({ error: { code: "conflict", message: "concurrent update, retry" } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: "bad_request", message: "malformed request" } });
    }
    d.onError?.(err);
    return reply.code(500).send({ error: { code: "internal", message: "internal error" } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "not found" } }),
  );

  const guard = (scope: ApiScope) => async (req: FastifyRequest) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const key = token ? await d.uow.run((r) => authenticate(token, r.apiKeys)) : null;
    if (!key) throw new HttpError(401, "unauthorized", "missing or invalid API key");
    if (!key.scopes.includes(scope)) throw new HttpError(403, "forbidden", `the key lacks scope ${scope}`);
    // Token bucket per key.
    const now = Date.now();
    const b = buckets.get(key.id) ?? { tokens: d.rateLimitPerMinute, at: now };
    b.tokens = Math.min(d.rateLimitPerMinute, b.tokens + ((now - b.at) / 60_000) * d.rateLimitPerMinute);
    b.at = now;
    if (b.tokens < 1) throw new HttpError(429, "rate_limited", "too many requests");
    b.tokens -= 1;
    buckets.set(key.id, b);
    req.apiKey = key;
  };

  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const r = schema.safeParse(value);
    if (!r.success) {
      const i = r.error.issues[0];
      throw new HttpError(400, "invalid_request", `${i?.path.join(".") || "body"}: ${i?.message}`);
    }
    return r.data;
  };

  app.get("/health", async () => ({ status: "ok" }));

  app.post(
    "/v1/invoices",
    { preHandler: guard("invoices:write") },
    async (req: FastifyRequest, reply: FastifyReply) => {
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
      if (replayed) return reply.code(200).send(invoiceDto(replayed, d.adapters));

      const { invoice, created } = await d.createInvoice.execute({
        merchantOrderId: body.merchant_order_id,
        priceAmount: body.price.amount,
        priceCurrency: body.price.currency,
        assetId: body.asset,
      });
      await d.uow
        .run((r) => r.idempotency.insert(key.id, idem, requestSha256, invoice.id))
        .catch(() => undefined); // a concurrent request with the same key stored it first; the invoice is the same
      return reply.code(created ? 201 : 200).send(invoiceDto(invoice, d.adapters));
    },
  );

  app.get("/v1/invoices/:id", { preHandler: guard("invoices:read") }, async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new HttpError(404, "not_found", "invoice not found");
    const inv = await d.uow.run((r) => r.invoices.findById(id));
    if (!inv) throw new HttpError(404, "not_found", "invoice not found");
    return invoiceDto(inv, d.adapters);
  });

  app.get("/v1/invoices", { preHandler: guard("invoices:read") }, async (req: FastifyRequest) => {
    const q = parse(listSchema, req.query);
    const list = await d.uow.run((r) =>
      r.invoices.search({
        limit: q.limit,
        ...(q.status ? { status: q.status } : {}),
        ...(q.since ? { since: new Date(q.since) } : {}),
      }),
    );
    return { data: list.map((i) => invoiceDto(i, d.adapters)) };
  });

  app.get("/v1/quotes", { preHandler: guard("quotes:read") }, async (req: FastifyRequest) => {
    const q = parse(quoteSchema, req.query);
    const quote = await d.quotePrice.execute(
      { amount: q.amount, currency: q.currency, assetId: q.asset },
      d.clock.now(),
    );
    return {
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
    };
  });

  return app;
}
