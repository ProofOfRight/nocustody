# 0028. Production container image from scratch with the official Node binary

- Status: accepted
- Date: 2026-10-26

## Context

The gateway is deployed as a container. Security requirements (docs/security.md, supply chain): pinned base images,
no `latest`, minimal attack surface, non-root, read-only filesystem. Every runtime dependency is plain JavaScript
(no native modules), so only the Node binary is platform specific.

Options considered: the `node:alpine` image as is (ships a shell, apk, npm and corepack); Google distroless
`nodejs` images (no shell, but a second image publisher, and `gcr.io` was not reachable from the development
environment, so the image could not be verified); a `scratch` image assembled from the official Node image.

## Decision

Build `FROM scratch`. Dependencies (`npm ci --omit=dev --ignore-scripts`) and the TypeScript build run once on the
build platform; the runtime stage copies from the official `node:<version>-alpine` image for the target platform
only `node`, the musl loader and the C++ runtime it links against (`libstdc++`, `libgcc_s`, `libatomic`). The image
contains no shell, package manager or npm; files belong to root and the process runs as UID/GID 65532. The base
image is the same one as the dev container, pinned by version and multi-arch index digest.

Builds are reproducible: with `SOURCE_DATE_EPOCH` set to the commit time and BuildKit `rewrite-timestamp=true`,
two clean builds produce the same image digest.

## Consequences

- Multi-arch images need no emulation: nothing runs on the target platform.
- No `docker exec sh` for debugging; operators use `node` (`--entrypoint /usr/local/bin/node`) or a sidecar.
- A Node update means bumping one pinned reference (Dependabot watches the Dockerfile). If the official image
  starts linking `node` against another library, the image stops starting and the smoke test fails
  (`scripts/smoke-image.sh`).
- Node uses its bundled CA store; custom CAs are added with `NODE_EXTRA_CA_CERTS` and a mounted file.
