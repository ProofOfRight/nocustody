# 0008. Transactional outbox for webhooks

- Status: accepted
- Date: 2026-10-26

## Context

Audited gateways lost notifications on restart (Bicycle, epusdt).

## Decision

Domain events are written to an outbox table in the same DB transaction as the state change; a dispatcher delivers them with retries and backoff.

## Consequences

At-least-once delivery; merchants deduplicate by `event_id`.
