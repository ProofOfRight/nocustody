// SPDX-License-Identifier: Apache-2.0
// SPDX 2.3 SBOM of what the production image ships: the Node runtime from the pinned base image and every runtime
// npm package (`npm query .prod`, the same set the license check uses) with the lockfile's integrity hash.
// `npm sbom --omit dev` is not used: it drops runtime packages that dev dependencies also require (e.g. pg-types).
// Output is deterministic: the creation time comes from SOURCE_DATE_EPOCH (the release commit time).
//   node scripts/sbom.ts > nocustody-<version>.spdx.json
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface RuntimePackage {
  name: string;
  version: string;
  location: string;
  license?: string | undefined;
  resolved?: string | undefined;
  integrity?: string | undefined;
}

interface QueriedPackage {
  name: string;
  version: string;
  location: string;
  license?: string | { type?: string };
  resolved?: string;
}

export interface SbomInput {
  version: string;
  repository: string;
  created: Date;
  nodeImage: string;
  packages: RuntimePackage[];
}

const NOASSERTION = "NOASSERTION";

function spdxId(name: string, version: string): string {
  return `SPDXRef-Package-${`${name}-${version}`.replace(/[^A-Za-z0-9.-]/g, "-")}`;
}

function purl(name: string, version: string): string {
  return `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;
}

/** `sha512-<base64>` (lockfile integrity) → SPDX checksum. */
export function checksumOf(integrity: string | undefined): { algorithm: string; checksumValue: string }[] {
  const m = integrity?.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
  return m?.[1] ? [{ algorithm: "SHA512", checksumValue: Buffer.from(m[1], "base64").toString("hex") }] : [];
}

/** `node:26.12.1-alpine3.24@sha256:...` → Node version and the full reference. */
export function nodeFromImage(ref: string): { version: string; ref: string } {
  const m = ref.match(/^node:(\d+\.\d+\.\d+)-[^@]+@sha256:[0-9a-f]{64}$/);
  if (!m?.[1]) throw new Error(`unexpected NODE_IMAGE: ${ref}`);
  return { version: m[1], ref };
}

export function spdxDocument(input: SbomInput): Record<string, unknown> {
  const rootId = "SPDXRef-Package-nocustody";
  const node = nodeFromImage(input.nodeImage);
  const nodeId = spdxId("node", node.version);
  const packages = [...input.packages].sort((a, b) => a.location.localeCompare(b.location));
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `nocustody-${input.version}`,
    documentNamespace: `${input.repository}/releases/tag/v${input.version}#spdx`,
    creationInfo: {
      created: input.created.toISOString().replace(/\.\d{3}Z$/, "Z"),
      creators: ["Tool: nocustody-scripts-sbom"],
    },
    packages: [
      {
        SPDXID: rootId,
        name: "nocustody",
        versionInfo: input.version,
        downloadLocation: `git+${input.repository}.git@v${input.version}`,
        filesAnalyzed: false,
        licenseConcluded: "Apache-2.0",
        licenseDeclared: "Apache-2.0",
        copyrightText: NOASSERTION,
        primaryPackagePurpose: "APPLICATION",
      },
      {
        SPDXID: nodeId,
        name: "node",
        versionInfo: node.version,
        downloadLocation: `docker.io/library/${node.ref}`,
        filesAnalyzed: false,
        licenseConcluded: NOASSERTION,
        licenseDeclared: "MIT",
        copyrightText: NOASSERTION,
        comment:
          "Node binary with its musl, libstdc++, libgcc_s and libatomic runtime, copied from this image",
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: `pkg:generic/node@${node.version}`,
          },
        ],
      },
      ...packages.map((p) => ({
        SPDXID: spdxId(p.name, p.version),
        name: p.name,
        versionInfo: p.version,
        downloadLocation: p.resolved ?? NOASSERTION,
        filesAnalyzed: false,
        licenseConcluded: NOASSERTION,
        licenseDeclared: p.license ?? NOASSERTION,
        copyrightText: NOASSERTION,
        checksums: checksumOf(p.integrity),
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: purl(p.name, p.version),
          },
        ],
      })),
    ],
    relationships: [
      { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: rootId },
      { spdxElementId: rootId, relationshipType: "DEPENDS_ON", relatedSpdxElement: nodeId },
      ...packages.map((p) => ({
        spdxElementId: rootId,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: spdxId(p.name, p.version),
      })),
    ],
  };
}

function main(): void {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? "");
  if (!Number.isSafeInteger(epoch) || epoch <= 0)
    throw new Error("SOURCE_DATE_EPOCH (commit time) is not set");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
    packages: Record<string, { integrity?: string }>;
  };
  const refs = new Set(
    [...readFileSync("Dockerfile", "utf8").matchAll(/^FROM (?:--platform=\S+ )?(node:\S+)/gm)].map(
      (m) => m[1],
    ),
  );
  const [nodeImage] = refs;
  if (refs.size !== 1 || !nodeImage)
    throw new Error(`Dockerfile must use one Node image, found: ${[...refs]}`);
  const raw = execFileSync("npm", ["query", ".prod"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const packages = (JSON.parse(raw) as QueriedPackage[])
    .filter((p) => p.location)
    .map((p) => ({
      name: p.name,
      version: p.version,
      location: p.location,
      license: typeof p.license === "string" ? p.license : p.license?.type,
      resolved: p.resolved,
      integrity: lock.packages[p.location]?.integrity,
    }));
  const repository = `https://github.com/${process.env.GITHUB_REPOSITORY ?? "ProofOfRight/nocustody"}`;
  const doc = spdxDocument({
    version: pkg.version,
    repository,
    created: new Date(epoch * 1000),
    nodeImage,
    packages,
  });
  console.log(JSON.stringify(doc, null, 2));
}

if (import.meta.main) main();
