# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).
Before 1.0, minor versions may contain breaking changes; they are listed under **Changed**.

## [Unreleased]

### Added

- Receiving address status `retired` ([ADR-0037](docs/adr/0037-retired-receiving-addresses.md)): pinned, not used for
  new invoices, not watched, never shown to payers; its invoices stay readable and `invoice:aml-resolve` works on them.
  For a compromised address or one frozen by the token issuer. A transfer to it after retiring is not detected.
- `payment.address_available` in invoice responses.
- Alert `invoice-address-unpinned` (critical): an invoice that can still be paid points at an address missing from the
  config.
- The address canary ships in the image as `/app/dist/tools/canary.js` (moved from `tools/` to `src/tools/`), so it
  runs on another host from the same verified image digest; `scripts/smoke-image.sh` checks it. A layer rule keeps it
  on Node built-ins only.

### Changed

- An invoice whose stored address is not a pinned address of its asset no longer fails every read
  (`invoice.address_unpinned` is gone). It no longer stops invoice expiry and the worker cycle, and `GET /v1/invoices`,
  `GET /v1/invoices/{id}`, `invoice:show` and `invoice:aml-resolve` work on it. Its address is never shown:
  `payment.address`, `payment.address_display` and `payment.uri` are null, and the payment page shows no payment
  details. The same applies to invoices on a `retired` address.
- The worker refuses to start while an invoice that can still be paid points at an address removed from the config;
  with only closed invoices on it, it logs a warning. Mark such an address `retired` instead of deleting it.

## [0.5.1] - 2026-10-27

Examples and documentation only: no change to the gateway's code, schema, config or pinned checksum.

### Fixed

- `examples/mainnet.config.json` did not pass validation (`ton.minInterval: "200ms"` is below the 1 s minimum); the
  line is removed. A unit test now loads every `examples/*.config.json`.
- Laravel example: `HandleNocustodyEvent` decided "needs a person" by the re-read invoice status, so overpaid and late
  payments (already `completed` when re-read) never reached support; it now decides by the event type.
- `docs/deployment.md`: the separate-roles example lost `NOCUSTODY_CONFIG`, the runtime database role and the port;
  it is now a `compose.override.yaml` with `extends`.
- Documentation brought in line with the code: OpenAPI response codes and patterns, webhook `data` fields per event,
  return URLs only with the page enabled, address rotation (removing an address also breaks reading its past
  invoices), depeg unblocking, AML blocklist mounting, the going-live checklist, payment-page polling, required config
  sections, ADR statuses.

### Added

- [ADR-0036](docs/adr/0036-fixed-hosts-for-optional-services.md): the depeg sources and Telegram alerts use fixed,
  documented hosts that config enables; `docs/security.md` states the rule accordingly.

## [0.5.0] - 2026-10-27

The invoice keeps a price given in the asset itself (breaking: `price` is no longer `null` for it). No migration,
no config or pinned-checksum change.

### Changed

- **Breaking:** an invoice priced in the asset's own price symbol (e.g. `{"amount": "3.00", "currency": "USDT"}` for
  `usdt-tron`) now keeps its price: `price` is `{amount, currency}` exactly as sent, with `rate`, `rate_source`,
  `rate_at` and `rate_path` set to `null`, instead of `price: null`. Merchants can compare `price` with the order
  before crediting it, whatever the currency. `price` stays `null` for such invoices created before this version.
  `GET /v1/quotes` returns a `price` object for these prices as well.

### Fixed

- `merchant_order_id` idempotency for a price in the asset: a retry is compared with the stored price in minimal
  units (`"3"` and `"3.00"` are the same price). Before, any price that fit the unique-amount steps of the invoice
  amount counted as the same order (a retry with 10.01 USDT returned the 10.02 USDT invoice of a 10 USDT order).

## [0.4.0] - 2026-10-27

Hosted payment page: new look and return URLs to the merchant's website. Migration 0006 (two nullable columns)
runs automatically. New optional config key `api.paymentPage.returnOrigins`; it is not pinned, so the pinned checksum
stays the same.

### Added

- Return URLs: `POST /v1/invoices` takes optional `success_url` and `cancel_url` (https, on an origin from
  `api.paymentPage.returnOrigins`, otherwise `422 return_url_not_allowed`); the hosted page shows a "Back to the
  merchant's website" link, never redirects by itself ([ADR-0035](docs/adr/0035-payment-return-urls.md)).
- Hosted page: once the payment is received it tells the payer they may close the page.

### Changed

- Hosted page: new look (card layout, status plates, larger touch targets); light theme only, the dark theme is
  dropped for now.

## [0.3.2] - 2026-10-27

Backlog of the 2026-10-26 audit. No migration, no config or pinned-checksum change.

### Added

- `GET /v1/invoices` pages past the newest 100 invoices: the response carries `next_before`, passed back as `before`
  for the next page (keyset on `created_at`, `id`; stable while new invoices arrive).
- `make check-untrusted` / `make install-untrusted`: someone else's code — a pull request, a dependency update — runs
  in a sandbox without network, keys or write access to the repository ([ADR-0034](docs/adr/0034-untrusted-code-sandbox.md),
  CONTRIBUTING.md "Reviewing pull requests").

### Security

- Release: the job that holds the signing identity no longer runs repository code, npm or BuildKit; the workflow is
  `build` → `attest` → `publish` ([ADR-0033](docs/adr/0033-release-isolated-signing.md)). Operators verify the
  same way as before.
- The invoice refuses a payment whose recipient is not its payment address (`invoice.recipient`), whatever the
  matching strategy decided.

### Fixed

- Scanner: after a fully read scan with many candidates the scanner re-read the overlap window up to five times per
  cycle; adapters now report `more` and the scanner follows it. The `scanner-budget` alert fires only when rows are
  still unread after the last scan of a cycle.
- `allocation.bad_memo` (a broken memo generator) was answered as 422; it is 500 now. Every application error code
  has an explicit HTTP status.
- The payer's comment is stored with the transaction candidate (`tx_candidates.memo` was never written).
- PHP example: a webhook event is processed once under a file lock and its id is recorded only after the work
  succeeded; `NOCUSTODY_WEBHOOK_LOG` is required instead of defaulting to the shared temporary directory.

### Changed

- AML screening is its own step after settlement (`ScreenPayments`); a screening vendor is added there, not inside
  settlement. Cycle statistics report it as `screen`.
- Adapter interface: `ChainAdapter.validateAddress` is removed (addresses are validated when the config is loaded),
  `displayName` is required (the network name on the payment page), `FetchResult.more` replaces `exhausted`.
- The audit skill's scan flags image digests Dependabot does not update when they drift or age.

## [0.3.1] - 2026-10-26

**Upgrade note** for deployments from `deploy/compose.yaml`: add `NOCUSTODY_DB_PASSWORD` to `.env` and copy
`deploy/db-roles.sql` next to `compose.yaml`; the gateway then connects as its own role
([database roles](docs/deployment.md#database-roles)).

### Security

- TON: anyone could stop the TON scanner by sending our jetton-wallet a few messages with large bodies (up to
  256 KiB each): a page of them exceeded the provider response limit and the scan failed on every cycle. The page
  now shrinks until the answer fits.
- The example deployment runs the gateway as `nocustody_app`: no DDL, no superuser, and `audit_log`,
  `invoice_payments` and `observed_transfers` cannot be rewritten or deleted; the owner password no longer reaches
  the gateway container. The variable `NOCUSTODY_DB_PASSWORD` may not be used as a provider key.

### Fixed

- Reconciliation: when a second source returned only part of the window (more transfers than its page budget), the
  credited transfers it left out were reported as `reconcile-unknown`. The comparison is now skipped with a
  `reconcile-truncated` alert; Tronscan is asked for the window end too.
- Provider integers beyond 2^53 (tonapi GRAM values) are parsed exactly as bigint instead of being rounded.
- Laravel example: a webhook event recorded while the queue was down was never processed (the retry found the row
  and queued nothing). The job is queued while the event is unprocessed, runs once under a row lock, and a
  scheduled task re-queues events left behind.

## [0.3.0] - 2026-10-26

Results of the first full project audit (code, tests, security). **Upgrade note:** the pinned checksum changed
([ADR-0031](docs/adr/0031-pinned-config-scope.md)): run `config:hash` again and update `NOCUSTODY_PINNED_SHA256`
before starting this version; migration 0005 runs automatically.

### Security

- TON: a transfer whose text comment contained a control character (U+0000) made the verifier fail on it every
  cycle, so nothing on the TON network was settled any more (about 0.003 TON for an attacker). Such comments are
  treated as absent; a candidate whose result cannot be stored no longer stops the batch.
- A transfer that landed before an invoice existed can no longer be credited to an invoice opened within 30 s after
  it with the same amount: the early-payment tolerance is 5 s ([ADR-0030](docs/adr/0030-early-payment-tolerance.md)),
  and slots are handed out starting at a random position.
- The pinned checksum now covers provider endpoints, amount policies, pricing, AML, depeg and the webhook URL; the
  guard runs every minute in the monitor and alerts through Telegram; an invoice whose stored address is not a pinned
  address of its asset is refused when read; a provider key variable may not name another secret.
- A burst of transactions larger than one scan's page budget could freeze a network's cursor for good while the
  heartbeat stayed green; the scanner now guarantees progress and alerts.
- Depeg protection fails closed: with it configured, a missing or stale reading blocks new invoices; the deviation
  is compared exactly (150.9 bps was rounded to 150 and let through).
- AML blocklist entries are parsed per network: a TON address in user-friendly form never matched before.
- The address canary checks `address_display` and the wallet URI as well, uses a random order id and requires https.
- API: tokens not shaped like a key are refused before the database is asked; a concurrent create with the same
  `Idempotency-Key` and another body is refused; malformed request targets are 400, not logged 500s; the integrity
  reason (config path) no longer reaches API clients.
- Payment page: an invoice that can no longer be paid shows its status only, without address or QR code.
- Webhooks: one attempt is bounded as a whole (a trickling endpoint could hold the dispatcher for hours); the outbox
  lease covers the whole batch (two dispatchers double-sent); a resolver failure is retried instead of dead-lettered;
  more special IP ranges are refused.
- Release workflow: only commits on `main`, never over an existing version, the pushed digest is smoke-tested.
  CI runs the PHP examples; CODEOWNERS covers the edge, the schema and the examples; Dependabot waits a week.

### Fixed

- A PostgreSQL restart crashed the process (no handler for idle pool client errors).
- `candidateMaxAge` is counted from the first time the scanner saw a candidate when its block time is older, so a
  catch-up after downtime cannot reject real payments; candidates whose verification keeps failing age out too.
- A GRAM transfer with an encrypted comment was invisible (no candidate, no unmatched event); it is a payment
  without memo now. A provider answer about another transaction is retried, not a final rejection.
- A transaction with several transfers to us is hinted with its largest one; a later non-dust hint re-queues a
  candidate stored as dust; candidates are per asset (migration 0005).
- A zero-value transfer is dust whatever the threshold (TRON address-poisoning spam produced `transfer.unmatched`
  webhooks).
- An existing merchant order is answered before quoting, so a stale manual rate no longer turns a retry into 503.
- Two workers no longer write two `transfer.unmatched` events for one transfer.
- SIGTERM stops within the grace period (loop sleeps are interruptible); `ops:status` and `apikey:revoke` no longer
  need the TON provider to be reachable.
- `since` accepts an RFC 3339 offset; the OpenAPI error-code list is complete; duplicate on-chain assets, a depeg
  symbol no asset uses, zero and overflowing durations are refused.

### Added

- One worker loop per network; dispatcher heartbeat; alerts `dispatcher-lag`, `webhooks-backlog`, `scanner-budget`,
  `slots-exhausted`, `address_pin_violation` through the router.
- `ops.retention` (off by default) prunes delivered webhooks, idempotency keys and settled candidates.
- `ops.maxDispatcherLag`; migrations marked `-- no-transaction` run statement by statement (`CREATE INDEX
  CONCURRENTLY`).
- Contract tests: statuses and event types against the migrations, OpenAPI and `docs/api.md`; routes against OpenAPI.

### Changed

- `paid`, `overpaid` and `paid_late` are documented as events, not readable statuses; the Laravel example decides by
  event type; `ops:status` lists only statuses that persist.
- `invoice.cancelled` and price lists are documented as reserved / planned.

## [0.2.1] - 2026-10-26

Operations did not run in 0.1.0 and 0.2.0: upgrade.

### Fixed

- The `monitor` role (scanner lag alerts, reconciliation with a second source, depeg guard) was not started by
  `run`, and `run --roles monitor` was refused as an unknown role. It is now accepted and part of the default roles.
- Webhook delivery hung for good when the merchant's endpoint answered with a body over 64 KiB; the result is now
  recorded before the oversized response is dropped.
- A stored invoice or transfer whose asset is no longer configured made every scanner, verifier and settlement cycle
  fail; such rows are now skipped, and reading one through the API answers `422 asset.unknown` instead of `500`.
- One failing transfer or AML screening no longer aborts the whole settlement batch; it is counted and logged.
- Two concurrent `POST /v1/invoices` for the same merchant order no longer fail one of them; both get the invoice
  that was created.
- A malformed `%`-escape in a path parameter answers `400 invalid_request` instead of `500`.

### Changed

- `POST /v1/invoices` for an existing `merchant_order_id` with a different price, currency or asset is refused with
  `409 invoice.order_mismatch`; before, the existing invoice was returned silently.
- An API key's `last_used_at` is recorded on every authenticated request.

## [0.2.0] - 2026-10-26

Fixes TON jetton payments that were never detected. Do not use 0.1.0 with TON jettons; upgrade to this release.

### Fixed

- TON: jetton payments sent with `forward_ton_amount = 0` were never detected. The jetton wallet sends the owner no
  `transfer_notification` in that case (TEP-74), and the scanner relied on it. Jetton payments are now read from the
  transactions of the pinned jetton-wallet (`internal_transfer`), by the scanner and by tonapi reconciliation alike.
  Found with a read-only mainnet replay of real payments.

### Added

- `make e2e-mainnet`: read-only check against TRON and TON mainnet that replays real, recent, finalized USDT payments
  through the scanner, the finality verifier and settlement. No funds or keys involved.
- `examples/mainnet.config.json` and a [going-live checklist](docs/going-live.md).
- Laravel integration example (`examples/laravel`).
- Offline verification of release attestations when Sigstore is unreachable ([deployment.md](docs/deployment.md)).

### Changed

- TON jetton transfers are identified by the jetton-wallet transaction (hash and lt) instead of the owner's
  notification transaction. Upgrading from 0.1.0 with TON jetton assets: do it while no TON jetton invoice is
  `underpaid`. A payment already seen by 0.1.0 within the scanner overlap window (default 10 minutes) is seen again
  under the new key; a completed invoice does not accept it, so it is reported as `transfer.unmatched`.

## [0.1.0] - 2026-10-26

First release. Verified end to end with real TRON Nile and TON testnet transactions; **not yet run against
mainnet**; start with small amounts.

### Added

- Invoices priced in any ISO 4217 currency or directly in the asset, with manual rates, cross rates and markup;
  exact rational arithmetic, amounts rounded up to the smallest unit.
- TRON: USDT (TRC-20) through TronGrid, every transfer re-checked with a solidified-state query.
- TON: USDT jetton and GRAM (the native coin) through toncenter v3, finalized transactions only, jetton-wallet binding verified
  with `get_wallet_address`; payments matched by memo with a unique-amount fallback.
- Receiving addresses and contracts pinned in config with a checksum, checked at startup and on every cycle.
- Merchant REST API (OpenAPI), API keys stored as hashes with scopes, idempotency keys, per-key rate limits.
- Webhooks through a transactional outbox: HMAC signatures, retries with backoff, dead-letter, SSRF protection;
  PHP example client and receiver.
- Operations: scanner heartbeats, reconciliation with a second source (Tronscan, tonapi), USDT depeg guard, alerts
  to the log and Telegram, AML port with a blocklist provider, address canary.
- Optional hosted payment page without external resources: QR code, wallet deeplink, five languages including
  right-to-left, strict CSP.
- Production container image (`FROM scratch`, non-root, no shell), example `docker compose` deployment,
  reproducible multi-arch builds, signed build provenance and SPDX SBOM attestations.

[0.5.1]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.5.1
[0.5.0]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.5.0
[0.4.0]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.4.0
[0.3.2]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.3.2
[0.3.1]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.3.1
[0.3.0]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.3.0
[0.2.1]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.2.1
[0.2.0]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.2.0
[0.1.0]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.1.0
