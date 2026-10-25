# 0014. PostgreSQL only, `pg` driver, plain SQL migrations

- Status: accepted
- Date: 2026-10-26

## Context

Queues rely on `SELECT … FOR UPDATE SKIP LOCKED` and the transactional outbox; SQLite would double the test matrix. Money-handling SQL must be readable for audit.

## Decision

PostgreSQL only. Driver `pg`; migrations are plain `.sql` files applied by a small in-house runner; queries are hand-written SQL, no ORM or query builder.

## Consequences

SQLite may be added later behind the repository ports if there is demand.
