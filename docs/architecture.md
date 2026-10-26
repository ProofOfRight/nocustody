# Architecture

Modular monolith with hexagonal architecture (ports and adapters) and DDD ([ADR-0005](adr/0005-modular-monolith-hexagonal.md)).
One installation serves one merchant ([ADR-0016](adr/0016-single-tenant.md)).

## Layers

```
src/
  domain/        pure TypeScript: aggregates, value objects, policies, domain events. No I/O, no packages.
  application/   use cases and ports (interfaces). Imports the domain only.
  adapters/      implementations of ports: chains/<network>, http (JSON client), persistence/pg, api (REST + payment
                 page), webhooks, pricing, aml, alerts, system
  app/           composition root: config with the pinned checksum, wiring, process roles, integrity guard, logger
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
- **Payment:** observed transfer ↔ invoice. The amount is classified `exact`, `under_tolerated`, `under` or `over`
  against the policy; lateness (block time after `expires_at`, within grace) is a separate flag and gives `paid_late`.
- **Amount slot / memo reservation:** locks (address, amount) until `grace_until`; a memo is reserved forever (never reused).

### Invoice lifecycle

```
awaiting_payment ──(transfer seen)──► confirming ──(final + verified)──► paid | overpaid | paid_late ──► aml_pending
       │                                  │                                     │                           │
       │                                  │        (final, less than expected)  ▼                           ├──► completed
       └──────(TTL expired)──────────────┴──► expired                      underpaid ──(top-up)──► paid…    └──► aml_hold ──(manual)──► completed | rejected
                                                  │
                                                  ├──(final payment with a block time before expires_at)──► paid
                                                  └──(final payment within grace)──► paid_late
awaiting_payment | expired ──(cancel; reserved, nothing calls it yet)──► cancelled
A final transfer that matches no invoice ──► transfer.unmatched (quarantine, manual resolution)
```

An invoice is created directly in `awaiting_payment` (the `invoice.created` event). `paid`, `overpaid` and
`paid_late` are passed through in the same transaction: settlement moves the invoice to `aml_pending` at once and the
screener (the default `noop` clears everything) completes it, so merchants receive those three as events but read
`aml_pending` / `completed` back. Transitions happen only through aggregate methods; each produces a domain event
([src/domain/events.ts](../src/domain/events.ts)) that is written to the outbox in the same database transaction
([ADR-0008](adr/0008-transactional-outbox.md)). Policies in config: underpayment tolerance (absolute and in basis
points; there is no overpayment policy — an overpayment is credited and reported as `overpaid`), accepting late
payments, TTL, grace; the AML threshold is per asset in the application's asset settings.

## Ports

| Port | Purpose |
|---|---|
| `ChainAdapter` | `fetchIncoming` returns candidate transactions from an indexer (an untrusted hint) and whether rows are left unread after its page budget (`more`; the scanner follows it from one stored cursor to the next); `verify` re-reads finalized state and returns the transfers it contains, with their real log index / lt ([ADR-0009](adr/0009-independent-finality-check.md)). TRON: [testnet.md](testnet.md); TON: [ton-testnet.md](ton-testnet.md) |
| `SecondarySource` | an independent indexer for reconciliation; returns candidates only, never credits, and says whether its answer covers the whole window |
| `PaymentInstructionStrategy` | allocates payment instructions and matches transfers; chosen per asset in config: `unique-amount` (TRON) or `memo` (TON: memo first, unique amount as fallback); later xpub derivation / reference key |
| `RateProvider`, `PegPriceSource` | quotes for fiat → asset, chained in priority order with fallback; the market price of a pegged asset for depeg protection |
| `AmlScreener` | screening verdict for a sender / transaction; `noop` by default |
| `IntegrityGuard` | re-reads the pinned config before every invoice and every monitor health cycle ([ADR-0031](adr/0031-pinned-config-scope.md)) |
| `AlertSink`, `WebhookSender` | operator alerts (log, Telegram) with a per-process cooldown; webhook delivery with signature and SSRF policy |
| `Clock`, `IdGenerator`, `MemoGenerator` | time and randomness (`node:crypto`), injected for deterministic tests |
| `UnitOfWork` and repositories | one transaction per step; invoices, amount slots, memos, candidates, observed transfers, outbox and its delivery, heartbeats, guards, API keys, idempotency keys, scan cursors, audit log |

## Processes

One image, several roles selected at start-up (`run --roles api,worker,dispatcher,monitor`, default: all four;
[operations.md](operations.md)): `api` (REST and the payment page); `worker` — one loop per network at its own
poll interval, each cycle scans candidates by cursor, stores them idempotently and advances the cursor only after
the write, drives candidates to finality and settles verified transfers in one transaction each, plus an expiry
loop; `dispatcher` (delivers the outbox); `monitor` (heartbeats, the pinned-config guard, reconciliation with a
second source, depeg protection, retention). Roles can run in separate processes against one database; per-process
state is limited to alert cooldowns, API rate-limit buckets and the provider request spacing, so run one `worker`
per network and expect alerts to repeat per monitor process.

Storage: PostgreSQL only ([ADR-0014](adr/0014-postgresql-only.md)); queues use `SELECT … FOR UPDATE SKIP LOCKED`.

## Pricing and amounts

- All amounts are `bigint` in minimal units; comparison is **exact** (no prefix or rounded matching).
- Unique amount strategy: base amount plus a configurable step (`amounts.step`, e.g. 0.01 USDT) times k on an
  address, k chosen at random among the free slots so a just-released pair is not handed out next; when the slots run
  out, the next address of the pool is used ([ADR-0030](adr/0030-early-payment-tolerance.md)).
- Memo strategy (one wallet, TON): a memo from `node:crypto` without look-alike characters, unique per network
  forever; a unique-amount slot is reserved too when one is free. A transfer with a known memo pays that invoice
  (the amount may then be under/over); without a memo it must match a unique amount exactly.
- A slot (address, amount) or memo stays locked until `expires_at + grace`, so a late payment within grace cannot
  settle a newer invoice; a transfer whose block time is more than 5 s before the invoice was created is never
  credited to it ([ADR-0030](adr/0030-early-payment-tolerance.md)).
- Underpayment and overpayment are separate statuses governed by policies; there is no "95% counts as paid" default.
- Transfers below the dust threshold are ignored and logged.
- Prices can be set in any enabled ISO 4217 currency and converted by rate (manual rates today; the `RateProvider`
  port takes others). A per-currency merchant price list exists in the domain (`PriceList`) but is not wired into
  invoice creation yet (planned, [ADR-0010](adr/0010-multi-currency-pricing.md)).
- Rates are rationals (bigint numerator / denominator). Cross rates go through a base currency (fiat → USD → USDT).
- A quote older than its `max_age` is never used; without a fresh quote no invoice is created in that currency.
- The asset amount is rounded **up** to the asset precision, then the unique-amount step is added.
- The rate, its source, timestamp and cross-rate path are locked into the invoice for its TTL.
