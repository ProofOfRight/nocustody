# 0005. Modular monolith, hexagonal architecture, DDD

- Status: accepted
- Date: 2026-10-26

## Context

Need simple operations and clear boundaries for contributors; chain and provider adapters must be isolated from the domain.

## Decision

One deployable, ports & adapters, DDD. Dependencies point inward: adapters → application → domain. See [architecture.md](../architecture.md).

## Consequences

Layer boundaries are enforced by tooling in CI ([ADR-0013](0013-single-package-npm.md)).
