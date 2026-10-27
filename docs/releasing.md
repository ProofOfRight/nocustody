# Releasing

For maintainers. Decisions: [ADR-0028](adr/0028-container-image.md) (image),
[ADR-0029](adr/0029-release-provenance.md) (provenance, SBOM), [ADR-0033](adr/0033-release-isolated-signing.md)
(signing isolated from the build).

## One-time repository setup

- Packages: the first release creates `ghcr.io/<owner>/nocustody`; make the package public and link it to the
  repository.
- Environment `release` with required reviewers (Settings → Environments), so a pushed tag waits for approval.
- A ruleset for `main`: changes only through pull requests with a code-owner review, the CI checks (`check`,
  both `image` jobs, `dco`) required and up to date, linear history, no force-push or deletion. Administrators may
  bypass it only through a pull request, so a direct push to `main` is refused for everyone.
- A tag ruleset for `v*`: only maintainers create, move or delete release tags.

## Steps

1. In a pull request to `main`: set `version` in `package.json` (and the root entries of `package-lock.json`) and
   add a `## [X.Y.Z] - YYYY-MM-DD` section to [CHANGELOG.md](../CHANGELOG.md) (`git commit -s`).
2. Check locally: `make check` and `make smoke-image`. Merge the pull request once CI is green.
3. On the merged commit of `main`, create a signed tag and push it (the workflow refuses commits that are not on
   `main`):

   ```bash
   git tag -s vX.Y.Z -m "nocustody X.Y.Z"
   git push origin vX.Y.Z
   ```

4. The [release workflow](../.github/workflows/release.yml) runs the full CI, then three jobs: `build` (waits for
   the `release` environment approval; checks that the tag matches `package.json` and the changelog, builds and
   pushes `linux/amd64` + `linux/arm64`, smoke-tests the pushed digest, generates the SPDX SBOM), `attest` (signs
   build provenance and the SBOM for that digest; the only job with an OIDC token, and it runs no repository code)
   and `publish` (the GitHub release with the SBOM and the verification command).
5. Verify the published image the way operators do ([deployment.md](deployment.md#verify-the-image)), and rebuild
   it locally to compare digests (below).
6. Add the donation addresses to the release notes (`gh release edit vX.Y.Z --notes-file ...`), copied from your
   wallets, not from the repository, and check that they match [DONATE.md](../DONATE.md). The latest release is
   the second source donors compare against.

## Reproducing a release build

```bash
git clone --branch vX.Y.Z https://github.com/<owner>/nocustody.git nocustody-vX.Y.Z && cd nocustody-vX.Y.Z
export SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)
docker buildx create --name repro --driver docker-container \
  --driver-opt image=moby/buildkit:v0.34.0@sha256:b059f8d7226d0b326bc871af489a5dddf65e36af4d20d14251b072974d9ee87c
docker buildx build --no-cache --builder repro --platform linux/amd64,linux/arm64 \
  --build-arg SOURCE_DATE_EPOCH --build-arg VERSION=X.Y.Z --build-arg REVISION=$(git rev-parse HEAD) \
  --label org.opencontainers.image.source=https://github.com/<owner>/nocustody \
  --provenance=false --sbom=false \
  --output type=oci,dest=nocustody.tar,rewrite-timestamp=true --metadata-file metadata.json .
jq -r '."containerimage.digest"' metadata.json   # must equal the released digest
docker buildx rm repro
```

Use the BuildKit version from the release workflow of that tag. `rewrite-timestamp` only lowers file times newer
than `SOURCE_DATE_EPOCH`; an older time stays in the image and the digest differs, although the files are the same.
Hence two rules. Build from a fresh clone, not from a working copy where you ran `git checkout`: files that did not
change keep the time they were first written (CI checks out fresh, so every file is newer and gets lowered). And keep
`--no-cache` when the builder has built anything before: a layer taken from the cache of an earlier build keeps its
older times.
Remove the builder after the check: the `docker-container` driver keeps a running container and a cache volume of
several gigabytes, and the next rebuild creates a fresh builder and runs with `--no-cache` anyway.
