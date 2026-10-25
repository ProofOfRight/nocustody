# 0023. MPL-2.0 allowed for dev-only dependencies

- Status: accepted
- Date: 2026-10-26

## Context

[ADR-0006](0006-apache-2-clean-room.md) limits dependencies to MIT/BSD/ISC/Apache licenses. Vitest 5 requires
Vite 8, which has a hard dependency on `lightningcss` (MPL-2.0). MPL-2.0 is a file-level weak copyleft: obligations
arise only when distributing modified MPL-covered files. Dev dependencies are never shipped in release artifacts.

## Decision

Runtime dependencies keep the strict allowlist. Dev-only dependencies additionally allow MPL-2.0.
GPL/AGPL/LGPL stay forbidden everywhere. `scripts/check-licenses.ts` checks the two groups separately.

## Consequences

Amends [0006](0006-apache-2-clean-room.md). A dev dependency must never be moved into runtime dependencies
without passing the strict allowlist.
