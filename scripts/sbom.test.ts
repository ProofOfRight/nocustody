// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { checksumOf, nodeFromImage, spdxDocument } from "./sbom.ts";

const IMAGE = `node:26.12.1-alpine3.24@sha256:${"a".repeat(64)}`;

describe("sbom", () => {
  it("converts lockfile integrity to a hex SHA512 checksum", () => {
    const hex = "ab".repeat(64);
    const integrity = `sha512-${Buffer.from(hex, "hex").toString("base64")}`;
    expect(checksumOf(integrity)).toEqual([{ algorithm: "SHA512", checksumValue: hex }]);
    expect(checksumOf("sha1-abc")).toEqual([]);
    expect(checksumOf(undefined)).toEqual([]);
  });

  it("takes the Node version from the pinned base image only", () => {
    expect(nodeFromImage(IMAGE)).toEqual({ version: "26.12.1", ref: IMAGE });
    expect(() => nodeFromImage("node:26-alpine")).toThrow();
  });

  it("lists the Node runtime and every package, deterministically", () => {
    const input = {
      version: "0.1.0",
      repository: "https://github.com/example/nocustody",
      created: new Date(1_793_000_000_000),
      nodeImage: IMAGE,
      packages: [
        { name: "zod", version: "4.6.7", location: "node_modules/zod", license: "MIT" },
        { name: "@ton/core", version: "0.63.1", location: "node_modules/@ton/core", license: "MIT" },
      ],
    };
    const doc = spdxDocument(input) as {
      spdxVersion: string;
      creationInfo: { created: string };
      packages: { SPDXID: string; name: string; externalRefs?: { referenceLocator: string }[] }[];
      relationships: { relatedSpdxElement: string }[];
    };
    expect(doc.spdxVersion).toBe("SPDX-2.3");
    expect(doc.creationInfo.created).toBe("2026-10-26T07:33:20Z");
    expect(doc.packages.map((p) => p.name)).toEqual(["nocustody", "node", "@ton/core", "zod"]);
    expect(doc.packages[2]?.externalRefs?.[0]?.referenceLocator).toBe("pkg:npm/%40ton/core@0.63.1");
    expect(new Set(doc.packages.map((p) => p.SPDXID)).size).toBe(4);
    const ids = new Set(doc.packages.map((p) => p.SPDXID));
    for (const r of doc.relationships) expect(ids.has(r.relatedSpdxElement)).toBe(true);
    expect(JSON.stringify(spdxDocument({ ...input, packages: [...input.packages].reverse() }))).toBe(
      JSON.stringify(doc),
    );
  });
});
