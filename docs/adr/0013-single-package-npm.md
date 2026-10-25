# 0013. Single package, npm, enforced layer boundaries

- Status: accepted
- Date: 2026-10-26

## Context

Nothing is published as a separate package yet; pnpm would be one more tool.

## Decision

One npm package with `src/{domain,application,adapters,app}`. Layer boundaries are enforced by dependency-cruiser in CI. Package manager: npm, `ignore-scripts=true` in `.npmrc`.

## Consequences

Can be split into workspaces later without rewriting code.
