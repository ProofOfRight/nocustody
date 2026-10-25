# 0002. Watch-only (non-custodial) gateway

- Status: accepted
- Date: 2026-10-26

## Context

A compromised server must not mean stolen funds.

## Decision

The gateway never holds private keys, seeds or xprv — only addresses and xpubs. Funds go straight to merchant wallets whose keys stay offline. On TON this implies the "one wallet + invoice comment" model recommended by docs.ton.org.

## Consequences

No payouts, refunds or sweeps inside the system. Per-invoice addresses are only possible where they can be derived watch-only (xpub).
