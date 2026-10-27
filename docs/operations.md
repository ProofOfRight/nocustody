# Operations

## Processes

`node src/app/cli.ts run --roles api,worker,dispatcher,monitor` (default: all four). Roles can run in separate
processes or hosts against the same database. Run **one `worker` per network**: the client-side request spacing for
keyless providers lives in the process. Alert cooldowns and API rate limits are per process too (two monitors send
an alert twice; two `api` processes double the per-key limit).

| Role | Does |
|---|---|
| `api` | merchant REST API (bind to localhost, publish through a TLS reverse proxy) |
| `worker` | one loop per network at its `pollInterval`: scan candidates → verify finality → settle; a separate expiry loop. A slow or failing provider affects only its own network. Writes a heartbeat per network |
| `dispatcher` | delivers webhooks from the outbox; writes the `dispatcher` heartbeat |
| `monitor` | every minute: the pinned-config guard, scanner and dispatcher heartbeats, dead and overdue webhooks; reconciliation with a second source; depeg protection; retention (if configured); sends alerts |

`SIGTERM` finishes the current cycle of every loop and stops; a sleeping loop stops at once.

## Alerts

Always written to the log; optionally to Telegram (send-only bot, it never reads messages):

```json
"ops": { "alerts": { "cooldown": "30m", "telegram": { "botTokenEnv": "NOCUSTODY_TG_TOKEN", "chatId": "-100123456789" } } }
```

Repeats of the same condition are muted for `cooldown`. Alerts:

- `address_pin_violation` (critical) — the pinned parts of `config.json` changed on disk; new invoices are blocked;
- `scanner-lag:<network>` (critical) — no successful cycle for longer than `ops.maxScannerLag` (defaults: TRON 5 min,
  TON 2 min);
- `scanner-budget:<asset>` — rows were still unread after every scan of a cycle: more transactions than one cycle
  reads, the scanner is catching up (a burst on the address; it cannot freeze the cursor, but detection lags);
- `dispatcher-lag` (critical) and `webhooks-backlog` — with webhooks configured: the dispatcher has not completed a
  cycle, or an event has been due without delivery, for longer than `ops.maxDispatcherLag` (default 5 min);
- `webhooks-dead` — events in dead-letter (retry with `webhook:retry-dead [event-id]` after fixing the endpoint);
- `never-final:<network>/<tx>` — a candidate still not final (or its verification still failing)
  `ops.candidateMaxAge` (default 24 h) after its block time, or after we first saw it when that is later — rejected;
- `slots-exhausted:<asset>` (critical) — every active address is full for a price; merchants get
  `503 allocation.no_free_slot` until slots free up (add addresses or shorten `ttl` / `grace`);
- `reconcile-missed:<network>:<address>`, `reconcile-unknown:…`, `reconcile-truncated:…`, `reconcile-source:<name>` —
  reconciliation findings, partial answers and second-source failures;
- `depeg:<symbol>` block / unblock, `depeg:<symbol>:source` — one source failing.

Alerts are muted per key for `cooldown` in each process.

## Reconciliation with a second source

```json
"ops": { "reconcile": { "interval": "1h", "lookback": "3h", "settleDelay": "10m",
  "tron": { "apiUrl": "https://apilist.tronscanapi.com", "apiKeyEnv": "TRONSCAN_API_KEY" },
  "ton":  { "apiUrl": "https://tonapi.io", "apiKeyEnv": "TONAPI_KEY" } } }
```

Every interval the monitor asks an independent indexer (Tronscan, tonapi) for incoming transfers to each receiving
address in `[now − lookback, now − settleDelay]`:

- a transfer the primary scanner missed becomes a **candidate** and goes through the normal verifier — the second
  source never credits anything by itself; an alert is sent;
- a transfer we verified that the second source does not know is reported (investigate the providers);
- if the address had more transfers in the window than one run reads (Tronscan 500, tonapi 1000 transactions,
  newest first), the answer is partial: what it returned is still queued, the comparison is skipped and
  `reconcile-truncated` is sent. Shorten `lookback` or run more often.

Tronscan mainnet needs an API key; the testnets (`nileapi.tronscan.org`, `testnet.tonapi.io`) work without one.
For tonapi the key is sent as the `Authorization` header — set `apiKeyHeader` if your plan differs.

## Depeg protection

Off by default — no requests to exchanges unless configured:

```json
"ops": { "depeg": { "symbol": "USDT", "maxDeviationBps": 150, "interval": "5m", "sources": ["kraken", "coinbase"] } }
```

If any source reports USDT/USD further than `maxDeviationBps` from 1.00 (an exact comparison), or no source answers,
new invoices priced in that symbol are refused (`503 pricing.depeg_block`) until all sources are back in range.
The guard fails closed: with depeg protection configured, a missing reading or one older than three intervals (the
monitor is not running) refuses new invoices as well. Existing invoices are not affected. `symbol` must be the
`priceSymbol` of a configured asset.

## AML

```json
"ops": { "aml": { "provider": "blocklist", "blocklistFile": "/etc/nocustody/aml-blocklist.txt" } },
"assets": [{ "…": "…", "amlThreshold": "500" }]
```

- Payments whose total is below the asset's `amlThreshold` complete without screening; `"0"` screens everything.
- `noop` (default) clears everything; `blocklist` holds payments from senders listed in a local file (one address per
  line in any form the network accepts — TON user-friendly or raw, TRON base58 — optionally prefixed
  `network:address`, `#` comments) — no data leaves the server. A line that is not an address is a start-up error.
- A held invoice is `aml_hold`: access is not granted. Decide manually:
  `invoice:aml-resolve <id> approve|reject --note "…"`. Move held funds to a separate quarantine address yourself.
- A screening service that is unavailable leaves the invoice `aml_pending`; it is retried every cycle.
- Commercial screening services receive the sender address and transaction of every screened payment — state this in
  your privacy policy if you add one.

## Status

`node src/app/cli.ts ops:status` prints heartbeats (scanners, dispatcher), guards (depeg, with the time of the last
reading), invoices needing attention (`underpaid`, `aml_pending`, `aml_hold`), unmatched transfers, unverified
candidates and undelivered webhooks. `overpaid` and `paid_late` are events, not persisted statuses: look for them in
the webhook log or the audit log.

## Retention

Nothing is deleted unless `ops.retention` is configured:

```json
"ops": { "retention": { "deliveredWebhooks": "30d", "idempotencyKeys": "30d", "settledCandidates": "90d" } }
```

The monitor then deletes, once an hour, delivered outbox rows, idempotency keys and dust / rejected candidates older
than the given age. Invoices, payments, verified transfers and the audit log are kept forever by design: they are the
record of every crediting decision.

## Address canary

Run `tools/canary.ts` from **another host** every few minutes (cron). It creates a small invoice through the public
API and checks that every address a payer could see — `payment.address`, `payment.address_display` and the address
inside `payment.uri` — is one you expect, catching a tampered server, config or proxy. List every form your
addresses appear in (for TON both the raw `0:…` and the user-friendly form). The order id is random, so a tampered
server cannot recognise canary requests; https is required (`CANARY_ALLOW_HTTP=1` for a test stand).

```bash
CANARY_API_URL=https://pay.example.org CANARY_API_KEY=nck_... CANARY_ASSET=usdt-tron \
CANARY_PRICE="1 USDT" CANARY_EXPECTED=TYourAddress1,TYourAddress2 node tools/canary.ts
```

Exit codes: 0 ok, 1 unexpected address (alert immediately), 2 could not check. Use a key with `invoices:write` only.
Canary invoices simply expire.

## Funds (merchant responsibility)

The gateway never holds keys. Recommended practice: receiving addresses on a hardware wallet; sweep regularly to cold
storage you never publish; a separate quarantine address for `aml_hold` funds; copy withdrawal addresses only from
your wallet's address book (address poisoning); rotate receiving addresses (see below); refunds are made manually
from your wallet.

### Rotating a receiving address

An address's `status` is part of the pinned checksum, so each step below needs a new `NOCUSTODY_PINNED_SHA256`
(`config:hash`) and a restart.

1. Add the new address as `active` and mark the old one `draining`: new invoices go to the new address, the old one
   stays watched, so its open invoices can still be paid and late transfers are not missed.
2. Remove the old address only when it has no open invoices left (at least `ttl` + `grace` after step 1). An open
   invoice on an address that is no longer in the config stops the worker cycle (`invoice.address_unpinned`).

## External hosts

Only hosts present in your config are contacted:

| Host | When |
|---|---|
| `api.trongrid.io` / `nile.trongrid.io` | `tron` section |
| `toncenter.com` / `testnet.toncenter.com` | `ton` section |
| Tronscan API, tonapi | `ops.reconcile` |
| `api.kraken.com`, `api.exchange.coinbase.com` | `ops.depeg` |
| `api.telegram.org` | `ops.alerts.telegram` |
| your webhook endpoint | `webhooks` |
