# Releasing

For maintainers. Decisions: [ADR-0028](adr/0028-container-image.md) (image),
[ADR-0029](adr/0029-release-provenance.md) (provenance, SBOM).

## One-time repository setup

- Packages: the first release creates `ghcr.io/<owner>/nocustody`; make the package public and link it to the
  repository.
- Environment `release` with required reviewers (Settings → Environments), so a pushed tag waits for approval.
- Branch protection for `main` and a tag ruleset for `v*` (only maintainers create release tags).

## Steps

1. On `main`, with CI green: set `version` in `package.json` (and the root entries of `package-lock.json`) and add
   a `## [X.Y.Z] - YYYY-MM-DD` section to [CHANGELOG.md](../CHANGELOG.md). Commit (`git commit -s`).
2. Check locally: `make check` and `make smoke-image`.
3. Create a signed tag and push it:

   ```bash
   git tag -s vX.Y.Z -m "nocustody X.Y.Z"
   git push origin vX.Y.Z
   ```

4. The [release workflow](../.github/workflows/release.yml) runs the full CI, checks that the tag matches
   `package.json` and the changelog, builds and pushes `linux/amd64` + `linux/arm64`, attests build provenance and
   the SPDX SBOM for the image digest, and creates the GitHub release with the SBOM and the verification command.
5. Verify the published image the way operators do ([deployment.md](deployment.md#verify-the-image)), and rebuild
   it locally to compare digests (below).

## Reproducing a release build

```bash
git checkout vX.Y.Z
export SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)
docker buildx create --name repro --driver docker-container \
  --driver-opt image=moby/buildkit:v0.34.0@sha256:b059f8d7226d0b326bc871af489a5dddf65e36af4d20d14251b072974d9ee87c
docker buildx build --builder repro --platform linux/amd64,linux/arm64 \
  --build-arg SOURCE_DATE_EPOCH --build-arg VERSION=X.Y.Z --build-arg REVISION=$(git rev-parse HEAD) \
  --label org.opencontainers.image.source=https://github.com/<owner>/nocustody \
  --provenance=false --sbom=false \
  --output type=oci,dest=nocustody.tar,rewrite-timestamp=true --metadata-file metadata.json .
jq -r '."containerimage.digest"' metadata.json   # must equal the released digest
```

Use the BuildKit version from the release workflow of that tag.
