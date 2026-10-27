# 0009. Independent "final + successful" verification before crediting

- Status: accepted
- Date: 2026-10-26

## Context

Indexers can return non-final or failed transactions; audited gateways credited at 0 confirmations.

## Decision

The indexer only supplies candidates. Truth comes from a finalized-state query (TRON `walletsolidity`, TON masterchain). An optional second provider only
supplies more candidates for the same check (reconciliation, [ADR-0031](0031-pinned-config-scope.md)); it never credits.

## Consequences

Two requests per candidate; adapter checklist requires this ([CONTRIBUTING.md](../../CONTRIBUTING.md)).
