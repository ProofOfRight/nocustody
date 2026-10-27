# 0018. Node.js 26; development runs entirely in Docker

- Status: accepted
- Date: 2026-10-26

## Context

Per the Node.js release schedule (as of 2026-10-26), Node 24 entered Maintenance LTS on 2026-10-20 and Node 26 was due to become Active LTS on 2026-10-28. The owner wants local development to run in Docker.

## Decision

Target Node 26 (`engines: >=26`, CI on 26). All local development (install, lint, typecheck, tests, PostgreSQL) runs through docker compose; base images are pinned by version and digest, never `latest`.

## Consequences

Host only needs Docker (and `make`, `git`). Node 26 was Current, not yet LTS, when this was decided; it is scheduled to be Active LTS from 2026-10-28.
