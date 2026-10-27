# PHP integration example

Plain PHP 8.1+ with `ext-curl`, no Composer packages.

- `NocustodyClient.php` — create and read invoices (decimal strings, `Idempotency-Key`). It does not send
  `success_url` / `cancel_url`; add them to the request body if you use the hosted page's return buttons
  ([docs/api.md](../../docs/api.md)).
- `webhook.php` — receive events: verifies `X-Signature` over the raw body with `hash_equals`, rejects timestamps older
  than 5 minutes, runs each event id once under a file lock and records the id only after the work succeeded (the
  file-based store is for the example; in production keep processed event ids in your database, with the check and
  the insert in one transaction). Set `NOCUSTODY_WEBHOOK_LOG` to a file in a directory only the application can
  write, outside the web root and not in a shared `/tmp`.

```php
require 'NocustodyClient.php';
$client = new NocustodyClient('https://pay.internal.example', getenv('NOCUSTODY_API_KEY'));
$invoice = $client->createInvoice('order-1001', '9.99', 'USD', 'usdt-tron', 'order-1001');
// show $invoice['payment']['address_display'], $invoice['payment']['amount'] (exact) and, on TON, $invoice['payment']['memo']
```

`selftest.php` checks the signature verification against a vector produced by the gateway's own signer; the
end-to-end scenario (`npm run e2e:api`) runs `webhook.php` as the real receiver.
