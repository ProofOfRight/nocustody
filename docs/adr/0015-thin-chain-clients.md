# 0015. Thin in-house chain clients; official libraries only where parsing is risky

- Status: accepted
- Date: 2026-10-26

## Context

Full SDKs are heavy dependency trees; the TRON adapter needs only two HTTP endpoints.

## Decision

TRON: own client over `fetch` + zod, base58check via `node:crypto` sha256 and a small in-house base58; no TronWeb. TON: official `@ton/core` for BOC and address parsing (final decision at stage 3).

## Consequences

More code to test on our side for TRON; contract tests on recorded fixtures are mandatory.
