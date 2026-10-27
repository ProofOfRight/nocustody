# Phases 2–3. Test completeness, stale and "empty" tests

Reference of the `project-audit` skill (`SKILL.md` → "Phases 2–3"). Read by
the main session. The phase 2 checklist has the format "scenario → test";
`scripts/test_checklist.py` compares it with the tests and the code. The
checklist ages with the product: a source module in no group is printed as
`UNMENTIONED` — add a group or an item here. Last update — 2026-10-26
(created with the skill, after release 0.2.1); 2026-10-26 after the first full audit (34 scenarios added, 7 NO TEST closed).

Contents: phase 2 — the script, the checklist by group, missing tests ·
phase 3 — signs of an "empty" test, manual mutations for money code.

## Phase 2. Test completeness

1. `python3 .claude/skills/project-audit/scripts/test_checklist.py`:
   **DEAD REFERENCE** — a test was renamed or removed, fix the reference
   (the only thing the script fails on); **NO TEST** — scenarios without a
   test; **UNMENTIONED** — source modules outside the checklist;
   **UNREFERENCED** — test files the checklist never points to (the test
   exists, the scenario is missing here — add it, it matters since
   somebody tests it).
2. The checklist below: every scenario names a test that **fails** when
   the scenario is broken. A reference `` `file.test.ts :: title` `` proves
   the test exists; that it is not "empty" — phase 3. Rules: one line per
   scenario — "- scenario — `file :: title`" (1–3 tests), without a test —
   "- scenario — NO TEST (what was looked for)"; a group carries an HTML
   comment `covers:` with the source modules it covers. A new context,
   command or scenario that appears in the code — a new line or group
   **here**. The mark "(checks less than it says: …)" records a gap between
   the wording and what the test really asserts — a candidate for a
   stronger test.
3. Compare the script output with the code: `UNMENTIONED` and
   `UNREFERENCED` — extend; `NO TEST` — item 4.
4. Missing tests — write them (next to the code, `*.test.ts`; PostgreSQL —
   `*.int.test.ts`), check for emptiness (`SKILL.md`, main rules).

### Money, decimals and rates
<!-- covers: src/domain/money.ts, src/domain/decimal.ts, src/domain/rational.ts, src/domain/currency.ts,
     src/domain/iso4217.ts, src/domain/pricing.ts, src/domain/asset.ts, src/domain/network.ts,
     src/domain/chain-address.ts, src/domain/tx-ref.ts -->
- decimal strings parse exactly into units, never round, malformed input refused — `value-objects.test.ts :: parses exact decimals into units`, `value-objects.test.ts :: never rounds and rejects malformed input`
- units round-trip and format with the asset's scale — `value-objects.test.ts :: round-trips any non-negative amount` (and "formats with exactly `scale` fractional digits" in the same file — its title contains backticks, which the reference syntax cannot express)
- an asset is identified by its contract, never by symbol; contract presence by kind — `value-objects.test.ts :: identifies assets by contract, never by symbol`, `value-objects.test.ts :: enforces contract presence by kind and sane decimals`
- Money is non-negative, never mixes assets, compares exactly — `value-objects.test.ts :: is non-negative`, `value-objects.test.ts :: refuses to mix assets`, `value-objects.test.ts :: compares exactly`
- addresses compare in canonical form; TxRef is a stable idempotency key — `value-objects.test.ts :: compares canonical addresses per network`, `value-objects.test.ts :: builds a stable idempotency key`
- ISO 4217 minor units (0, 2, 3 digits), fiat amounts parsed without rounding — `pricing.test.ts :: knows minor units, including 0 and 3 digit currencies`, `pricing.test.ts :: parses fiat amounts in the currency's precision without rounding`
- rationals are exact and normalised — `pricing.test.ts :: are exact and normalised`
- a stale quote (or one from the future) is never used — `pricing.test.ts :: rejects stale quotes and quotes far in the future`, `pricing.test.ts :: never resolves a rate from a stale quote`
- cross rates go through the base currency, record the path and the oldest quote, prefer provider priority — `pricing.test.ts :: goes through the base currency and records the path`, `pricing.test.ts :: reports the oldest quote time on the path`, `pricing.test.ts :: prefers the first quote among equally short paths (provider priority)`
- conversion to the asset for 0-, 2- and 3-digit currencies and large numbers — `pricing.test.ts :: JPY (0 minor digits)`, `pricing.test.ts :: BHD (3 minor digits)`, `pricing.test.ts :: IRR (large numbers)`
- markup per currency; the merchant never receives less than the price (round up) — `pricing.test.ts :: applies markup per currency`, `pricing.test.ts :: always rounds up: the merchant never receives less than the price`
- price lists hold one price per currency — `pricing.test.ts :: holds one price per currency`

### Invoice lifecycle and policies
<!-- covers: src/domain/invoice.ts, src/domain/amount-policy.ts, src/domain/events.ts, src/domain/errors.ts,
     src/application/ports.ts -->
- created awaiting payment with expiry and grace, event recorded — `invoice.test.ts :: is created awaiting payment with expiry and grace, and records an event`
- detected → confirming → paid on the exact amount; idempotent per transfer — `invoice.test.ts :: detected → confirming → paid on exact amount`, `invoice.test.ts :: is idempotent per transfer`
- underpaid, then topped up; no "95 % = paid" unless configured; overpaid is its own status — `invoice.test.ts :: underpaid, then topped up to paid`, `invoice.test.ts :: no '95% = paid' by default; tolerance only when configured`, `invoice.test.ts :: overpaid is a separate status`
- expiry, grace and paid_late; a genuine payment made before expiry is paid, not late — `invoice.test.ts :: expires after TTL; a payment within grace makes it paid_late`, `invoice.test.ts :: expires from confirming; a genuine payment made before expiry is still paid, not late`
- late payments refused by policy; payments after grace, before creation or in another asset refused — `invoice.test.ts :: rejects late payments when the policy says so`, `invoice.test.ts :: rejects payments after grace, before creation, or in another asset`
- nothing is paid after cancellation or completion — `invoice.test.ts :: cannot be paid after cancellation or completion`
- AML: pending → completed, hold → manual decision — `invoice.test.ts :: goes through AML: pending → completed, or hold → manual decision`
- optimistic version on every change — `invoice.test.ts :: increments the version on every change and keeps the loaded version`
- amount classification is exact; dust below the threshold — `invoice.test.ts :: classifies exactly`, `invoice.test.ts :: treats amounts below the threshold as dust`
- a zero-value transfer is dust whatever the threshold — `invoice.test.ts :: treats amounts below the threshold as dust`
- a payment with an Invalid Date is refused, not accepted as on time — `invoice.test.ts :: rejects payments after grace, before creation, or in another asset`
- a transfer more than 5 s before the invoice was created is refused (ADR-0030) — `invoice.test.ts :: rejects payments after grace, before creation, or in another asset`, `use-cases.test.ts :: a transfer that landed before the invoice existed is never claimed by it (someone else's money)`
- `needsAmlReview` names the states `startAmlReview` accepts — `invoice.test.ts :: goes through AML: pending → completed, or hold → manual decision`
- the transfer key round-trips through `parseTxRefKey`, malformed keys refused — `value-objects.test.ts :: builds a stable idempotency key`
- every event type the aggregate can record is in `docs/api.md`, and no other — `contract.test.ts :: lists every webhook event type the gateway can emit, and no other` (the aggregate records `DomainEventType` only: a new literal is a type error)

### Payment instructions: unique amounts and memos
<!-- covers: src/domain/amount-slot.ts, src/domain/memo.ts, src/application/strategies/strategy.ts,
     src/application/strategies/unique-amount.ts, src/application/strategies/memo.ts, src/adapters/system/system.ts -->
- slot amounts are distinct and strictly above the base — `invoice.test.ts :: generates distinct slot amounts strictly above the base`
- a slot matches only the exact amount on the same address within its window — `invoice.test.ts :: matches only the exact amount on the same address within the slot window`
- a late payment for an old invoice cannot settle a newer one with the same pair; no reopening inside the skew margin — `invoice.test.ts :: a late payment for an old invoice cannot settle a newer invoice with the same pair`, `invoice.test.ts :: a slot for the same pair cannot reopen inside the clock-skew margin of the previous one`
- property: with non-overlapping slots a transfer matches at most one slot — `invoice.test.ts :: property: with non-overlapping slots a transfer matches at most one slot, and only on exact facts`
- unique amounts per address, next address when slots run out, then failure — `use-cases.test.ts :: allocates unique amounts per address and is idempotent by merchant order id`, `use-cases.test.ts :: moves to the next address when slots run out, then fails`
- memo plus fallback amount; memos never reused; memo-only invoices when amounts are exhausted — `use-cases.test.ts :: allocates a unique memo plus a fallback unique amount; memos are never reused`, `use-cases.test.ts :: issues memo-only invoices when amount slots are exhausted`
- memo matching ignores case and spaces; with a memo the amount may differ (underpaid, topped up) — `use-cases.test.ts :: matches by memo regardless of case and surrounding spaces`, `use-cases.test.ts :: with a memo the amount may differ: underpaid, then topped up with the same memo`
- a forgotten memo falls back to the unique amount; unknown memo with a wrong amount is quarantined; free text never matches — `use-cases.test.ts :: a payer who forgot the memo is matched by the unique amount`, `use-cases.test.ts :: an unknown memo with a non-matching amount is quarantined; free text never matches`
- a memo matches only payments to its own address — `use-cases.test.ts :: a memo only matches payments to its own address`
- memos come from node:crypto without look-alike characters; payer input is normalised, free text refused — `system.test.ts :: produces valid memos from the alphabet without look-alike characters`, `system.test.ts :: normalizes payer input but rejects free text`
- allocation starts at a chosen (random in production) slot and wraps around — `use-cases.test.ts :: starts at a chosen slot and wraps around, so a just-freed pair is not the next one handed out`

### Create invoice and quotes
<!-- covers: src/application/use-cases/create-invoice.ts, src/application/use-cases/quote-price.ts,
     src/application/rates.ts, src/application/catalog.ts, src/application/errors.ts,
     src/adapters/pricing/manual-table.ts -->
- idempotent by merchant order id; the same order with another price, currency or asset is refused — `use-cases.test.ts :: allocates unique amounts per address and is idempotent by merchant order id`, `use-cases.test.ts :: refuses the same merchant order with another price, currency or asset`
- a concurrent create for the same order answers with the winner — `use-cases.test.ts :: a concurrent create for the same order answers with the invoice that won`
- the rate, its source and the cross-rate path are locked into the invoice; markup applied; prices already in the asset accepted — `use-cases.test.ts :: locks the rate, source and cross-rate path`, `use-cases.test.ts :: applies per-currency markup`, `use-cases.test.ts :: accepts prices already in the asset`
- no payment instructions when the pinned config was tampered with — `use-cases.test.ts :: refuses to issue payment instructions when the pinned config was tampered with`
- disabled currencies and stale rates refused; fallback to the next rate provider — `use-cases.test.ts :: refuses disabled currencies and stale rates`, `use-cases.test.ts :: falls back to the next provider when the first fails or is stale`
- a quote never creates an invoice — `server.test.ts :: quotes without creating an invoice`
- the depeg guard refuses new invoices in the blocked symbol — `monitor.test.ts :: blocks new invoices while the price is off the peg and unblocks when it returns`
- with depeg protection configured a missing or stale guard reading blocks (fail closed) — `use-cases.test.ts :: with depeg protection configured, a missing or stale guard reading blocks new invoices (fail closed)`
- an existing order is answered before quoting (a stale rate or a depeg block does not hide it) — `use-cases.test.ts :: answers an existing order before quoting: a stale rate or a depeg block does not hide it`
- the integrity reason (config path, file fragment) never reaches the API caller — `use-cases.test.ts :: the integrity reason stays with the operator: the API caller never sees a config path or file fragment`
- exhausted slots raise a critical alert — `use-cases.test.ts :: moves to the next address when slots run out, then fails`

### Payment flow: ingest, verify, settle, expire
<!-- covers: src/application/use-cases/ingest-transfers.ts, src/application/use-cases/verify-transfers.ts,
     src/application/use-cases/settle-payments.ts, src/application/use-cases/expire-invoices.ts,
     src/application/use-cases/resolve-aml-hold.ts, src/adapters/chains/cursor.ts -->
- invoice → transfer → verified → paid → completed with outbox events and an audit trail — `use-cases.test.ts :: invoice → transfer → verified → paid → completed, with outbox events and audit trail`
- the same transfer seen twice is credited once — `use-cases.test.ts :: is idempotent: the same transfer seen twice is credited once`
- a transfer the verifier rejects (fake token, failed transaction) is never credited — `use-cases.test.ts :: does not credit a transfer the verifier rejects (fake token, failed tx)`
- a retired address is neither watched nor shown; only addresses missing from the pin count as unpinned (ADR-0037) — `catalog.test.ts :: a retired address is neither watched nor shown; active and draining are both`, `catalog.test.ts :: only addresses missing from the pin count as unpinned; retired ones are pinned`
- non-final and errored candidates are kept for a later attempt; never final → rejected after the max age — `use-cases.test.ts :: keeps non-final and errored candidates for a later attempt`, `monitor.test.ts :: rejects a candidate that never becomes final`
- transfers matching no invoice are quarantined — `use-cases.test.ts :: quarantines transfers that match no invoice`
- several transfers in one transaction are separate payments; the hint is never credited; the verified amount wins — `use-cases.test.ts :: several transfers in one transaction are separate payments; the hint is never credited`, `use-cases.test.ts :: credits the verified amount, not the indexer's claim`
- a final transaction without a transfer to us is rejected; dust is never verified — `use-cases.test.ts :: a final transaction without a transfer to us is rejected`, `use-cases.test.ts :: ignores dust and never verifies it`
- the cursor does not advance when storing candidates fails — `use-cases.test.ts :: does not advance the cursor when storing candidates fails`
- a late payment within grace is paid_late even when verified after grace; an expired invoice's slot is not reused — `use-cases.test.ts :: credits a late payment within grace as paid_late, even when verified after grace`, `use-cases.test.ts :: a late payment for an expired invoice cannot pay a new invoice: the slot is not reused`
- an AML hold stops completion; an unavailable screener defers; threshold and manual resolution — `use-cases.test.ts :: AML hold stops completion; an unavailable screener defers it`, `monitor.test.ts :: payments below the AML threshold complete without screening; above it are screened; holds can be resolved`
- the transfer key is recorded in the invoice payment; transfers for other assets or addresses are never stored — `use-cases.test.ts :: records the transfer key in the invoice payment`, `use-cases.test.ts :: never stores transfers for other assets or addresses`
- a transfer the adapter returns for a foreign address or another asset is rejected by the verifier — `use-cases.test.ts :: rejects a transfer the adapter returns for a foreign address or another asset`
- a transfer settled by another worker between list and write is recorded once — `use-cases.test.ts :: a transfer settled by another worker between list and write is recorded once`, `pg.int.test.ts :: stores each candidate tx once and each transfer once: UNIQUE(network, tx_hash, log_index)`
- a dust hint does not bury a real payment: a later non-dust hint re-queues the candidate — `use-cases.test.ts :: a dust hint does not bury a real payment: a later non-dust hint for the same transaction re-queues it`
- verification that keeps failing is rejected after the max age; the max age counts from first seen after downtime — `monitor.test.ts :: a candidate whose verification keeps failing is rejected after the max age, with an alert`, `monitor.test.ts :: the max age counts from the time the candidate was first seen when its block time is older (downtime)`
- one candidate whose result cannot be stored does not stop verification or settlement; one failing transfer does not abort the settlement batch — `use-cases.test.ts :: one candidate whose result cannot be stored does not stop the others or the settlement` (settlement: the 0.2.1 path is still without a throwing-repository test)
- a row whose asset is no longer configured is skipped by every cycle — NO TEST (the 0.2.1 fix; looked for a flow test with an unknown asset id in the database)
- the shared cursor parses, re-reads the overlap, and guarantees progress after a burst (tight, then deeper pages) — `cursor.test.ts :: parses stored cursors and drops anything that is not a safe integer`, `cursor.test.ts :: re-reads the overlap, never before the floor, and starts tight after a scan without progress`, `cursor.test.ts :: a burst larger than the page budget cannot freeze the cursor: tight, then deeper pages, then back to normal`
- a burst larger than the page budget cannot freeze either adapter's cursor; the scan reports the exhausted budget and the application alerts — `ton/adapter.test.ts :: a burst of transactions larger than the page budget cannot freeze the cursor`, `tron/adapter.test.ts :: a burst of transfers larger than the page budget cannot freeze the cursor`, `use-cases.test.ts :: alerts when rows are still unread after every scan of the cycle: the scanner lags behind the chain`

### TRON adapter and the JSON client
<!-- covers: src/adapters/chains/tron/adapter.ts, src/adapters/chains/tron/address.ts,
     src/adapters/chains/tron/schemas.ts, src/adapters/http/json-client.ts -->
- base58check addresses round-trip; bad checksums and prefixes refused — `tron/adapter.test.ts :: round-trips base58check and hex`, `tron/adapter.test.ts :: rejects bad checksums, wrong prefixes and malformed input`
- candidates: confirmed incoming transfers of the configured contract, pagination with the same parameters, overlap window — `tron/adapter.test.ts :: queries confirmed incoming transfers of the configured contract and parses the recording`, `tron/adapter.test.ts :: follows fingerprint pages with the same parameters and re-reads an overlap window from the cursor`
- other tokens dropped, one transaction de-duplicated — `tron/adapter.test.ts :: drops rows of other tokens and de-duplicates rows of one transaction`
- finality: a SUCCESS receipt from the solidity endpoint only; an empty answer is pending — `tron/adapter.test.ts :: final: the recorded SUCCESS receipt yields one transfer with its log index, sender and amount`, `tron/adapter.test.ts :: calls only the solidity endpoint`, `tron/adapter.test.ts :: non-final: an empty answer from walletsolidity is pending, never credited`
- failed transaction (REVERT, OUT_OF_ENERGY, FAILED) rejected — `tron/adapter.test.ts :: failed transaction: receipt REVERT / OUT_OF_ENERGY or result FAILED is rejected`
- fake token: a Transfer log of another contract is not ours — `tron/adapter.test.ts :: fake token: a Transfer log from another contract is not a transfer of the asset`
- several transfers in one transaction, each with its own log index — `tron/adapter.test.ts :: several transfers in one transaction: each log to us becomes a transfer with its own index`
- dust reported with its exact amount — `tron/adapter.test.ts :: dust: tiny transfers are reported with their exact amount (the application drops them)`
- an answer about another transaction or malformed topics is not a decision — `tron/adapter.test.ts :: an answer about another transaction is a provider fault (pending, retried), never a decision; malformed topics are ignored`, `tron/adapter.test.ts :: an unexpected response shape is a provider error, not a decision`
- JSON client: https only, same host, retries on 429/5xx with backoff, no retry on 400, no redirects, size limit, key header only when configured — `tron/adapter.test.ts :: accepts only https and never leaves the configured host`, `tron/adapter.test.ts :: retries 429/5xx with backoff, does not retry 400, refuses redirects`, `tron/adapter.test.ts :: enforces the response size limit`, `tron/adapter.test.ts :: sends the API key header only when configured`
- the client-side minimum interval between requests (keyless toncenter) is respected — NO TEST (looked for a test of `minIntervalMs` in the JSON client)
- a transaction with several transfers to us is hinted with its largest one — `tron/adapter.test.ts :: drops rows of other tokens and de-duplicates rows of one transaction`

### TON adapter
<!-- covers: src/adapters/chains/ton/adapter.ts, src/adapters/chains/ton/address.ts,
     src/adapters/chains/ton/payload.ts, src/adapters/chains/ton/schemas.ts -->
- raw and friendly forms normalise to canonical raw, basechain only — `ton/adapter.test.ts :: normalises raw and friendly forms to canonical raw; basechain only`
- internal_transfer payload parsed: amount, sender, forward amount, comment inline or by reference; binary and malformed bodies ignored — `ton/adapter.test.ts :: parses the recorded internal_transfer: amount, sender, forward amount, comment`, `ton/adapter.test.ts :: reads comments inline or by reference, ignores binary comments and malformed bodies`
- jetton-wallet binding verified with get_wallet_address on the pinned master; a fake wallet in config is reported — `ton/adapter.test.ts :: accepts the pinned jetton-wallet returned by get_wallet_address on the pinned master`, `ton/adapter.test.ts :: reports a fake jetton-wallet in config`
- candidates come from our jetton-wallet's transactions, including forward_ton_amount = 0; a 0.1.0 cursor is resumed — `ton/adapter.test.ts :: jetton: internal_transfer on our jetton-wallet, with amount, sender and memo hints`, `ton/adapter.test.ts :: jetton: a payment sent with forward_ton_amount = 0 (no notification to the owner) is still found`, `ton/adapter.test.ts :: jetton: resumes from a 0.1.0 owner cursor instead of rescanning from startFrom`
- native transfers with exact amounts; notifications are not GRAM; outgoing and excess messages are not candidates — `ton/adapter.test.ts :: native: plain transfers with their exact (dust) amounts; jetton notifications are not GRAM`, `ton/adapter.test.ts :: other messages to the jetton-wallet (outgoing transfer, excesses) are not candidates`
- without a pinned jetton-wallet the owner is not scanned for the jetton; overlap window re-read — `ton/adapter.test.ts :: without a pinned jetton-wallet the owner is not scanned for the jetton`, `ton/adapter.test.ts :: re-reads an overlap window from the cursor (duplicates are dropped by the database)`
- finality: one query by hash, lt as the index; non-final or emulated is pending — `ton/adapter.test.ts :: final: recorded payment — amount, sender, memo, lt as index, block time; one query by hash`, `ton/adapter.test.ts :: non-final or emulated: pending, never credited`
- fake jetton-wallet or master rejected; a forged internal_transfer fails in the wallet code and is rejected — `ton/adapter.test.ts :: fake jetton-wallet / fake master: a transaction on any other jetton-wallet is rejected`, `ton/adapter.test.ts :: forged internal_transfer: the jetton-wallet code refuses it, the failed transaction is rejected`
- the amount is the one the jetton-wallet processed; bounced messages rejected; other messages credit nothing — `ton/adapter.test.ts :: the amount is read from the internal_transfer the jetton-wallet processed`, `ton/adapter.test.ts :: bounced inbound message is rejected`, `ton/adapter.test.ts :: other messages to the jetton-wallet credit nothing`
- a not-yet-indexed transaction keeps the candidate pending — `ton/adapter.test.ts :: a transaction that is not indexed yet keeps the candidate pending`
- GRAM: credited amount from the credit phase and the comment; the credited amount wins over the message value; bounced or returned funds rejected; non-final pending — `ton/adapter.test.ts :: final: credited amount from the credit phase and the comment`, `ton/adapter.test.ts :: the credited amount wins over the message value (indexer hint)`, `ton/adapter.test.ts :: bounced or returned funds are rejected`, `ton/adapter.test.ts :: non-final: pending`
- display form and payment URI for payers — `ton/adapter.test.ts :: shows payers the user-friendly non-bounceable testnet address`, `ton/adapter.test.ts :: ton://transfer with jetton master, amount in minimal units and memo`
- a comment with control characters (U+0000) is no memo; binary comments checked on the raw byte — `ton/adapter.test.ts :: a comment with control characters is no comment: PostgreSQL refuses U+0000 and the row must still be written`, `ton/adapter.test.ts :: reads comments inline or by reference, ignores binary comments and malformed bodies`
- a GRAM transfer with an encrypted comment is a payment without memo — `ton/adapter.test.ts :: a transfer with an encrypted comment is a payment without memo, not an invisible one`, `ton/adapter.test.ts :: native: plain transfers with their exact (dust) amounts; jetton notifications are not GRAM`

### Persistence (PostgreSQL)
<!-- covers: src/adapters/persistence/pg/migrate.ts, src/adapters/persistence/pg/unit-of-work.ts -->
- migrations are idempotent and refuse to run when an applied one was modified — `pg.int.test.ts :: are idempotent`, `pg.int.test.ts :: refuse to run when an applied migration was modified`
- the database refuses overlapping amount slots for one pair — `pg.int.test.ts :: the database refuses overlapping amount slots for the same pair`
- each candidate and each transfer stored once: UNIQUE(network, tx_hash, log_index) — `pg.int.test.ts :: stores each candidate tx once and each transfer once: UNIQUE(network, tx_hash, log_index)`
- memos unique per network forever — `pg.int.test.ts :: memos are unique per network forever`
- outbox: parallel claims never return the same event; leases, failures, dead-letter — `pg.int.test.ts :: outbox delivery: parallel claims never return the same event; leases, failures, dead-letter`
- api keys and idempotency keys round-trip — `pg.int.test.ts :: api keys and idempotency keys`
- ops rows: heartbeats, guards, dead-letter revival, verified candidates for reconciliation — `pg.int.test.ts :: ops: heartbeats, guards, dead-letter revival, verified candidates for reconciliation`
- state, outbox and cursor roll back together — `pg.int.test.ts :: rolls back state, outbox and cursor together`
- full flow on PostgreSQL with the invoice round-tripping; concurrent modification detected — `pg.int.test.ts :: full flow on PostgreSQL: invoice → transfer → completed, outbox written, invoice round-trips`, `pg.int.test.ts :: detects concurrent modification of an invoice`
- a migration marked `-- no-transaction` runs statement by statement (`CREATE INDEX CONCURRENTLY`) — `pg.int.test.ts :: a file marked -- no-transaction runs statement by statement, so CREATE INDEX CONCURRENTLY works`
- candidates are per asset; a non-dust hint re-queues a dust row — `pg.int.test.ts :: stores each candidate tx once and each transfer once: UNIQUE(network, tx_hash, log_index)`
- retention prunes delivered webhooks, idempotency keys and settled candidates only — `pg.int.test.ts :: retention: prunes delivered webhooks, idempotency keys and settled candidates older than the cutoff`, `monitor.test.ts :: prunes only what is configured, never payments or audit rows`
- an invoice on an address outside the pin is still read, does not stop expiry of the others, and is counted by `addressUsage` (ADR-0037) — `pg.int.test.ts :: an invoice on an address outside the pin is still read, expired and reported (ADR-0037)`
- status CHECK constraints in the migrations equal the TypeScript unions — `pg.int.test.ts :: status CHECK constraints in the migrations equal the TypeScript unions`
- amounts survive the numeric(78,0) ↔ bigint boundary above 2^53 — NO TEST (looked for a round-trip of an amount above Number.MAX_SAFE_INTEGER through a repository)

### Merchant API and keys
<!-- covers: src/adapters/api/server.ts, src/adapters/api/keys.ts -->
- health needs no key and reveals nothing — `server.test.ts :: health needs no key and reveals nothing`
- an invoice on a retired or unpinned address shows no address in the API (null fields, `address_available: false`) or on the page (ADR-0037) — `server.test.ts :: an invoice on a retired or unpinned address shows no address in the API or on the page (ADR-0037)`
- missing, malformed, unknown and revoked keys and keys without the scope are refused — `server.test.ts :: rejects missing, malformed, unknown and revoked keys, and keys without the scope`
- invoice creation returns instructions and the locked rate; idempotent by Idempotency-Key, another body refused — `server.test.ts :: creates an invoice with payment instructions and locked rate`, `server.test.ts :: is idempotent by Idempotency-Key; the same key with another body is refused`
- strict validation: decimal strings, no unknown fields, body size limit, __proto__ refused — `server.test.ts :: validates strictly: decimal strings only, no unknown fields, body size limit`, `server.test.ts :: an own __proto__ key in the body is an unknown field and is refused`
- application errors map to stable codes; internal errors never leak — `server.test.ts :: maps application errors to stable codes`, `server.test.ts :: never leaks internal errors`
- get and list invoices; quotes — `server.test.ts :: gets and lists invoices`, `server.test.ts :: quotes without creating an invoice`
- transport rules: 404/405, JSON only, no duplicated query parameters, safe response headers — `server.test.ts :: transport rules: 404/405, JSON only, no duplicated query parameters, safe response headers`
- rate limit per key — `server.test.ts :: rate-limits per key`
- junk tokens are refused without a database transaction — `server.test.ts :: asks the database only for tokens shaped like a key; junk is refused without a transaction`
- a concurrent create with the same Idempotency-Key and another body is refused — `server.test.ts :: a concurrent create with the same Idempotency-Key and another body is refused, not silently accepted`
- a malformed request target is 400, never a logged 500; a server error after start-up is reported, not a crash — `server.test.ts :: a malformed request target is the client's error (400), never a logged 500`, `server.test.ts :: a server error after start-up is reported and does not crash the process`
- `since` accepts an RFC 3339 offset — `server.test.ts :: accepts RFC 3339 timestamps with an offset in since, as the OpenAPI format date-time promises`
- routes, the Status enum and the error codes match `docs/api/openapi.yaml` — `contract.test.ts :: documents every merchant API route and no other`, `contract.test.ts :: the Status enum equals the domain's statuses`, `contract.test.ts :: every application error code and transport code is listed`
- a malformed %-escape in a path parameter answers 400 — NO TEST (the 0.2.1 fix; looked for a request with `%zz` in the path)
- the API key's last_used_at is recorded on each authenticated request — NO TEST (the 0.2.1 change; looked for an assertion on `last_used_at` after a request)

### Payment page
<!-- covers: src/adapters/api/page/render.ts, src/adapters/api/page/i18n.ts, src/adapters/api/page/qr.ts -->
- the QR decodes to exactly the encoded payment data with an independent decoder; non-ASCII refused — `page.test.ts :: decodes back to exactly the encoded payment data (independent decoder)`, `page.test.ts :: refuses non-ASCII payloads`
- language: query, then Accept-Language by q, then default; every language has every text and status — `page.test.ts :: query wins, then Accept-Language by q, then the default`, `page.test.ts :: every language has every text and every invoice status`
- self-contained page: no external resources, a nonce on every inline style and script — `page.test.ts :: is self-contained: no external resources, nonce on every inline style/script`
- exact amount, address, memo and wallet link shown; everything dynamic escaped, including inside the embedded JSON — `page.test.ts :: shows the exact amount, address, memo and wallet link`, `page.test.ts :: escapes everything dynamic, including inside the embedded JSON`
- right-to-left for Persian; language links — `page.test.ts :: right-to-left for Persian; language links for all languages`
- TRON without a wallet URI: QR carries the address, no wallet button — `page.test.ts :: TRON (no wallet URI): the QR carries the address and there is no wallet button`
- disabled by default; strict CSP with the nonce; public status reveals only status, amount and deadlines; public routes rate-limited — `server.test.ts :: is disabled by default`, `server.test.ts :: serves the page with a strict CSP whose nonce matches the inline script`, `server.test.ts :: public status reveals only status, received amount and deadlines`, `server.test.ts :: public routes are rate-limited`
- an invoice that can no longer be paid shows its status only; polling stops at grace; `underpaid` stays open — `page.test.ts :: an invoice that can no longer be paid shows its status only: no amount, address, memo, QR or wallet link`, `page.test.ts :: payable: payable statuses inside the grace period only`, `page.test.ts :: the page script polls until the grace period ends and treats underpaid as still open`, `server.test.ts :: after the grace period the page shows the status only, never an address a newer invoice may own`

### Webhooks
<!-- covers: src/adapters/webhooks/http-sender.ts, src/application/use-cases/dispatch-webhooks.ts -->
- signature over ts.event_id.body with the webhook secret; the secret is never sent — `http-sender.test.ts :: signs ts.event_id.body with the webhook secret and never sends the secret`
- non-2xx is a retryable failure; an oversized response is cut off and still yields a result — `http-sender.test.ts :: non-2xx is a retryable failure`, `http-sender.test.ts :: an oversized response body is cut off and still yields a result`
- SSRF: private and special addresses refused unless allowed; classification — `http-sender.test.ts :: SSRF: private and special addresses are refused unless explicitly allowed`, `http-sender.test.ts :: classifies special addresses`
- plain http, credentials in the URL and short secrets refused — `http-sender.test.ts :: refuses plain http, credentials in the URL and short secrets`
- the PHP example and the gateway agree on the signature (shared test vector) — `http-sender.test.ts :: the PHP example and the gateway agree on the signature`
- delivered once and marked; exponential backoff then dead-letter; a non-retryable failure dead-lettered at once; a thrown sender error retried; delay capped — `dispatch-webhooks.test.ts :: delivers once and marks the event delivered; every cycle writes the dispatcher heartbeat`, `dispatch-webhooks.test.ts :: retries with exponential backoff, then dead-letters`, `dispatch-webhooks.test.ts :: a non-retryable failure (e.g. blocked by SSRF policy) is dead-lettered at once`, `dispatch-webhooks.test.ts :: a thrown sender error is retried, not lost`, `dispatch-webhooks.test.ts :: caps the delay`
- the lease outlives a whole batch, so a second dispatcher never re-sends — `dispatch-webhooks.test.ts :: the lease outlives a whole batch, so a second dispatcher running meanwhile never re-sends`
- one attempt is bounded as a whole (a trickling response is cut off); a resolver failure is retried, only the SSRF policy is final — `http-sender.test.ts :: the deadline covers the whole attempt: a response that trickles bytes forever is cut off`, `http-sender.test.ts :: a resolver failure is retried; only the SSRF policy is final`
- the Laravel example verifies the signature and rejects an old timestamp — NO TEST in vitest (checked by `make php-selftest`, `examples/laravel/selftest.php`)

### Operations: monitor, alerts, reconciliation, depeg, AML, canary
<!-- covers: src/application/use-cases/monitor.ts, src/adapters/alerts/sinks.ts, src/adapters/pricing/peg-sources.ts,
     src/adapters/chains/tron/tronscan.ts, src/adapters/chains/ton/tonapi.ts, src/adapters/aml/blocklist.ts,
     src/adapters/aml/noop.ts, src/application/use-cases/screen-payments.ts, src/tools/canary.ts -->
- AML screening: below the threshold an invoice completes unscreened, above it is screened, a hold stops completion
  and an unavailable screener defers it — `monitor.test.ts :: payments below the AML threshold complete without screening; above it are screened; holds can be resolved`, `use-cases.test.ts :: AML hold stops completion; an unavailable screener defers it`
- an open invoice on an address outside the pin raises `invoice-address-unpinned`; a retired address or a closed invoice does not (ADR-0037) — `monitor.test.ts :: alerts on open invoices whose stored address is not in the pin, not on retired ones (ADR-0037)`
- scanner lag alert; dead-lettered webhooks alert — `monitor.test.ts :: alerts when a scanner has not succeeded within the allowed lag`, `monitor.test.ts :: alerts on dead-lettered webhooks`
- depeg: deviation in basis points; blocks and unblocks; no answer blocks, one failing source only warns — `monitor.test.ts :: measures deviation from the peg in basis points`, `monitor.test.ts :: blocks new invoices while the price is off the peg and unblocks when it returns`, `monitor.test.ts :: blocks when no source answers; one failing source only warns`
- reconciliation: missed transfers become candidates (the verifier decides) with an alert; unknown-to-second-source transfers reported; a failing second source is an alert, not a crash — `monitor.test.ts :: queues transfers the primary indexer missed as candidates (the verifier decides) and alerts`, `monitor.test.ts :: reports verified transfers the second source does not know`, `monitor.test.ts :: a failing second source is an alert, not a crash`
- alerts: repeats muted within the cooldown, one failing sink does not stop others; Telegram is send-only and errors never contain the token — `ops-adapters.test.ts :: drops repeats of the same key within the cooldown; one failing sink does not stop others`, `ops-adapters.test.ts :: telegram: send-only call, and errors never contain the bot token`
- peg sources (Kraken, Coinbase) parsed; an unexpected answer is an error, not a price — `ops-adapters.test.ts :: Kraken and Coinbase`, `ops-adapters.test.ts :: an unexpected answer is an error, not a price`
- second sources: Tronscan successful incoming transfers of the contract; tonapi internal_transfer on our jetton-wallet and plain GRAM — `ops-adapters.test.ts :: Tronscan: incoming transfers of the contract to the address, successful only`, `ops-adapters.test.ts :: tonapi: internal_transfer on our jetton-wallet with amount and memo; plain GRAM transfers`
- AML blocklist holds listed senders, bare or network-prefixed, ignores comments — `ops-adapters.test.ts :: holds senders on the list (bare or network-prefixed), ignores comments`
- the canary passes on an expected address, fails loudly on an unexpected one, reports when it cannot check — `canary.test.ts :: passes when the shown address is expected`, `canary.test.ts :: fails loudly when the gateway shows an unexpected address`, `canary.test.ts :: reports when it cannot check`
- the canary checks `address_display` and the wallet URI too, uses a random order id, requires https — `canary.test.ts :: checks every form a payer could see: address_display and the wallet URI, not only payment.address`, `canary.test.ts :: uses a random order id and refuses plain http unless allowed`
- the pinned config is re-checked every health cycle; a stopped dispatcher or an overdue webhook is an alert — `monitor.test.ts :: re-checks the pinned config every health cycle and alerts on a violation (not only on invoice creation)`, `monitor.test.ts :: with webhooks configured, a dispatcher that stopped or a webhook due for too long is an alert`
- the depeg decision is exact, not on floored basis points — `monitor.test.ts :: blocks on a deviation just over the limit that the floored basis points would hide`
- expired cooldown keys are forgotten — `ops-adapters.test.ts :: forgets keys whose cooldown has passed, so the map does not grow with uptime`
- blocklist entries are normalised per network (TON friendly form matches) — `ops-adapters.test.ts :: normalises entries with the network's address parser: a TON address in friendly form matches the raw form the chain reports`
- the noop screener clears everything — NO TEST (trivial; covered indirectly by the flow tests that use it)

### Configuration and integrity
<!-- covers: src/app/config.ts, src/app/integrity.ts, src/app/duration.ts, src/app/logger.ts -->
- config parses into asset settings with exact amounts; unknown keys, bad addresses, plain-http providers and non-ISO currencies refused — `config.test.ts :: parses into asset settings with exact amounts`, `config.test.ts :: rejects unknown keys, bad addresses, plain-http providers and non-ISO currencies`
- an active address is required, duplicates refused — `config.test.ts :: requires an active address and no duplicates`
- the pinned checksum ignores ordering and changes with any address, status, contract or decimals; start refused without it or on mismatch — `config.test.ts :: pinned checksum ignores ordering but changes with any address, status, contract or decimals`, `config.test.ts :: refuses to start without the separately supplied checksum or on mismatch`
- the guard notices a config file changed on disk — `config.test.ts :: the guard notices a config file changed on disk`
- durations parse — `config.test.ts :: parses durations`
- TON: a jetton-wallet is required for jettons, forbidden elsewhere, pinned; friendly addresses pinned in canonical raw form — `config.test.ts :: requires a jetton-wallet for jettons, forbids it elsewhere, and pins it`, `config.test.ts :: accepts friendly addresses and pins their canonical raw form`
- the pin covers policies, providers, pricing, AML, depeg and the webhook URL, not operational knobs (ADR-0031) — `config.test.ts :: pins what decides money (ADR-0031): policies, providers, pricing, AML, depeg and the webhook URL; not operational knobs`
- a provider key variable must not be another secret — `config.test.ts :: a provider key variable must not be another secret`
- zero and overflowing durations refused; duplicate on-chain assets and an unused depeg symbol refused — `config.test.ts :: refuses zero durations and timer intervals Node would clamp to 1 ms`, `config.test.ts :: refuses two ids for one on-chain asset and a depeg symbol no asset is priced in`
- the logger redacts every path that may carry a secret — NO TEST (looked for a test that logs a config or request object and asserts `[redacted]`)
- every option in `docs/configuration.md` exists in the schema with the same default — NO TEST (cross-check of the documentation against `config.ts`)

### Processes and CLI
<!-- covers: src/app/cli.ts, src/app/container.ts, src/app/loop.ts -->
<!-- skip: scripts/e2e-nile.ts — live replay, run by `make e2e-nile` (phase 5) -->
<!-- skip: scripts/e2e-ton.ts — live replay, run by `make e2e-ton` (phase 5) -->
<!-- skip: scripts/e2e-api.ts — live replay with the PHP receiver, `make e2e-api` (phase 5) -->
<!-- skip: scripts/e2e-ops.ts — live reconciliation and depeg scenario, `make e2e-ops` (phase 5) -->
<!-- skip: scripts/e2e-mainnet.ts — read-only mainnet replay, `make e2e-mainnet` (phase 5) -->
- `run` starts every role it accepts, including `monitor`, and refuses an unknown role — NO TEST (the 0.2.1 fix; `cli.ts` has no test harness; the loop helper and the composition root are tested below)
- a loop keeps running after an exception in one cycle; cycles do not overlap; a stop request interrupts the sleep — `loop.test.ts :: keeps running after an exception in one cycle and never overlaps cycles`, `loop.test.ts :: a stop request interrupts the sleep: shutdown does not wait for the poll interval`, `loop.test.ts :: sleep resolves early on abort and leaves no timer behind`
- the composition root wires every configured network and no other; an asset without a provider is refused; an idle pool client error is logged, not thrown — `container.test.ts :: wires every configured network and no other`, `container.test.ts :: refuses an asset whose network has no provider section`, `container.test.ts :: a connection error on an idle database client is logged, not thrown`
- start-up refuses open invoices on an address removed from the config; draining, retired or only closed invoices start (ADR-0037) — `container.int.test.ts :: refuses to start while an open invoice points at an address removed from the config`, `container.int.test.ts :: starts when the address is kept as draining or retired`, `container.int.test.ts :: starts when only closed invoices are left on the removed address`
- the whole stack end to end against live testnets and mainnet (read-only) — replay scripts in `scripts/e2e-*.ts` (phase 5)
- the production image, migrations, all roles, key, invoice, page and the address canary from the image — `scripts/smoke-image.sh` (phase 5)

### Repository policies and release tooling
<!-- covers: scripts/check-layers.ts, scripts/check-licenses.ts, scripts/check-source.ts, scripts/check-dco.ts,
     scripts/sbom.ts, scripts/test-database.ts -->
- the layer check fails when dependency-cruiser analysed nothing and reports violations — `check-layers.test.ts :: fails when dependency-cruiser analysed nothing (reported as 'no violations')`, `check-layers.test.ts :: reports rule violations`, `check-layers.test.ts :: expects every non-test source file under src/`
- licence policy: permissive accepted, copyleft refused, MPL-2.0 for dev only — `policy.test.ts :: accepts permissive licenses and OR-expressions with one permissive option`, `policy.test.ts :: rejects copyleft licenses and AND-expressions containing them`, `policy.test.ts :: allows MPL-2.0 for dev-only dependencies but not for runtime ones`
- source policy: SPDX header, Math.random / parseFloat / eval, invisible and bidi characters — `policy.test.ts :: requires the SPDX header`, `policy.test.ts :: rejects Math.random, parseFloat and eval`, `policy.test.ts :: rejects invisible and bidi characters and reports their position`
- DCO: a sign-off matching the author — `policy.test.ts :: requires a sign-off matching the commit author`
- SBOM: lockfile integrity to hex, Node version from the pinned image, deterministic listing — `sbom.test.ts :: converts lockfile integrity to a hex SHA512 checksum`, `sbom.test.ts :: takes the Node version from the pinned base image only`, `sbom.test.ts :: lists the Node runtime and every package, deterministically`
- the e2e scripts reset only a database whose name ends in `_test` — `test-database.test.ts :: accepts only a database whose name ends in _test, because the scripts reset its schema`

## Phase 3. Stale and "empty" tests

Look for tests that pass with broken code:
- they assert only a status, a type or `toBeDefined()`, not the content
  (an invoice "paid" test that never checks the amount or the event);
- `await expect(p).rejects.toThrow()` without the message or the error
  class: any error passes, including a typo in a property name; the same
  for `toThrow()` on sync code;
- an assertion inside a loop, a callback or a branch that may never run —
  no `expect.assertions(n)` or a counter;
- they hand the code the state it should have produced itself (a
  candidate already `verified`, a slot already reserved, an event already
  in the outbox);
- fixtures edited to fit the current behaviour instead of the chain's
  truth (the TON `transfer_notification` fixture made the 0.1.0 scanner
  look right); for every recorded fixture there is a note where it was
  recorded from and that note still holds;
- the fake in `src/application/testing/` is more forgiving than PostgreSQL
  (no unique violation, no version check) — the use-case test proves
  nothing the integration test does not repeat;
- time taken from `Date.now()` instead of the injected `Clock`; a test that
  depends on the wall clock or on execution order of files;
- a snapshot or a long equality against a fixture that was generated by
  the code under test;
- `it.skip`, `it.todo`, `it.only` left in; a test whose title promises
  more than its assertions (mark "(checks less than it says: …)" in the
  checklist).

Manual mutations for money code (until a mutation tool is adopted, 3–5
per audit, record what the tests caught): flip the finality condition in
`verify`, compare the recipient case-insensitively, credit the indexer's
amount instead of the verified one, advance the cursor before the write,
drop the asset check in matching, change `>` to `>=` in the dust
threshold, skip the outbox write in one transition. Break the code, run
the relevant tests, restore from a copy of the file; a mutation nobody
caught is a `NO TEST` line above and a new test.
