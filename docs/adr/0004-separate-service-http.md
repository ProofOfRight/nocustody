# 0004. Separate service integrated via HTTP API and webhooks

- Status: accepted
- Date: 2026-10-26

## Context

Merchant applications may use any stack (the first consumer is PHP).

## Decision

Run as a standalone service; merchants integrate through a REST API and signed webhooks.

## Consequences

An API contract (OpenAPI) and webhook protocol must be maintained and versioned.
