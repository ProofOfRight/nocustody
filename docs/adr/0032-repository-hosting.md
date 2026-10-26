# 0032. The repository is hosted under the maintainer's account

- Status: accepted
- Date: 2026-10-26

## Context

[ADR-0011](0011-project-name.md) planned a separate GitHub organization for the project. It was not created: the
repository was published as `github.com/ProofOfRight/nocustody`, releases go to `ghcr.io/proofofright/nocustody`,
and the release attestations name that repository and its release workflow.

## Decision

Host the repository, the container image and the releases under the maintainer's account `ProofOfRight`. The
project name stays `nocustody`. Moving to an organization is postponed; it would need a new ADR.

## Consequences

Documentation, the image name and the attestation checks (`gh attestation verify … --repo ProofOfRight/nocustody`)
refer to this account. A later move to an organization changes the image name and the `--repo` operators verify
against, so it is announced in the changelog and the deployment guide. Supersedes the hosting part of 0011; the name
decision stands.
