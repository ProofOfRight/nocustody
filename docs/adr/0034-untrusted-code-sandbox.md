# 0034. Code from others runs only in a sandbox

- Status: accepted
- Date: 2026-10-27

## Context

`make check` runs tests, `vitest.config.ts`, `scripts/` and about 120 dev packages in the dev container, which mounts
the whole repository read-write (`.git`, `.claude/`, untracked notes such as `CLAUDE.local.md`), has the network and
receives `TRONGRID_API_KEY`. The container user (`node`, uid 1000) is usually the host user's uid as well. A malicious pull request or a compromised
package in a dependency update could write `.git/hooks` or `core.fsmonitor` in `.git/config` (run by the host's git,
including the `git status` an agent runs at start-up), rewrite agent settings, or send keys and notes away.
`CLAUDE.md` tells agents to run `make check`, so an agent would do this by itself.

## Decision

- `compose.yaml` gets a profile `untrusted`: the pull request's git worktree read-only as `/app`, nothing of this
  repository mounted, an internal network without a route out (no external DNS either), no API keys, no
  capabilities, `no-new-privileges`, a read-only root file system, memory and process limits, and its own
  PostgreSQL with data in tmpfs. Dependencies are this repository's `node_modules` (read-only) unless the pull
  request changes `package.json` / `package-lock.json`; then `make install-untrusted` installs them into the worktree
  (`npm ci --ignore-scripts`, the only sandbox step with network) after the maintainer read the lockfile diff.
- `make check-untrusted PR_DIR=…` runs `npm run check` there. CONTRIBUTING.md documents the procedure.
- `CLAUDE.md`: code an agent did not write — pull requests, dependency and lockfile updates, Dependabot included —
  runs only through these targets.

## Consequences

- Reviewing a pull request locally needs a worktree outside the repository; agents get the diff as data and are not
  started inside the worktree (its own `CLAUDE.md` and `.claude/` would apply).
- Not covered: code merged after review (it then runs in the dev container like any other code), kernel or Docker
  escapes, and text planted in test output that an agent reads.
