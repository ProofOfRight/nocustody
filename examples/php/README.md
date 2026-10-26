# PHP integration example

Plain PHP 8.1+ with `ext-curl`, no Composer packages.

- `NocustodyClient.php` — create and read invoices (decimal strings, `Idempotency-Key`).
- `webhook.php` — receive events: verifies `X-Signature` over the raw body with `hash_equals`, rejects timestamps older
  than 5 minutes, ignores repeated event ids (the file-based store is for the example; in production keep processed
  event ids in your database, with the check and the insert in one transaction).

```php
require 'NocustodyClient.php';
$client = new NocustodyClient('https://pay.internal.example', getenv('NOCUSTODY_API_KEY'));
$invoice = $client->createInvoice('order-1001', '9.99', 'USD', 'usdt-tron', 'order-1001');
// show $invoice['payment']['address_display'], $invoice['payment']['amount'] (exact) and, on TON, $invoice['payment']['memo']
```

`selftest.php` checks the signature verification against a vector produced by the gateway's own signer; the
end-to-end scenario (`npm run e2e:api`) runs `webhook.php` as the real receiver.
