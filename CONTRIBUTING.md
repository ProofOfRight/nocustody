# Contributing to nocustody

Thank you for helping. This is payment-verification code: correctness and security come before features.

## Ground rules

- **Clean room.** Do not copy code from other payment gateways, in particular GPL-licensed ones (BEpusdt, epusdt,
  Bicycle, Spice harvester, SHKeeper), and do not use them as a template for rewriting. Knowledge of *what* to verify
  is fine; their code is not.
- **Security requirements** in [docs/security.md](docs/security.md) are mandatory. If a change needs to deviate,
  discuss it in an issue first.
- **Significant decisions** get an ADR in [docs/adr/](docs/adr/README.md).

## Developer Certificate of Origin

All commits must be signed off ([DCO 1.1](https://developercertificate.org/)):

```bash
git commit -s
```

This adds `Signed-off-by: Your Name <you@example.org>` matching the commit author. CI rejects pull requests with
commits that are not signed off. No CLA is required.

## Development environment

Everything runs in Docker (`compose.yaml`); the host needs only Docker and `make`.

| Command | What it does |
|---|---|
| `make install` | `npm ci --ignore-scripts` in the dev container |
| `make check` | everything CI runs: lint, typecheck, layer rules, licenses, source policy, unit and integration tests |
| `make test` | unit tests |
| `make format` | apply Biome formatting and safe fixes |
| `make shell` | shell in the dev container |
| `make up` / `make down` | start / stop PostgreSQL |

Run `make check` before every commit.

## Code rules

- **Layers:** `src/domain` ← `src/application` ← `src/adapters` ← `src/app`. The domain is plain TypeScript: no I/O,
  no packages, no Node built-ins. The application layer imports only the domain. Enforced by dependency-cruiser.
- **TypeScript:** strict, ESM, erasable syntax only (no `enum`, `namespace`, parameter properties). Relative imports
  use the `.ts` extension.
- **Money:** `bigint` in minimal units only; rates as rationals. No floating point, no `parseFloat`.
- **Randomness:** `node:crypto` only (`randomBytes`, `randomUUID`). `Math.random` is rejected by the source policy.
- **Secrets:** compared with `crypto.timingSafeEqual`; never logged or returned.
- Every source file starts with `// SPDX-License-Identifier: Apache-2.0`.
- Tests next to the code: `*.test.ts` (unit), `*.int.test.ts` (needs PostgreSQL).

## Dependencies

Each new dependency is a deliberate decision. In the pull request, explain why it is needed, why it cannot reasonably
be written in-house, and its transitive footprint. Runtime dependencies must use MIT, BSD, ISC, Apache-2.0 or Unlicense
(or similar permissive) licenses; dev-only dependencies may also use MPL-2.0 ([ADR-0023](docs/adr/0023-mpl-for-dev-dependencies.md)).
GPL, AGPL and LGPL are not accepted. Versions are exact and the lockfile is committed; install scripts never run.

## Network adapter checklist

A pull request adding or changing a chain adapter must satisfy all of the following:

1. The asset is identified by its contract / master address from config, never by symbol, name or metadata.
2. Finality is defined explicitly and checked by a separate query of finalized state.
3. Execution success is checked (receipt result / aborted / bounce).
4. The recipient is compared against the pinned list of receiving addresses.
5. The idempotency key is unique within a transaction (log index / lt / instruction index).
6. Scan cursor: advances only after a durable write, overlaps the previous window, catches up after downtime
   instead of jumping ahead.
7. Tests cover: fake token, failed transaction, non-final transaction, several transfers in one transaction, dust,
   duplicate delivery, late payment.
8. External hosts, rate limits and costs are documented.

Changes to `src/domain`, `src/application` and `src/adapters/chains` require maintainer review.
