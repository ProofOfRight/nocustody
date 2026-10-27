// SPDX-License-Identifier: Apache-2.0
// The documentation is part of the API contract: routes, statuses, event types and error codes must match the code.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssetCatalog } from "../../application/catalog.ts";
import { RateService } from "../../application/rates.ts";
import { InMemoryStore } from "../../application/testing/in-memory.ts";
import type { CreateInvoice } from "../../application/use-cases/create-invoice.ts";
import { QuotePrice } from "../../application/use-cases/quote-price.ts";
import { DOMAIN_EVENT_TYPES } from "../../domain/events.ts";
import { INVOICE_STATUSES } from "../../domain/invoice.ts";
import { APP_ERRORS, ApiServer } from "./server.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const openapi = read("../../../docs/api/openapi.yaml");
const apiMd = read("../../../docs/api.md");

/** Keys directly under `paths:` (two-space indent, starting with "/"). */
const documentedPaths = (): string[] =>
  [...openapi.matchAll(/^ {2}(\/[^\s:]*):\s*$/gm)].map((m) => (m[1] ?? "").replace(/\{([a-z]+)\}/g, ":$1"));

const server = (page: boolean) =>
  new ApiServer({
    uow: new InMemoryStore(),
    createInvoice: {} as CreateInvoice,
    quotePrice: new QuotePrice(
      new AssetCatalog([]),
      { currencies: new Set(), markupBps: new Map() },
      new RateService([]),
    ),
    adapters: [],
    clock: { now: () => new Date(0) },
    rateLimitPerMinute: 1,
    paymentPage: page ? { defaultLanguage: "en", publicRateLimitPerMinute: 1 } : null,
  });

describe("docs/api/openapi.yaml against the server", () => {
  it("documents every merchant API route and no other", () => {
    const routes = server(false).routes.map((r) => r.path);
    expect([...new Set(routes)].sort()).toEqual(documentedPaths().sort());
    // the payment page routes are documented in docs/payment-page.md, not in the merchant API spec
    const pageRoutes = server(true)
      .routes.filter((r) => r.path.startsWith("/pay/"))
      .map((r) => r.path);
    expect(pageRoutes).toEqual(["/pay/:id", "/pay/:id/status"]);
  });

  it("the Status enum equals the domain's statuses", () => {
    const block = /Status:\s*\n\s*type: string\s*\n\s*enum:\s*\n\s*\[([^\]]*)\]/.exec(openapi);
    const listed = (block?.[1] ?? "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .sort();
    expect(listed).toEqual([...INVOICE_STATUSES].sort());
  });

  it("every application error code and transport code is listed", () => {
    const description =
      /code:\s*\n\s*type: string\s*\n\s*description: \|([\s\S]*?)\n\s*message:/.exec(openapi)?.[1] ?? "";
    const listed = new Set(description.match(/[a-z_]+(?:\.[a-z_]+)*/g) ?? []);
    const transport = [
      "unauthorized",
      "forbidden",
      "invalid_request",
      "idempotency_key_required",
      "idempotency_mismatch",
      "return_url_not_allowed",
      "rate_limited",
      "not_found",
      "method_not_allowed",
      "payload_too_large",
      "unsupported_media_type",
      "invalid_json",
      "conflict",
      "internal",
    ];
    const served = Object.entries(APP_ERRORS).flatMap(([code, status]) => (status === null ? [] : [code]));
    for (const code of [...served, ...transport]) expect(listed, code).toContain(code);
  });
});

describe("docs/api.md against the domain", () => {
  it("lists every webhook event type the gateway can emit, and no other", () => {
    const section = /Event types:([\s\S]*?)\n\n/.exec(apiMd)?.[1] ?? "";
    const listed = [...section.matchAll(/`([a-z_]+\.[a-z_]+)`/g)].map((m) => m[1] ?? "").sort();
    expect(listed).toEqual([...DOMAIN_EVENT_TYPES].sort());
  });
});
