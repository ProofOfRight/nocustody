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
| Receiving address substitution (server / admin / frontend compromise) | Addresses pinned in config with a checksum, verified at startup and on every cycle, alert on mismatch; no API to change addresses; canary on another host |
| Fake token / jetton / master contract | Contract / master taken from config, never from metadata; TON — our own jetton-wallet via `get_wallet_address` |
| Failed or reverted transaction ("Flash USDT") | Credit only final and successful transactions (TRON solidified + `SUCCESS`; TON masterchain, no bounce, not aborted) |
| Forged provider response | TLS only, finalized-state query, optional second source, reconciliation |
| Late payment settles someone else's invoice | (address, amount) slot / memo locked until `expires_at + grace` |
| Double crediting | `UNIQUE(network, tx_hash, log_index \| lt)`, DB transactions |
| Lost events on restart | Scanner cursor advances only after durable write; transactional outbox |
| Forged / replayed webhook to the merchant | HMAC over timestamp + event id + body; webhook secret separate from the API key |
| Dust / address poisoning | Threshold, ignore and log, merchant guidance in docs |
| Provider rate-limit exhaustion (dust spam) | Filters, limits, alerts, second key / provider |
| Issuer (Tether) freezes USDT on an address | Address pool, rotation, regular sweeps by the merchant, AML |
| Compromised npm dependency | Minimal dependencies, lockfile, `npm ci --ignore-scripts`, audit in CI ([ADR-0007](adr/0007-minimal-dependencies.md)) |
