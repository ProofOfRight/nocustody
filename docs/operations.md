# Operations

## Processes

`node src/app/cli.ts run --roles api,worker,dispatcher,monitor` (default: all four). Roles can run in separate
processes or hosts against the same database.

| Role | Does |
|---|---|
| `api` | merchant REST API (bind to localhost, publish through a TLS reverse proxy) |
| `worker` | per network: scan candidates → verify finality → settle; invoice expiry. Networks are isolated: a failing provider stops only its own network. Writes a heartbeat per network |
| `dispatcher` | delivers webhooks from the outbox |
| `monitor` | scanner heartbeats, dead webhooks, reconciliation with a second source, depeg protection; sends alerts |

## Alerts

Always written to the log; optionally to Telegram (send-only bot, it never reads messages):

```json
"ops": { "alerts": { "cooldown": "30m", "telegram": { "botTokenEnv": "NOCUSTODY_TG_TOKEN", "chatId": "-100123456789" } } }
```

Repeats of the same condition are muted for `cooldown`. Alerts:

- scanner lag — no successful cycle for longer than `ops.maxScannerLag` (defaults: TRON 5 min, TON 2 min);
- webhooks in dead-letter (retry with `webhook:retry-dead [event-id]` after fixing the endpoint);
- a candidate that is still not final `ops.candidateMaxAge` (default 24 h) after its block time — rejected;
- reconciliation findings and second-source failures;
- depeg block / unblock.

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
- a transfer we verified that the second source does not know is reported (investigate the providers).

Tronscan mainnet needs an API key; the testnets (`nileapi.tronscan.org`, `testnet.tonapi.io`) work without one.
For tonapi the key is sent as the `Authorization` header — set `apiKeyHeader` if your plan differs.

## Depeg protection

Off by default — no requests to exchanges unless configured:

```json
"ops": { "depeg": { "symbol": "USDT", "maxDeviationBps": 150, "interval": "5m", "sources": ["kraken", "coinbase"] } }
```

If any source reports USDT/USD further than `maxDeviationBps` from 1.00, or no source answers, new invoices priced in
that symbol are refused (`503 pricing.depeg_block`) until all sources are back in range. Existing invoices are
not affected.

## AML

```json
"ops": { "aml": { "provider": "blocklist", "blocklistFile": "/etc/nocustody/aml-blocklist.txt" } },
"assets": [{ "…": "…", "amlThreshold": "500" }]
```

- Payments whose total is below the asset's `amlThreshold` complete without screening; `"0"` screens everything.
- `noop` (default) clears everything; `blocklist` holds payments from senders listed in a local file (one address per
  line, optionally `network:address`, `#` comments) — no data leaves the server.
- A held invoice is `aml_hold`: access is not granted. Decide manually:
  `invoice:aml-resolve <id> approve|reject --note "…"`. Move held funds to a separate quarantine address yourself.
- A screening service that is unavailable leaves the invoice `aml_pending`; it is retried every cycle.
- Commercial screening services receive the sender address and transaction of every screened payment — state this in
  your privacy policy if you add one.

## Status

`node src/app/cli.ts ops:status` prints heartbeats, guards (depeg), invoices needing attention (`underpaid`,
`overpaid`, `paid_late`, `aml_pending`, `aml_hold`), unmatched transfers, unverified candidates and undelivered
webhooks.

## Address canary

Run `tools/canary.ts` from **another host** every few minutes (cron). It creates a small invoice through the public
API and checks that the address shown to payers is one you expect — catching a tampered server, config or proxy.

```bash
CANARY_API_URL=https://pay.example.org CANARY_API_KEY=nck_... CANARY_ASSET=usdt-tron \
CANARY_PRICE="1 USDT" CANARY_EXPECTED=TYourAddress1,TYourAddress2 node tools/canary.ts
```

Exit codes: 0 ok, 1 unexpected address (alert immediately), 2 could not check. Use a key with `invoices:write` only.
Canary invoices simply expire.

## Funds (merchant responsibility)

The gateway never holds keys. Recommended practice: receiving addresses on a hardware wallet; sweep regularly to cold
storage you never publish; a separate quarantine address for `aml_hold` funds; copy withdrawal addresses only from
your wallet's address book (address poisoning); rotate receiving addresses (mark the old one `draining` — it stays
watched); refunds are made manually from your wallet.

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
