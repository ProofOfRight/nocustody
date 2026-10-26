# Architecture Decision Records

This index is the project's decision log. One file per decision; to change a decision, add a new ADR
that supersedes the old one and update the status column.

Template: `# NNNN. Title`, then Status, Date, and Context / Decision / Consequences sections.

| ADR | Date | Decision | Status |
|---|---|---|---|
| [0001](0001-own-code-not-fork.md) | 2026-10-25 | Own code instead of forking an existing gateway | accepted |
| [0002](0002-watch-only.md) | 2026-10-26 | Watch-only (non-custodial) gateway | accepted |
| [0003](0003-nodejs-typescript.md) | 2026-10-26 | Node.js + TypeScript (strict) | accepted |
| [0004](0004-separate-service-http.md) | 2026-10-26 | Separate service integrated via HTTP API and webhooks | accepted |
| [0005](0005-modular-monolith-hexagonal.md) | 2026-10-26 | Modular monolith, hexagonal architecture, DDD | accepted |
| [0006](0006-apache-2-clean-room.md) | 2026-10-26 | Apache-2.0 license, clean-room implementation | amended |
| [0007](0007-minimal-dependencies.md) | 2026-10-26 | Minimal dependencies, strict supply-chain policy | accepted |
| [0008](0008-transactional-outbox.md) | 2026-10-26 | Transactional outbox for webhooks | accepted |
| [0009](0009-independent-finality-check.md) | 2026-10-26 | Independent "final + successful" verification before crediting | accepted |
| [0010](0010-multi-currency-pricing.md) | 2026-10-26 | Multi-currency pricing as a first-class requirement | accepted |
| [0011](0011-project-name.md) | 2026-10-26 | Project name `nocustody`, separate GitHub organization | superseded in part |
| [0012](0012-fastify-manual-di.md) | 2026-10-26 | Fastify with a hand-written composition root | superseded in part |
| [0013](0013-single-package-npm.md) | 2026-10-26 | Single package, npm, enforced layer boundaries | accepted |
| [0014](0014-postgresql-only.md) | 2026-10-26 | PostgreSQL only, `pg` driver, plain SQL migrations | accepted |
| [0015](0015-thin-chain-clients.md) | 2026-10-26 | Thin in-house chain clients; official libraries only where parsing is risky | accepted |
| [0016](0016-single-tenant.md) | 2026-10-26 | Single-tenant installations | accepted |
| [0017](0017-documentation-language.md) | 2026-10-26 | Documentation language | amended |
| [0018](0018-node-26-docker-dev.md) | 2026-10-26 | Node.js 26; development runs entirely in Docker | accepted |
| [0019](0019-private-consumer-notes.md) | 2026-10-26 | Consumer-specific notes stay out of the public repository | superseded |
| [0020](0020-internal-docs-outside-repo.md) | 2026-10-26 | Internal working docs are kept outside the public repository | accepted |
| [0021](0021-biome.md) | 2026-10-26 | Biome for linting and formatting | accepted |
| [0022](0022-typescript-run-mode.md) | 2026-10-26 | Run TypeScript natively in development, compile for production | accepted |
| [0023](0023-mpl-for-dev-dependencies.md) | 2026-10-26 | MPL-2.0 allowed for dev-only dependencies | accepted |
| [0024](0024-unlicense-allowed.md) | 2026-10-26 | Unlicense allowed; TON libraries `@ton/core` and `@ton/crypto` | accepted |
| [0025](0025-http-api-on-node-http.md) | 2026-10-26 | HTTP API on node:http without a framework | accepted |
| [0026](0026-qr-code-library.md) | 2026-10-26 | qrcode-generator for QR codes | accepted |
| [0027](0027-hosted-payment-page.md) | 2026-10-26 | Hosted payment page without external resources | accepted |
| [0028](0028-container-image.md) | 2026-10-26 | Production container image from scratch with the official Node binary | accepted |
| [0029](0029-release-provenance.md) | 2026-10-26 | Releases: tag-triggered workflow, GitHub artifact attestations, own SBOM | accepted |
| [0030](0030-early-payment-tolerance.md) | 2026-10-26 | Early-payment tolerance of 5 seconds, separate from the slot margin | accepted |
| [0031](0031-pinned-config-scope.md) | 2026-10-26 | The pinned checksum covers everything that decides money, not only addresses | accepted |
| [0032](0032-repository-hosting.md) | 2026-10-26 | The repository is hosted under the maintainer's account | accepted |
| [0033](0033-release-isolated-signing.md) | 2026-10-27 | Release: build, attest and publish in separate jobs | accepted |
| [0034](0034-untrusted-code-sandbox.md) | 2026-10-27 | Code from others runs only in a sandbox | accepted |
