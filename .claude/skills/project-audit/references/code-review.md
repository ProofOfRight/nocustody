# Phase 1. Architecture and code: what to check

Reference of the `project-audit` skill (`SKILL.md` → "Phase 1"). Read by the
main session (item 1 and the merge) and by the five reviewer agents by
group (items 2–8). What is recorded in `docs/adr/`, `docs/threat-model.md`
and the maintainer's working notes is known, not a finding; code that
diverges from a record is a finding "record is stale".

Contents: 1 layers, bounded contexts and extensibility · 2 patterns ·
3 SOLID · 4 DRY · 5 YAGNI and dead code · 6 correctness tests do not see ·
7 doc comments and documentation drift · 8 operations.

The goal of the phase is not "find a violated principle" but to answer what
the next six months of development will cost: is the code easy to maintain
(understand and fix without a debugger), to extend (a new network, strategy,
rate provider, screener, event — in one place, with a safety net) and to
scale (several processes or hosts on one database). Every finding of items
1–3 comes with a cost: how many places a typical change touches and what
would tell you if you forgot one.

1. **Layers, ports, bounded contexts and extensibility — the main item.**
   - **Layers and dependency direction** (`docs/architecture.md`,
     `.dependency-cruiser.mjs`, `scripts/check-layers.ts`):
     `src/domain` (value objects `Money`, `Asset`, `ChainAddress`, `TxRef`,
     `Rational`, `Currency`; aggregate `Invoice` with its state machine;
     amount policies and slots; memos; domain events; no I/O, no packages,
     no `node:*`) ← `src/application` (use cases `CreateInvoice`,
     `QuotePrice`, `IngestTransfers`, `VerifyTransfers`, `SettlePayments`,
     `ExpireInvoices`, `ScreenPayments`, `ResolveAmlHold`, `DispatchWebhooks`,
     `Monitor`;
     ports in `ports.ts`; strategies `UniqueAmountStrategy`, `MemoStrategy`;
     the asset catalogue) ← `src/adapters` (chains `tron`, `ton`; `http`
     JSON client; `persistence/pg`; `api` with the payment page; `webhooks`;
     `pricing`; `aml`; `alerts`; `system`) ← `src/app` (config with the
     pinned checksum, composition root `container.ts`, process roles in
     `cli.ts`, integrity guard, logger). The cruiser enforces the direction;
     check what it cannot see: domain or application code that knows a
     provider's JSON shape, HTTP status or SQL; an adapter that makes a
     business decision (classifies a payment, decides finality on its own
     instead of returning facts); the composition root that contains logic
     instead of wiring.
   - **Ports and their contracts** (`src/application/ports.ts`): every port
     has a doc comment that says what the implementation may and may not
     decide (`ChainAdapter.fetchIncoming` returns untrusted hints, `verify`
     re-reads finalized state and returns facts; repositories are
     idempotent on their unique keys; `OutboxRepository.claim` leases with
     SKIP LOCKED). Check that every implementation keeps the contract
     (TRON and TON adapters, the PostgreSQL unit of work, the in-memory
     fakes in `src/application/testing/` — the fakes must behave like the
     real thing on the paths the use-case tests rely on, otherwise the
     tests prove nothing).
   - **Bounded contexts** (`docs/architecture.md`: invoicing, chain
     monitoring, settlement, compliance, pricing, notification,
     operations). Check for each:
     - *invariants in one place:* "credit only final + successful +
       our contract + pinned recipient + exact amount" (`VerifyTransfers` +
       the adapter's `verify`), "one transfer pays at most one invoice"
       (`invoice_payments.transfer_key UNIQUE`), "a slot is locked until
       grace" (exclusion constraint), "a memo is never reused" (primary
       key), "the cursor advances only after a durable write"
       (`IngestTransfers` in one transaction), "status changes only through
       aggregate methods and each writes an event to the outbox in the
       same transaction". A rule checked in two places differently, a
       write that bypasses the aggregate or the unit of work, an amount
       that is a `number` or a decimal string past the boundary, or a use
       case that calls the webhook sender directly instead of writing an
       event, is a finding (operator alerts are the exception, by design);
     - *who calls whom:* contexts talk through use cases and ports, not
       through each other's tables; knowledge of a provider's JSON stays
       in `src/adapters`; `ApplicationError` codes speak the domain's
       language and the API maps them to HTTP. Cycles between contexts,
       "the module that knows everyone" and an application error that
       knows an HTTP status are findings.
   - **Cost of a typical change.** Walk each scenario mentally and count
     the places to touch and what tells you if you forget one (a type
     error, a cross-check test, a CHECK constraint, the layer rule, the
     OpenAPI test):
     - a new network adapter (EVM, Solana, Bitcoin): `ChainAdapter` +
       address validator + config section + `container.ts` wiring + second
       source for reconciliation + the CONTRIBUTING checklist 1–8 + recorded
       fixtures; the domain must not change;
     - a new payment instruction strategy (xpub derivation, reference key):
       `PaymentInstructionStrategy` + config enum + payment page rendering +
       `docs/architecture.md`;
     - a new rate provider or peg source, a new AML screener, a new alert
       sink: one class behind the port + config + `docs/operations.md`
       external hosts table;
     - a new webhook event type: aggregate method + `docs/api.md` list +
       the PHP and Laravel examples + OpenAPI;
     - a new API route or scope: `route()` + `ApiScope` union + OpenAPI +
       `docs/api.md` + tests for missing scope, rate limit and error shape;
     - a new fiat currency or asset: config only (ISO 4217 registry,
       `assets[]`), the pinned checksum changes;
     - a new process role or periodic job: `cli.ts` roles list + heartbeat
       + `ops.maxScannerLag` + `docs/operations.md`; the role must be
       reachable (0.2.0 shipped a `monitor` role that `run` never started);
     - a new table with growing data: retention or a documented decision
       to keep forever, indexes for its queries, `ops:status` if operators
       need to see it.
     Knowledge spread over many places without a safety net is a candidate
     for one place or at least a cross-check test. A scenario not in the
     plans (ADRs, backlog) is no reason for an abstraction now (YAGNI).
   - **Second instance and long-running processes.** `docs/operations.md`
     promises that roles can run in separate processes or hosts against
     one database. Check what breaks with two `worker` processes for the
     same network (candidate and cursor writes in one transaction; two
     scanners racing on the cursor; verifier batches overlapping;
     settlement under the invoice `version` check), two dispatchers
     (`claim` with SKIP LOCKED, lease expiry), two monitors (duplicate
     alerts within the cooldown, reconciliation twice). State must live in
     PostgreSQL, not in process memory (rate-limit buckets, alert cooldown,
     depeg guard — which are in memory and which in the `guards` table,
     and is that documented). Long-running loops in `cli.ts`: an exception
     in one cycle does not stop the loop, a slow provider does not pile up
     overlapping cycles, memory does not grow with uptime (maps keyed by
     invoice or key id without eviction), `SIGTERM` finishes the current
     transaction.
   - **Liveness.** A promise that can never settle (a response destroyed
     before its result was resolved, an `AbortSignal` not applied, a
     stream without an `end` handler), a loop whose error path returns
     before rescheduling, a role that is declared but never started, a
     queue row that is leased and never released or dead-lettered, a
     candidate that stays `seen` forever without `candidateMaxAge` — each
     is a finding with a reproduction.
   - **Maintainability for a reader.** The flow "route → use case → port →
     adapter" is visible from names and doc comments without a debugger;
     no magic (string-keyed dispatch, globals, dynamic imports); any
     departure from the conventions in `CONTRIBUTING.md` is commented.

   The outcome of the item is a short map of layers and contexts (what
   depends on what) and 2–5 conclusions "what will get in the way of
   extension" with the cost of fixing now and later. It goes to the report
   even when everything is in order.
2. **Patterns the project uses** (judge new code against them, not
   against a textbook):
   - *ports and adapters* with manual wiring in `container.ts`
     (ADR-0012): every external system behind an interface in `ports.ts`,
     fakes in `src/application/testing/`;
   - *use case* classes with one `execute` and injected dependencies;
     *unit of work* `uow.run((repos) => …)` — one transaction per cycle
     step, repositories reachable only inside it;
   - *aggregate with a state machine* (`Invoice`): transitions are
     methods, each returns or records a domain event, optimistic `version`;
   - *transactional outbox* (ADR-0008) and a *dispatcher* with backoff,
     lease and dead-letter; *idempotency* by unique keys at every boundary
     (merchant order id, `Idempotency-Key`, `TxRef`, memo);
   - *strategy* for payment instructions (`unique-amount`, `memo`), chosen
     per asset in config;
   - *untrusted hint, trusted re-read* (ADR-0009): the indexer gives
     candidates, a finalized-state query gives facts; the second source in
     reconciliation only produces candidates;
   - *pinned configuration* with a checksum supplied separately at deploy
     time and re-checked by the integrity guard before every invoice and
     once a minute by the monitor;
   - *exact arithmetic*: `bigint` units, `Rational` rates, decimal strings
     at the boundary, rounding up once;
   - *thin HTTPS JSON client* (ADR-0015): https only, same host, timeout,
     size limit, zod schema, backoff — every provider call goes through it;
   - *recorded fixtures* for contract tests of adapters, replay e2e
     scripts against live testnets, a read-only mainnet replay.
   Check: the same task in new code is solved by the same mechanism (an
   external call through the JSON client, a new fact as an outbox event,
   a new decision with an audit log entry and reason); a second mechanism
   for one task is a reason to merge; a pattern with one implementation and
   no plan for a second is YAGNI, but an interface for the sake of a fake in
   tests is justified. Name the pattern in the finding and say whether it
   fits here.
3. **SOLID** (class level; layers and contexts — item 1).
   - *S:* a class changes for one reason. Signs: a use case that fetches,
     decides and formats an alert text; an adapter that both parses the
     provider and classifies the payment; `container.ts` that contains
     logic beyond wiring.
   - *O:* a new variant (network, strategy, provider, sink, event) is a new
     class or a config entry, not an `if`/`switch` across the code. A
     `switch` over a union is fine while `noImplicitReturns` and exhaustive
     checks make a forgotten case a type error; a `default` that swallows a
     new variant silently is a finding.
   - *L:* implementations keep the port's doc-comment contract; fakes in
     `testing/` behave like the real thing (compare with the PostgreSQL
     integration tests).
   - *I:* ports are narrow; a class is not forced to implement what it does
     not need.
   - *D:* dependencies come through the constructor as readonly fields;
     `process.env` is read only in `src/app`; `new` of an adapter inside a
     use case is a finding, `new` of a value object is normal.
4. **DRY.** Identical blocks (error mapping, pagination parsing, retry
   loops, cursor parsing shared by the TRON and TON adapters) — extract.
   Similar shape with different meaning (two `switch` statements in
   different contexts) is not duplication; merge only one piece of
   knowledge.
5. **YAGNI / dead code.** The compiler already enforces `noUnusedLocals`
   and `noUnusedParameters`; exported but unused symbols it does not see.
   Candidates: for every `export` in `src/` outside `ports.ts`, grep its
   users (`git grep -lw Name -- src scripts tools ':!*.test.ts'`; imports
   are wrapped over several lines, so match the word, not the import
   line); a symbol used only by tests is marked separately. Config options nobody
   reads, repository methods nobody calls, event types nobody emits,
   fixtures nobody loads, CLI commands not in the docs. A detector gives
   **candidates**: something referenced by string (a role name, a CLI
   command, an event type in docs) looks dead — search before deleting.
   "Groundwork" described in an ADR or the backlog is not dead code.
6. **Correctness tests do not see:** races on money (two cycles crediting
   the same transfer — `UNIQUE` plus the invoice `version`; two creates for
   one order — unique violation mapped to the winner), idempotency of every
   boundary on retry (webhook delivered twice, candidate fetched twice,
   reconciliation reporting the same transfer), the cursor never advancing
   past an unstored candidate and never jumping ahead after downtime,
   side effects outside the database only after COMMIT (webhooks from the
   outbox, alerts), failure isolation (one provider down stops one network
   only, one bad row does not fail the batch, one failing alert sink does
   not stop the others), time (`Clock` everywhere, no `Date.now()` in the
   domain, UTC in the database, clock skew margins for slots), `bigint`
   from the provider to the database and back (`numeric(78,0)` ↔ string ↔
   `bigint`, never through `number`), liveness (item 1). A new failure
   point (external service, table, loop) — does `ops:status`, a heartbeat
   or an alert see it.
7. **Doc comments and documentation drift.** Every exported class, port and
   function has an up-to-date comment (a stale one is worse than none);
   a port says what the implementation may decide. Documentation is part of
   the contract: `docs/api.md` and `docs/api/openapi.yaml` ↔ routes in
   `server.ts` and error codes; `docs/operations.md` ↔ roles, CLI commands,
   alerts and the external hosts table; `docs/configuration.md` ↔ the zod
   schema in `config.ts` (every option, every default); `docs/architecture.md`
   ↔ ports and statuses; `CHANGELOG.md` ↔ behaviour of the release;
   `CONTRIBUTING.md` checklist ↔ what the adapter tests actually cover;
   `examples/` ↔ the signature and event shape. Drift is a finding with the
   side that is wrong named.
8. **Operations.** Mechanical candidates first (the sections "process.env",
   "numbers" and "supply chain" of `scripts/security_scan.sh` overlap with
   this item), then by eye:
   - **Database.** Growing tables: `tx_candidates`, `observed_transfers`,
     `invoice_payments`, `outbox`, `audit_log`, `idempotency_keys`,
     `memo_reservations` (never reused by design). For each: the queries in
     `unit-of-work.ts` have an index (`EXPLAIN` on a filled dev database for
     the hot ones: pending outbox, `seen` candidates, status + expiry of
     invoices), and there is a retention rule or a recorded decision to
     keep forever (payments and audit — forever; idempotency keys and
     delivered outbox rows — candidates for pruning). `numeric(78,0)` for
     every amount, `text` statuses with `CHECK` that match the TypeScript
     unions (a cross-check test is the safety net), unique constraints
     under every business rule, `FOR UPDATE SKIP LOCKED` where parallel
     workers compete.
   - **Migrations.** Forward-only SQL files with a checksum of applied ones
     (`migrate.ts` refuses a modified migration): a new migration is
     additive and safe while the previous version still runs (`migrate`
     runs before the new image starts in `deploy/compose.yaml`); no
     `ALTER TYPE` or index without `CONCURRENTLY` on a large table without a
     note.
   - **Batches, polling and provider limits.** Page sizes and `maxPages`
     in `container.ts`, `pollInterval`, `minInterval` for keyless toncenter,
     client-side rate limit in the JSON client, `maxResponseBytes`: what
     grows with the number of invoices and addresses per cycle (candidates
     per address, verify calls per candidate, reconciliation per address)
     and whether a cycle fits into `pollInterval` and the provider's rate
     plan (`docs/going-live.md`); a cycle that runs longer than the
     interval must not overlap itself.
   - **Long-running process.** In-memory state of the `api` role
     (rate-limit buckets per key, idempotency cache if any) and of the
     monitor (alert cooldown) — bounded and documented; nothing is written
     to the local disk (the image is read-only); shutdown finishes the
     cycle.
