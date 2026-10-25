# Architecture

Modular monolith with hexagonal architecture (ports and adapters) and DDD ([ADR-0005](adr/0005-modular-monolith-hexagonal.md)).
One installation serves one merchant ([ADR-0016](adr/0016-single-tenant.md)).

## Layers

```
src/
  domain/        pure TypeScript: aggregates, value objects, policies, domain events. No I/O, no packages.
  application/   use cases and ports (interfaces). Imports the domain only.
  adapters/      implementations of ports: chains/<network>, persistence/pg, pricing, aml, (later) http, webhooks
  app/           composition root: config, wiring, process roles
```

Dependencies point inward: `adapters → application → domain`. Rules are enforced by dependency-cruiser
(`.dependency-cruiser.mjs`). New networks and providers are added by registering an adapter in the composition root;
the domain does not change.

## Bounded contexts

| Context | Responsibility |
|---|---|
| Invoicing | Invoice lifecycle, price and locked rate, TTL, payment instructions (through a strategy) |
| Chain monitoring | Observed transfers, scan cursors, finality, verification; chain adapters live here |
| Settlement | Matching verified transfers to invoices, payment classification, quarantine of unmatched transfers |
| Compliance | AML screening of the sender, hold / release policies |
| Pricing | Quotes fiat → asset, price lists, depeg protection |
| Notification | Webhooks to the merchant (outbox, signature, retries), operator alerts |
| Operations | Scanner heartbeat, reconciliation with a second source, audit log |

## Domain model

- **Value objects:** `Money` (bigint minimal units + `Asset`), `Asset` (network, native or token, contract, decimals
  from config), `ChainAddress`, `TxRef` (network, tx hash, log index or lt), `Currency` (ISO 4217 code and minor
  units), `FiatAmount`, `RateQuote`, `PriceList`.
- **Invoice (aggregate):** merchant order id (idempotent creation), asset, expected amount, payment instructions,
  fiat price and locked rate, `expires_at`, `grace_until`, status, linked payments.
- **Receiving addresses:** pinned in config with a checksum; never editable through an API.
- **Observed transfer:** `TxRef`, from, to, asset, amount, block, finality, verification result and reason.
- **Payment:** observed transfer ↔ invoice, classified as exact / under / over / late.
- **Amount slot / memo reservation:** locks (address, amount) or a memo until `grace_until`.

### Invoice lifecycle

```
created ──► awaiting_payment ──(transfer seen)──► confirming ──(final + verified)──► paid | underpaid | overpaid
   │              │                                                                        │
   │              └──(TTL expired)──► expired ──(final payment within grace)──► paid_late   ▼
   │                                                                   aml_pending ──► completed
   │                                                                        └──► aml_hold ──(manual)──► completed | rejected
   └──(cancelled by merchant)──► cancelled
A final transfer that matches no invoice ──► unmatched (quarantine, manual resolution)
```

Transitions happen only through aggregate methods; each produces a domain event that is written to the outbox in the
same database transaction ([ADR-0008](adr/0008-transactional-outbox.md)). Policies (underpayment tolerance,
overpayment handling, accepting late payments, TTL, grace, AML threshold) are configurable domain policies.

## Ports

| Port | Purpose |
|---|---|
| `ChainAdapter` | `fetchIncoming` returns candidates from an indexer; `verify` checks finality, success, contract, recipient and amount against finalized state ([ADR-0009](adr/0009-independent-finality-check.md)) |
| `PaymentInstructionStrategy` | allocates payment instructions (unique amount, memo, later xpub derivation / reference key) and matches transfers |
| `RateProvider` | quotes for fiat → asset; chained with priorities and fallback |
| `AmlScreener` | screening verdict for a sender / transaction; `noop` by default |
| `Clock` | current time, for deterministic tests |
| Repositories | invoices, reservations, observed transfers, payments, outbox, scan cursors |

## Processes

One image, several roles selected at start-up: `scanner:<network>` (fetch candidates by cursor, store them
idempotently, advance the cursor only after the write), `verifier` (drive candidates to finality), `settlement`
(match, apply policies, change status and write the outbox in one transaction), later `api`, `dispatcher` and
`reconciler`.

Storage: PostgreSQL only ([ADR-0014](adr/0014-postgresql-only.md)); queues use `SELECT … FOR UPDATE SKIP LOCKED`.

## Pricing and amounts

- All amounts are `bigint` in minimal units; comparison is **exact** (no prefix or rounded matching).
- Unique amount strategy: base amount plus a configurable step (default 0.01 USDT) per slot on an address; when the
  slots run out, the next address of the pool is used.
- A slot (address, amount) or memo stays locked until `expires_at + grace`, so a late payment cannot settle a newer
  invoice.
- Underpayment and overpayment are separate statuses governed by policies; there is no "95% counts as paid" default.
- Transfers below the dust threshold are ignored and logged.
- Prices can be set in any enabled ISO 4217 currency, either converted by rate or taken from a merchant price list.
- Rates are rationals (bigint numerator / denominator). Cross rates go through a base currency (fiat → USD → USDT).
- A quote older than its `max_age` is never used; without a fresh quote no invoice is created in that currency.
- The asset amount is rounded **up** to the asset precision, then the unique-amount step is added.
- The rate, its source, timestamp and cross-rate path are locked into the invoice for its TTL.
