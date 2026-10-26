# Configuration

One JSON file, path in `NOCUSTODY_CONFIG`. It is validated strictly at startup: unknown keys, malformed addresses and
non-https provider URLs are errors. The schema is [src/app/config.ts](../src/app/config.ts); examples are in
[examples/](../examples/).

The file holds **no secrets**. Keys and tokens are referenced by the name of an environment variable
(`apiKeyEnv`, `secretEnv`, `botTokenEnv`, `database.urlEnv`).

Durations are strings like `500ms`, `30s`, `30m`, `1h`, `7d`. Amounts are decimal strings in the asset's units
(`"0.01"`), never JSON numbers.

## Pinned checksum

`NOCUSTODY_PINNED_SHA256` must equal the sha256 over the canonical form of `assets` (ids, networks, kinds, contracts,
decimals, receiving addresses with their status and jetton-wallets). Print it with the `config:hash` command. The gateway refuses to start on a mismatch, and
re-checks the file on every cycle: if it changes while running, new invoices are blocked and an
`address_pin_violation` alert is raised. There is no API or command that changes receiving addresses.

## `assets[]`

| Field | Default | Meaning |
|---|---|---|
| `id` | — | your identifier, used in the API (`usdt-tron`) |
| `network` | — | `tron:mainnet`, `tron:nile`, `ton:mainnet`, `ton:testnet` |
| `kind` | — | `token` (TRC-20, jetton) or `native` (GRAM, the native TON coin) |
| `contract` | — | token contract / jetton master; `null` for `native`. The asset is identified **only** by this value |
| `decimals` | — | token decimals (USDT: 6, GRAM: 9) |
| `symbol` | — | display only, never used to identify the asset |
| `priceSymbol` | — | symbol used for price conversion (`USDT`) |
| `strategy` | `unique-amount` | how payments are told apart: `unique-amount` per address, or `memo` (TON comment) with unique amount as a fallback |
| `addresses[]` | — | `{ address, status: active \| draining, jettonWallet? }`. New invoices use `active` addresses; `draining` ones are still watched. TON jettons need the owner's `jettonWallet`, verified with `get_wallet_address` at startup |
| `amounts.step` | — | unique-amount step added to the price (`"0.01"`) |
| `amounts.maxSlots` | — | parallel open invoices per address and base amount (1–999) |
| `amounts.dustThreshold` | `"0"` | incoming transfers below this are ignored (address poisoning) |
| `amounts.underpaymentTolerance` / `underpaymentToleranceBps` | `"0"` / `0` | underpayment still counted as paid: absolute amount / basis points of the invoice |
| `amounts.acceptLatePayments` | `true` | accept payments after `expires_at` but before `grace_until` (as `paid_late`) |
| `ttl` | `30m` | invoice lifetime |
| `grace` | `60m` | after expiry the (address, amount) slot or memo stays reserved this long |
| `amlThreshold` | `"0"` | payments below this complete without AML screening; `"0"` screens everything |

Mainnet USDT: TRON `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, TON jetton master
`EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` (6 decimals). Check them yourself against Tether's official
website and a block explorer before pinning.

## `tron` and `ton`

One section per network family, required when an asset uses it.

| Field | Default | Meaning |
|---|---|---|
| `network` | — | must match the assets' `network` |
| `apiUrl` | — | TronGrid (`https://api.trongrid.io`, `https://nile.trongrid.io`) or toncenter v3 (`https://toncenter.com`, `https://testnet.toncenter.com`) |
| `apiKeyEnv` | — | environment variable with the provider key |
| `startFrom` | — | ISO timestamp where scanning starts when there is no cursor yet |
| `pollInterval` | `10s` | scanner cycle |
| `overlap` | `10m` | each scan re-reads this much of the previous window |
| `timeout` | `10s` | per request |
| `maxResponseBytes` | `5000000` | larger responses are rejected |
| `minInterval` (TON) | `1100ms` | spacing between requests (toncenter allows 1 request/s without a key) |

## `api`

| Field | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | bind address (`0.0.0.0` inside a container) |
| `port` | `8080` | |
| `rateLimitPerMinute` | `120` | requests per minute per API key |
| `paymentPage.enabled` | `false` | hosted page at `/pay/{id}` ([payment-page.md](payment-page.md)) |
| `paymentPage.defaultLanguage` | `en` | `en`, `ru`, `fr`, `fa`, `zh-CN` |
| `paymentPage.publicRateLimitPerMinute` | `600` | shared limit for the public `/pay/*` routes |

API keys are created with the `apikey:create` command ([api.md](api.md)).

## `webhooks`

| Field | Default | Meaning |
|---|---|---|
| `url` | — | merchant endpoint |
| `secretEnv` | — | environment variable with the HMAC secret (separate from API keys) |
| `allowPrivateNetworks` | `false` | allow private and loopback targets (merchant on an internal network) |
| `allowHttp` | `false` | allow plain http; only together with a trusted private network |
| `timeout` | `10s` | |
| `maxAttempts` | `15` | then the event is dead-lettered (`webhook:retry-dead`) |
| `baseDelay` / `maxDelay` | `30s` / `6h` | retry delay doubles from `baseDelay` up to `maxDelay` |

## `pricing`

| Field | Default | Meaning |
|---|---|---|
| `currencies` | `[]` | ISO 4217 currencies accepted for invoice prices |
| `markupBps` | `{}` | per currency markup in basis points, e.g. `{ "EUR": 100 }` |
| `manualRates[]` | `[]` | `{ base, quote, rate, setAt, maxAge }`: 1 `base` = `rate` `quote`, set by you at `setAt`, refused after `maxAge`. Reverse and cross rates (up to 3 hops) are derived |

Prices in the asset's own `priceSymbol` need no rate. Amounts are converted with exact rational arithmetic and
rounded up to the asset's smallest unit.

## `ops`

Monitoring, reconciliation, depeg protection, alerts and AML: see [operations.md](operations.md).

| Field | Default |
|---|---|
| `alerts.cooldown`, `alerts.telegram { botTokenEnv, chatId }` | `30m`, off |
| `maxScannerLag { "<network id>": duration }` | TRON 5m, TON 2m |
| `candidateMaxAge` | `24h` |
| `reconcile { interval, lookback, settleDelay, tron, ton }` | off |
| `depeg { symbol, maxDeviationBps, interval, sources }` | off |
| `aml { provider: noop \| blocklist, blocklistFile }` | `noop` |

## `database`

`{ "urlEnv": "DATABASE_URL" }`: name of the variable with the PostgreSQL connection string.
