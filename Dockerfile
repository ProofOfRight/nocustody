# SPDX-License-Identifier: Apache-2.0
# Production image, see docs/adr/0028-container-image.md and docs/deployment.md.
#
# The application is plain JavaScript (no native modules), so dependencies are installed and the code is compiled
# once on the build platform. The runtime stage takes only the Node binary and the C/C++ runtime it links against
# from the official image for the target platform: no shell, no package manager, no npm.
#
# Every stage uses the same Node image as the dev container in compose.yaml, pinned by version and multi-arch index
# digest. It is written out in each FROM (not an ARG) so that Dependabot can update it; keep the four identical.

# Production dependencies only, from the lockfile, lifecycle scripts disabled.
FROM --platform=$BUILDPLATFORM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM --platform=$BUILDPLATFORM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Account database and a sticky /tmp for the scratch image (text files, platform independent).
FROM --platform=$BUILDPLATFORM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS rootfs
RUN mkdir -p /out/etc /out/tmp \
 && chmod 1777 /out/tmp \
 && echo 'nonroot:x:65532:65532:nonroot:/nonexistent:/sbin/nologin' > /out/etc/passwd \
 && echo 'nonroot:x:65532:' > /out/etc/group

# Target platform: only files are copied out of it, nothing runs there (no emulation for multi-arch builds).
FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS node

FROM scratch
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="nocustody" \
      org.opencontainers.image.description="Self-hosted, non-custodial (watch-only) crypto payment gateway" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
COPY --from=rootfs /out/ /
COPY --from=node /lib/ld-musl-*.so.1 /lib/libc.musl-*.so.1 /lib/
COPY --from=node /usr/lib/libstdc++.so.6* /usr/lib/libgcc_s.so.1 /usr/lib/libatomic.so.1* /usr/lib/
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=deps /src/node_modules /app/node_modules
COPY --from=build /src/dist /app/dist
COPY package.json LICENSE NOTICE /app/
# Files belong to root and are not writable by the process; run with a read-only root filesystem.
USER 65532:65532
WORKDIR /app
ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/node", "/app/dist/app/cli.js"]
CMD ["run"]
