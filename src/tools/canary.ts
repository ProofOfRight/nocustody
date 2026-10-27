// SPDX-License-Identifier: Apache-2.0
// Address canary — run it from ANOTHER host (cron), not from the gateway server. It creates a small invoice through
// the public API and checks that every address a payer could see (`payment.address`, `payment.address_display`
// and the address inside `payment.uri`) is one of the addresses you expect. If the gateway server, its config or
// the reverse proxy were tampered with to show an attacker's address, this fails. The order id is random, so a
// tampered server cannot single canary requests out and answer them honestly.
//
//   CANARY_API_URL=https://pay.example.org CANARY_API_KEY=nck_... \
//   CANARY_ASSET=usdt-tron CANARY_PRICE="1 USDT" CANARY_EXPECTED=Taddr1,Taddr2 node src/tools/canary.ts
// The image ships it as /app/dist/tools/canary.js (docs/operations.md, "Address canary").
// CANARY_EXPECTED lists every form your addresses are shown in (for TON both the raw 0:… and the user-friendly
// form). https is required unless CANARY_ALLOW_HTTP=1 (the API key travels with the request).
// Exit code 0 = ok, 1 = unexpected address (alert!), 2 = could not check. Uses only the Node standard library.
import { randomUUID } from "node:crypto";

export interface CanaryInput {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly asset: string;
  readonly amount: string;
  readonly currency: string;
  readonly expected: readonly string[];
  readonly now: Date;
  /** Plain http is refused unless set: the API key travels with the request. */
  readonly allowHttp?: boolean;
}

export type CanaryResult =
  | { readonly status: "ok"; readonly address: string; readonly invoiceId: string }
  | { readonly status: "unexpected_address"; readonly address: string; readonly invoiceId: string }
  | { readonly status: "error"; readonly error: string };

/** Addresses a payer could read from the API answer; the URI is matched as text (any expected form inside it). */
export function shownAddresses(payment: {
  address?: string;
  address_display?: string;
  uri?: string | null;
}): { readonly field: string; readonly value: string }[] {
  const out: { field: string; value: string }[] = [];
  if (payment.address) out.push({ field: "address", value: payment.address });
  if (payment.address_display) out.push({ field: "address_display", value: payment.address_display });
  if (payment.uri) out.push({ field: "uri", value: payment.uri });
  return out;
}

export async function runCanary(i: CanaryInput, fetchFn: typeof fetch = fetch): Promise<CanaryResult> {
  if (!/^https:/i.test(i.apiUrl) && !i.allowHttp)
    return { status: "error", error: "CANARY_API_URL must be https" };
  const order = `canary-${randomUUID()}`;
  let res: Response;
  try {
    res = await fetchFn(`${i.apiUrl.replace(/\/$/, "")}/v1/invoices`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${i.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": order,
      },
      body: JSON.stringify({
        merchant_order_id: order,
        price: { amount: i.amount, currency: i.currency },
        asset: i.asset,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };
  const text = await res.text();
  if (text.length > 65_536) return { status: "error", error: "response too large" };
  let body: { id?: string; payment?: { address?: string; address_display?: string; uri?: string | null } };
  try {
    body = JSON.parse(text);
  } catch {
    return { status: "error", error: "response is not JSON" };
  }
  const address = body.payment?.address;
  if (!address || !body.id) return { status: "error", error: "response has no payment address" };
  const expected = i.expected.map((a) => a.trim()).filter(Boolean);
  const matches = (value: string) =>
    expected.some((e) => value === e || value.toLowerCase() === e.toLowerCase());
  for (const shown of shownAddresses(body.payment ?? {})) {
    const ok = shown.field === "uri" ? expected.some((e) => shown.value.includes(e)) : matches(shown.value);
    if (!ok)
      return { status: "unexpected_address", address: `${shown.field}: ${shown.value}`, invoiceId: body.id };
  }
  return { status: "ok", address, invoiceId: body.id };
}

if (import.meta.main) {
  const env = process.env;
  const [amount = "", currency = ""] = (env.CANARY_PRICE ?? "").split(" ");
  const missing = [
    "CANARY_API_URL",
    "CANARY_API_KEY",
    "CANARY_ASSET",
    "CANARY_PRICE",
    "CANARY_EXPECTED",
  ].filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`missing ${missing.join(", ")}`);
    process.exit(2);
  }
  const r = await runCanary({
    apiUrl: env.CANARY_API_URL ?? "",
    apiKey: env.CANARY_API_KEY ?? "",
    asset: env.CANARY_ASSET ?? "",
    amount,
    currency,
    expected: (env.CANARY_EXPECTED ?? "").split(","),
    now: new Date(),
    allowHttp: env.CANARY_ALLOW_HTTP === "1",
  });
  console.log(JSON.stringify(r));
  process.exit(r.status === "ok" ? 0 : r.status === "unexpected_address" ? 1 : 2);
}
