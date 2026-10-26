// SPDX-License-Identifier: Apache-2.0
// Address canary — run it from ANOTHER host (cron), not from the gateway server. It creates a small invoice through
// the public API and checks that the payment address shown to payers is one of the addresses you expect. If the
// gateway server, its config or the reverse proxy were tampered with to show an attacker's address, this fails.
//
//   CANARY_API_URL=https://pay.example.org CANARY_API_KEY=nck_... \
//   CANARY_ASSET=usdt-tron CANARY_PRICE="1 USDT" CANARY_EXPECTED=Taddr1,Taddr2 node tools/canary.ts
// Exit code 0 = ok, 1 = unexpected address (alert!), 2 = could not check. Uses only the Node standard library.

export interface CanaryInput {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly asset: string;
  readonly amount: string;
  readonly currency: string;
  readonly expected: readonly string[];
  readonly now: Date;
}

export type CanaryResult =
  | { readonly status: "ok"; readonly address: string; readonly invoiceId: string }
  | { readonly status: "unexpected_address"; readonly address: string; readonly invoiceId: string }
  | { readonly status: "error"; readonly error: string };

export async function runCanary(i: CanaryInput, fetchFn: typeof fetch = fetch): Promise<CanaryResult> {
  const order = `canary-${i.now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 12)}`;
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
  const body = (await res.json()) as { id?: string; payment?: { address?: string } };
  const address = body.payment?.address;
  if (!address || !body.id) return { status: "error", error: "response has no payment address" };
  const expected = new Set(i.expected.map((a) => a.trim().toLowerCase()));
  return expected.has(address.toLowerCase())
    ? { status: "ok", address, invoiceId: body.id }
    : { status: "unexpected_address", address, invoiceId: body.id };
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
  });
  console.log(JSON.stringify(r));
  process.exit(r.status === "ok" ? 0 : r.status === "unexpected_address" ? 1 : 2);
}
