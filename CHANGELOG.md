# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).
Before 1.0, minor versions may contain breaking changes; they are listed under **Changed**.

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

[0.2.1]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.2.1
[0.2.0]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.2.0
[0.1.0]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.1.0
