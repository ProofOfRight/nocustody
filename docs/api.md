# Merchant API and webhooks

The API is described in [api/openapi.yaml](api/openapi.yaml). This page covers what the schema cannot.

## Deployment

The API binds to `127.0.0.1:8080` by default (`api.host`, `api.port`). Publish it only through a reverse proxy with
TLS. It is plain `node:http` without a framework (ADR-0025): JSON only, bodies up to 16 KiB, responses carry
`Cache-Control: no-store`. There is no admin interface and no endpoint that changes receiving addresses.

## API keys

```bash
docker compose run --rm -e NOCUSTODY_CONFIG -e NOCUSTODY_PINNED_SHA256 dev node src/app/cli.ts apikey:create --name shop --scopes invoices:read,invoices:write,quotes:read
```

The token (`nck_<id>_<secret>`) is printed once; only a SHA-256 of the secret is stored. Revoke with
`apikey:revoke <id>`, list with `apikey:list`. Scopes: `invoices:read`, `invoices:write`, `quotes:read`.
Requests are rate-limited per key (`api.rateLimitPerMinute`).

## Creating invoices

`POST /v1/invoices` requires an `Idempotency-Key` header. Retrying with the same key and the same body returns the
same invoice; the same key with a different body is refused (`422 idempotency_mismatch`). `merchant_order_id` is
unique as well: a second request for the same order returns the existing invoice (`200`) when the price, currency
and asset are the same, and is refused with `409 invoice.order_mismatch` when they differ. Amounts are compared in
minimal units, so `"3"` and `"3.00"` are the same price.

The invoice keeps the price in `price`: `amount` and `currency` exactly as you sent them, plus the locked rate
(`rate`, `rate_source`, `rate_at`, `rate_path`). A price in the asset's price symbol (e.g. `USDT` for `usdt-tron`)
is not converted, so its rate fields are `null`. Before crediting an order, re-read the invoice and compare
`price.amount` and `price.currency` with the order. `price` is `null` only for invoices priced in the asset that
were created before 0.5.0.

Show the payer `payment.address_display`, `payment.amount` (exact — the amount may include a small unique add-on)
and, on TON, `payment.memo` as the transfer comment. `payment.uri` is a wallet deep link where one exists. Or send
the payer to the hosted page `payment.page` if it is enabled ([payment-page.md](payment-page.md)).
If the operator retired the invoice's address ([ADR-0037](adr/0037-retired-receiving-addresses.md)),
`payment.address_available` is false and `payment.address`, `payment.address_display` and `payment.uri` are null: the
invoice must not be paid any more. A newly created invoice always has its address.

Optional `success_url` and `cancel_url` give the hosted page a "Back to the merchant's website" link: `success_url`
once the payment is received, `cancel_url` until then. They must be https on an origin listed in
`api.paymentPage.returnOrigins`, otherwise the request is refused with `422 return_url_not_allowed`; with the page
disabled (`api.paymentPage.enabled: false`) every return URL is refused. A retry for the
same `merchant_order_id` with other URLs returns the existing invoice with the URLs it was created with.

**A visit to `success_url` is not a payment.** Anybody can open that URL. Credit the order only from the
`invoice.paid` / `invoice.completed` webhook or from `GET /v1/invoices/{id}`.

## Listing invoices

`GET /v1/invoices` returns up to `limit` (≤ 100) invoices, newest first, filtered by `status` and `since`. For the
next page pass the response's `next_before` back as `before` with the same filters; `next_before` is null on the
last page. The cursor is opaque and stable while new invoices arrive (they appear on the first page, not between
pages).

## Webhooks

Configure one endpoint:

```json
"webhooks": { "url": "https://shop.example/hooks/nocustody", "secretEnv": "NOCUSTODY_WEBHOOK_SECRET" }
```

The secret (at least 32 characters, e.g. `openssl rand -hex 32`) is separate from API keys and is never sent.

Each event is a `POST` with a JSON body:

```json
{ "id": "6f1c7c1e-…", "type": "invoice.paid", "created_at": "2026-10-26T12:00:00.000Z",
  "data": { "object_id": "<invoice id>", "amount": "10.010000", "received": "10.010000",
            "transfer_key": "tron:mainnet/<tx>/<log index>", "…": "…" } }
```

and headers `X-Event-Id`, `X-Timestamp` (Unix seconds) and
`X-Signature: v1=<hex HMAC-SHA256(secret, X-Timestamp + "." + X-Event-Id + "." + raw body)>`.

The receiver must:

1. compute the HMAC over the **raw** body and compare it in constant time (`hash_equals`, `crypto.timingSafeEqual`);
2. reject timestamps older than 5 minutes;
3. process each `id` once — delivery is at-least-once;
4. answer `2xx` quickly and do the work asynchronously. Anything else is retried with exponential backoff
   (30 s, 1 min, 2 min, … up to 6 h, 15 attempts by default), then the event is dead-lettered and recorded in the
   audit log. A delivery refused by the SSRF policy (below) is dead-lettered at once, without retries.

Event types: `invoice.created`, `invoice.transfer_detected`, `invoice.paid`, `invoice.underpaid`, `invoice.overpaid`,
`invoice.paid_late`, `invoice.expired`, `invoice.cancelled` (reserved: nothing cancels an invoice yet),
`invoice.aml_pending`, `invoice.aml_hold`, `invoice.completed`, `invoice.rejected`, `transfer.unmatched`
(`object_id` is the transfer).

`data` always has `object_id`; the other fields by event:

| Event | Fields besides `object_id` |
|---|---|
| `invoice.created` | `merchant_order_id`, `address`, `amount`, `asset`, `expires_at` |
| `invoice.transfer_detected` | `transfer_key` |
| `invoice.paid`, `invoice.underpaid`, `invoice.overpaid`, `invoice.paid_late` | `transfer_key`, `amount` (this transfer), `received` (total), `expected`, `classification` (`exact`, `under_tolerated`, `under`, `over`), `late` |
| `invoice.aml_hold` | `reason` |
| `invoice.expired`, `invoice.cancelled`, `invoice.aml_pending`, `invoice.completed`, `invoice.rejected` | — |
| `transfer.unmatched` | `reason`, `amount`, `to`, `from`, `asset` |

A webhook tells you *when* to look, not *what* to do: grant access only after `GET /v1/invoices/{id}` answers
`completed` (`invoice.completed` is the event to react to), never from the webhook body alone. A paid invoice goes
through `aml_pending` to `completed` in the same cycle even with the default `noop` screener, so `paid`, `overpaid` and
`paid_late` are events you receive, not statuses you will read back; an overpayment or late payment is visible in the
event type and in the invoice's `received` versus `payment.amount`. Use a distinct webhook secret per gateway
instance (testnet and mainnet): a signed event from one instance must not verify on the other.

SSRF protection: the endpoint host is resolved and every address is checked; private, loopback, link-local and
other special ranges are refused unless `webhooks.allowPrivateNetworks` is `true`. Plain `http` needs
`webhooks.allowHttp`. Redirects are not followed.

Integration examples: plain PHP in [examples/php](../examples/php/), Laravel in [examples/laravel](../examples/laravel/).
