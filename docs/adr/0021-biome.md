# 0021. Biome for linting and formatting

- Status: accepted
- Date: 2026-10-26

## Context

ESLint + typescript-eslint + Prettier pull in on the order of a hundred packages, against [ADR-0007](0007-minimal-dependencies.md).

## Decision

Use `@biomejs/biome` as the single linter and formatter.

## Consequences

Some ESLint-only rules are unavailable; layer boundaries are checked by dependency-cruiser ([ADR-0013](0013-single-package-npm.md)).
