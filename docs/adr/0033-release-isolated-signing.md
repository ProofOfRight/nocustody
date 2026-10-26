# 0033. Release: build, attest and publish in separate jobs

- Status: accepted
- Date: 2026-10-27

## Context

Until 0.3.1 one job of `.github/workflows/release.yml` held `id-token: write` (the Sigstore identity behind the
attestations) and also ran `npm ci`, BuildKit and `node scripts/sbom.ts`. Any code executing in that job — a bug in
npm or BuildKit on the runner, a future step that runs package code — could request the OIDC token and sign
provenance for any digest. SLSA build level 3 asks for signing isolated from the build steps.

## Decision

The release has three jobs after CI ([ADR-0029](0029-release-provenance.md) otherwise stands):

- `build` (`contents: read`, `packages: write`, environment `release`): checks the tag, builds and pushes the image,
  smoke-tests the pushed digest, generates the SPDX SBOM and hands the digest (job output) and the SBOM (workflow
  artifact) on. Every later job needs it, so the environment approval gates the whole release.
- `attest` (`id-token: write`, `attestations: write`, `artifact-metadata: write`, `packages: write`): no checkout, no
  npm, no BuildKit — only `actions/download-artifact`, the runner's `docker login` and `actions/attest`, all pinned
  by commit SHA. It signs provenance and the SBOM for exactly the digest `build` reported.
- `publish` (`contents: write`): creates the GitHub release with the SBOM and the verification command.

## Consequences

- The build job can still choose which digest gets attested — that is inherent to the builder being trusted — but no
  code from the repository or its dependencies ever runs where a signing token can be requested.
- Two more GitHub-owned actions in the release path (`upload-artifact`, `download-artifact`), pinned by SHA and
  updated through Dependabot like the others.
- What operators verify does not change: the signer workflow is still `release.yml` at the release tag.
