# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).
Before 1.0, minor versions may contain breaking changes; they are listed under **Changed**.

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

[0.2.0]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.2.0
[0.1.0]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.1.0
