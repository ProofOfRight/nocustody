# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).
Before 1.0, minor versions may contain breaking changes; they are listed under **Changed**.

## [0.1.0] - unreleased

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

[0.1.0]: https://github.com/ProofOfRight/nocustody/releases/tag/v0.1.0
