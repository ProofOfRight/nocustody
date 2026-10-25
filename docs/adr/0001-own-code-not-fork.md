# 0001. Own code instead of forking an existing gateway

- Status: accepted
- Date: 2026-10-25

## Context

Audited candidates (BEpusdt, epusdt/GM Pay, TokenPay, SHKeeper, BTCPay + USDt, Bicycle, Spice harvester) either keep private keys on the server (SHKeeper, TokenPay, Bicycle), ship unsafe defaults and third-party servers in the money path (BEpusdt, epusdt), or lack TON (TokenPay, BTCPay). 

## Decision

Write the gateway from scratch. Knowledge of what to verify is carried over from the audit; code is not.

## Consequences

Payment page, invoices, rates, AML and reconciliation are built by us — they would have to be built anyway.
