# 0012. Fastify with a hand-written composition root

- Status: accepted
- Date: 2026-10-26

## Context

NestJS brings decorators, reflect-metadata and rxjs — extra dependencies against [ADR-0007](0007-minimal-dependencies.md). Domain and application do not depend on the framework either way.

## Decision

Use Fastify for HTTP (from stage 4) and a manual composition root for DI.

## Consequences

Wiring is explicit code in `src/app/`.
