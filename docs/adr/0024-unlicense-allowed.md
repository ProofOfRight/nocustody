# 0024. Unlicense allowed; TON libraries `@ton/core` and `@ton/crypto`

- Status: accepted
- Date: 2026-10-26

## Context

The TON adapter parses BOC cells and addresses with the official `@ton/core` (MIT, no dependencies), as anticipated
in [ADR-0015](0015-thin-chain-clients.md): hand-written cell parsing in payment code is riskier than the official
library. `@ton/core` has a peer dependency on `@ton/crypto` (MIT), which brings `jssha` (BSD-3-Clause),
`@ton/crypto-primitives` (MIT) and `tweetnacl` (Unlicense). The Unlicense is a permissive public-domain dedication
approved by the OSI and compatible with Apache-2.0, but it was not on the allowlist of
[ADR-0006](0006-apache-2-clean-room.md).

## Decision

Add `@ton/core` 0.63.1 and `@ton/crypto` 3.3.0 as runtime dependencies (four packages in total, no install
scripts). Add `Unlicense` to the license allowlist for runtime and dev dependencies.

## Consequences

Amends [0006](0006-apache-2-clean-room.md). Signing primitives from `tweetnacl` are installed but never used:
the gateway holds no keys ([ADR-0002](0002-watch-only.md)). This ADR finalises the TON part of
[ADR-0015](0015-thin-chain-clients.md).
