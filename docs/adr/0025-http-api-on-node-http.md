# 0025. HTTP API on node:http without a framework

- Status: accepted
- Date: 2026-10-26

## Context

[ADR-0012](0012-fastify-manual-di.md) chose Fastify for the merchant API. When it was installed, Fastify 5.12.7
added 35 runtime packages (32 → 67), against the minimal-dependency policy of
[ADR-0007](0007-minimal-dependencies.md). The API has five endpoints, JSON only, and no plugins.

## Decision

Implement the API directly on `node:http`: a small route table, JSON body reader with a 16 KiB limit and
`Content-Type` check, strict query parsing (no repeated parameters), zod validation, per-key token bucket, server
timeouts, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on every response. The composition root
stays hand-written as in ADR-0012.

## Consequences

Supersedes the HTTP part of [0012](0012-fastify-manual-di.md). Zero added runtime dependencies. Transport
behaviour (body limits, parsing, timeouts) is our code and is covered by tests that use a real server. Request
bodies are read only through strict zod schemas, so a `__proto__` key is an unknown field and is refused.
