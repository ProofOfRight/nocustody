# Laravel integration example

For Laravel 11 or later (PHP 8.2+), no extra Composer packages. Copy the files into your application and adapt the
lines marked `YOUR CODE`. The flow:

1. Checkout: the backend creates an invoice (`POST /v1/invoices`) and redirects the payer to the hosted payment page.
2. The gateway watches the chain and sends signed webhooks.
3. The webhook controller verifies the signature, records the event once and queues a job.
4. The job re-reads the invoice from the API and grants access on `completed`.

| File | Purpose |
|---|---|
| `config/nocustody.php` | settings from `.env` |
| `app/Services/Nocustody/NocustodyClient.php` | API client on Laravel's HTTP client; payment page URL |
| `app/Services/Nocustody/WebhookSignature.php` | signature check, framework-free (`php selftest.php`) |
| `app/Http/Controllers/NocustodyWebhookController.php` | webhook endpoint: verify, deduplicate, queue, `204` |
| `app/Jobs/HandleNocustodyEvent.php` | re-reads the invoice and acts on its status |
| `database/migrations/…_create_nocustody_tables.php` | order ↔ invoice mapping, received events |
| `routes/nocustody.php` | webhook route (without CSRF) and a checkout route |

## Setup

```dotenv
NOCUSTODY_API_URL=https://pay.internal.example     # merchant API, reachable only from the backend
NOCUSTODY_API_KEY=nck_...                          # apikey:create --scopes invoices:read,invoices:write
NOCUSTODY_PUBLIC_URL=https://pay.example.org       # public origin of /pay/{id}, if the hosted page is enabled
NOCUSTODY_WEBHOOK_SECRET=...                       # same value as the gateway's webhooks.secretEnv
```

```bash
php artisan migrate
php artisan queue:work      # the webhook job runs on the queue
```

Point the gateway's `webhooks.url` at `https://<shop>/nocustody/webhook`.

## Notes

- **Prices come from your order**, never from the request. Amounts are decimal strings (`"9.99"`), never floats.
- The order id is the `merchant_order_id` and, prefixed with `order-`, the `Idempotency-Key`: retrying checkout for
  the same order returns the same invoice. Keep order ids to `[A-Za-z0-9_.:-]` and at most 120 characters.
- **Grant access only in the job**, after `GET /v1/invoices/{id}` says `completed`, and make granting idempotent
  (the same event can be processed again after a crash).
- The events `invoice.underpaid`, `invoice.overpaid`, `invoice.paid_late`, `invoice.aml_hold` and
  `transfer.unmatched` need a person: the payer sent something other than the invoice asked for. Decide by the
  **event type**: a paid invoice goes through `aml_pending` to `completed` in the same cycle, so `paid`, `overpaid`
  and `paid_late` are not statuses you will read back. Refunds are manual, from the merchant's own wallet.
- Without the hosted page, show the payer `payment.address_display`, the exact `payment.amount` and, on TON,
  `payment.memo` from the invoice ([docs/api.md](../../docs/api.md)).
- The plain-PHP example in [examples/php](../php/) has the same signature check without Laravel.

`selftest.php` checks `WebhookSignature::verify()` against a vector produced by the gateway's own signer. The Laravel
classes are checked for syntax only (`php -l`); they were not run inside a Laravel application.
