# 0007. Minimal dependencies, strict supply-chain policy

- Status: accepted
- Date: 2026-10-26

## Context

Payment code plus npm is the main package-substitution risk.

## Decision

Each dependency is a justified decision recorded in the PR. Exact versions, committed lockfile, `npm ci --ignore-scripts`, Dependabot/Renovate with manual review, `npm audit` in CI; later signed releases, SBOM, provenance. No `latest` tags in Docker files. Details: [security.md](../security.md).

## Consequences

Some functionality (e.g. base58, migrations runner) is written in-house instead of pulled in.
