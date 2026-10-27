# Threat model

Starting list of threats and mitigations for the gateway. Requirements contributors must follow are in
[security.md](security.md).

## Assets

- Merchant funds on receiving addresses (the gateway holds **no** keys — see [ADR-0002](adr/0002-watch-only.md)).
- Integrity of the receiving-address list shown to payers.
- Correctness of "invoice is paid" decisions and the events delivered to the merchant.
- API keys and webhook secrets.

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Receiving address substitution (server / admin / frontend compromise) | Addresses, contracts, providers and money policies pinned in config with a checksum ([ADR-0031](adr/0031-pinned-config-scope.md)), verified at startup, before every invoice and every minute, alert on mismatch; a stored invoice address outside the pinned list is refused; no API to change addresses; canary on another host checks every form a payer sees |
| Fake token / jetton / master contract | Contract / master taken from config, never from metadata; TON — our own jetton-wallet via `get_wallet_address` |
| Failed or reverted transaction ("Flash USDT") | Credit only final and successful transactions (TRON solidified + `SUCCESS`; TON masterchain, no bounce, jetton-wallet transaction not aborted; native coin: the credited amount of the credit phase, no outgoing messages) |
| Forged provider response | TLS only, finalized-state query, optional second source, reconciliation |
| Late payment settles someone else's invoice | (address, amount) slot / memo locked until `expires_at + grace`; allocation starts at a random slot, so a pair just released is rarely handed out next. Residual risk: a payment after grace for an old invoice meets a newer invoice that holds the same pair; a 5 s early-payment tolerance keeps a transfer that landed before an invoice from being claimed by it ([ADR-0030](adr/0030-early-payment-tolerance.md)) |
| Double crediting | `UNIQUE(network, tx_hash, log_index \| lt)`, DB transactions |
| Lost events on restart | Scanner cursor advances only after durable write; transactional outbox |
| Forged / replayed webhook to the merchant | HMAC over timestamp + event id + body; webhook secret separate from the API key |
| Dust / address poisoning | Zero-value transfers always ignored, threshold for the rest, ignore and log, merchant guidance in docs |
| Provider rate-limit exhaustion (dust spam) | Filters, limits, alerts (`scanner-lag`); the operator switches to another key or provider in config |
| Stalling the scanner with oversized transactions (anyone can send our TON jetton-wallet messages with bodies up to 256 KiB) | Response size limit per request; the TON scan halves its page until the answer fits instead of failing every cycle; a scanner that stops advancing raises an alert |
| Issuer (Tether) freezes USDT on an address | Address pool, rotation, regular sweeps by the merchant, AML |
| Compromised npm dependency | Minimal dependencies, lockfile, `npm ci --ignore-scripts`, audit in CI ([ADR-0007](adr/0007-minimal-dependencies.md)) |
| Tampered release image (registry, build host or maintainer machine) | Images built only by the release workflow from a tag; signed SLSA provenance and SBOM attestations checked with `gh attestation verify`; reproducible builds; base images and BuildKit pinned by digest ([ADR-0029](adr/0029-release-provenance.md)) |
| Code execution inside the gateway container | `FROM scratch` image without shell or package manager, non-root, read-only root filesystem, no capabilities, config mounted read-only ([ADR-0028](adr/0028-container-image.md)); no keys to steal; the example deployment connects it as a database role without DDL rights that cannot rewrite or delete the payment history, and keeps the owner password out of its environment ([deployment.md](deployment.md#database-roles)); the canary on another host detects substituted addresses |
| Script injection or framing on the hosted payment page | Off by default; no external resources, CSP with a per-response nonce, `frame-ancestors 'none'`, all values escaped; the public status route exposes no order or payer data ([ADR-0027](adr/0027-hosted-payment-page.md)) |
