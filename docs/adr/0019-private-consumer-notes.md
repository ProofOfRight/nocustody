# 0019. Consumer-specific notes stay out of the public repository

- Status: superseded by [0020](0020-internal-docs-outside-repo.md)
- Date: 2026-10-26

## Context

The brief contained business details of the first consumer (audience, backup processors, owner decisions) that are not part of the open-source project.

## Decision

Keep them in `docs/private/`, which is git-ignored.

## Consequences

The public repository contains no consumer-specific logic or notes.
