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
unique as well: a second request for the same order returns the existing invoice.

Show the payer `payment.address_display`, `payment.amount` (exact — the amount may include a small unique add-on)
and, on TON, `payment.memo` as the transfer comment. `payment.uri` is a wallet deep link where one exists. Or send
the payer to the hosted page `payment.page` if it is enabled ([payment-page.md](payment-page.md)).

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
   audit log.

Event types: `invoice.created`, `invoice.transfer_detected`, `invoice.paid`, `invoice.underpaid`, `invoice.overpaid`,
`invoice.paid_late`, `invoice.expired`, `invoice.cancelled`, `invoice.aml_pending`, `invoice.aml_hold`,
`invoice.completed`, `invoice.rejected`, `transfer.unmatched` (`object_id` is the transfer). Grant access on
`invoice.completed` (or on `invoice.paid` if AML screening is not used); always re-read the invoice with
`GET /v1/invoices/{id}` before acting if in doubt.

SSRF protection: the endpoint host is resolved and every address is checked; private, loopback, link-local and
other special ranges are refused unless `webhooks.allowPrivateNetworks` is `true`. Plain `http` needs
`webhooks.allowHttp`. Redirects are not followed.

Integration examples: plain PHP in [examples/php](../examples/php/), Laravel in [examples/laravel](../examples/laravel/).
