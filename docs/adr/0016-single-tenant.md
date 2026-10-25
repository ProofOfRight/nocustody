# 0016. Single-tenant installations

- Status: accepted
- Date: 2026-10-26

## Context

Multi-tenancy complicates the security model (per-merchant pinned addresses, cross-tenant leakage).

## Decision

One installation serves one merchant; several merchants run several instances.

## Consequences

No `merchant_id` in the schema for now; adding multi-tenancy later is a migration.
