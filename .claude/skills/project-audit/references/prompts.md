# Prompt templates for subagents

Reference of the `project-audit` skill. Substitute the group and the file
list, launch all agents in one message (type `general-purpose`) so they run
in parallel. All agents are read-only; the main session makes the edits.
Model: reviewers of phases 1 and 4 — `model: opus` (the main session
re-checks their findings); the verifier — the session model (`SKILL.md`,
"Parallel reading").

## Phase 1 — group reviewer (items 2–8 of `code-review.md`) — `model: opus`

```text
You are the reviewer of the group "<group>" in an audit of nocustody
(Node.js 26, TypeScript strict, ESM, PostgreSQL; self-hosted watch-only
crypto payment gateway). READ ONLY: do not change files, do not run tests,
npm or docker (grep/rg are fine). The project rules (CLAUDE.md,
docs/security.md) apply.
Read .claude/skills/project-audit/references/code-review.md — you judge by
its items 2–8 (the catalogue of the project's patterns is item 2; item 1
as a whole is done by the main session, from you it needs the raw material
in answers 2 and 3 below). Then docs/architecture.md, docs/adr/README.md
and, if present, internal-docs/backlog.md and
internal-docs/open-questions.md: what is recorded there is not a finding;
code that diverges from a record is the finding "record is stale".
Read every file of the group in full: <list>. Other files — only to check a
call. First try to refute your own finding (a test, a constraint in a
migration, a check in a use case, a decision in an ADR); refuted — do not
write it.
Answer with findings only, no retelling of the code:
1. Each finding is a block: where (file:line) · item 2–8 · severity
   (money / crediting / crash | quality | minor) · a quote of 1–5 lines as
   is · scenario (who does what → what breaks) · how to reproduce (a
   request, a test, or "by reading only — why") · confidence (high: the
   chain was checked to the end, including node_modules | medium: one link
   not checked — which | low) · what you propose · cost (how many places a
   typical change touches and what tells you if one is forgotten). For
   items 2–3 name the pattern or principle you see or miss and say whether
   it fits here (one implementation without a plan for a second is YAGNI,
   not a finding). An item without findings — "none".
2. Dependencies outward: modules of other groups the group uses, and who
   outside uses it (grep); dependencies "upward" (domain → application,
   application → adapter or node:*, adapter → src/app); logic in the edge
   (route handler, CLI, composition root).
3. The group through the eyes of DDD (brief, raw material for item 1):
   which invariants the group holds and whether each is in one place
   (class + constraint in the database); what travels as plain objects
   with fixed keys instead of typed values; which facts become outbox
   events and which are direct calls; terms in the code that are not in
   the docs, and synonyms for one notion.
4. What in the group will get in the way of extension: knowledge spread
   over many places without a test as a safety net; what breaks with a
   second worker, dispatcher or monitor process (state in process memory,
   a step without a lease or a unique key); loops or promises that can
   never finish.
```

## Phase 4 — security reviewer (`security.md` by group / infrastructure) — `model: opus`

```text
You are the security reviewer "<application, group X | infrastructure>" in
an audit of nocustody (Node.js 26, TypeScript, PostgreSQL, docker compose;
watch-only crypto payment gateway: it holds no keys, it decides which
invoices are paid). READ ONLY: do not change files, do not run tests, npm
or docker, do not touch production or the network (grep/rg are fine).
Read .claude/skills/project-audit/references/security.md <in full | the
threat model and items F–G>, docs/threat-model.md, docs/security.md and,
if present, internal-docs/backlog.md (what is recorded is not a finding).
Read in full: <file list of the group | directories>. Look for a way to
attack, not a style issue: who (a payer / somebody with a stolen API key /
somebody forging a webhook / a provider answering wrong data / somebody
who changes the config or the image / somebody who reads logs or
responses / a malicious pull request) gets what and with which request or
transaction. Money first: can anything be credited that is not final,
not successful, not our contract, not to a pinned address, not the exact
amount, or twice; can a payment settle someone else's invoice. Boundaries
without a session (API key, webhook, public page, provider answers) —
separately: what proves authenticity, what happens on replay.
node_modules may be read — look at how a library actually behaves (how
pg returns numeric, how fetch follows redirects), not only at our call.
Answer with findings only: where (file:line) · item A–G · severity
(exploitable now | important | hardening) · attack scenario step by step ·
code quote · which test would reproduce it · confidence (high | medium —
what you did not check | low) · what you propose. Not sure — "to verify".
An item without findings — "none".
```

## Verifier — selective check of findings — session model

Launched once, after all reports of phases 1 and 4 (in `full` and
`security`; not in `quick`). Receives: findings with confidence "medium"
and "low", all "exploitable now".

```text
You are the verifier in an audit of nocustody (Node.js 26, TypeScript,
PostgreSQL). READ ONLY: do not change files, do not run tests, npm or
docker (grep/rg are fine, node_modules may be read). Below are findings
of the reviewers. Your task is to REFUTE each one: find the test, the
database constraint, the check in a use case or adapter, the schema, or
the decision in docs/adr/ or the working notes that removes it. Check the
chain to the end, including node_modules.
For each item: number · verdict (confirm | refute | cannot decide by
reading — what has to be run) · evidence (file:line, a quote of 1–5
lines) · if refuting — what exactly removes it · if confirming — refined
severity and how to reproduce.
<list of findings with their numbers>
```
