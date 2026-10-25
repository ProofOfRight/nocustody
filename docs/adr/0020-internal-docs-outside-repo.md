# 0020. Internal working docs are kept outside the public repository

- Status: accepted
- Date: 2026-10-26

## Context

Most working documents (project brief, research notes, audit details, roadmap, open questions) are in Russian and written for the maintainer, not for contributors.

## Decision

`docs/` contains only English documentation the community needs (ADRs, architecture, security requirements, threat model, testnet guide). Internal working docs live in `internal-docs/`, which is git-ignored and versioned as a separate local repository. Anything that affects contributors' code must be published in English as an ADR or in `docs/`.

## Consequences

Rationale behind decisions is visible to contributors only through ADRs. Supersedes [0019](0019-private-consumer-notes.md) and the working-docs part of [0017](0017-documentation-language.md).
