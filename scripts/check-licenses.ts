// SPDX-License-Identifier: Apache-2.0
// Fails if any installed package has a license outside the allowlist. Runtime dependencies (shipped) use the
// strict allowlist; dev-only dependencies (never shipped) additionally allow MPL-2.0.
// Policy: docs/adr/0006-apache-2-clean-room.md, docs/adr/0023-mpl-for-dev-dependencies.md.
// Uses `npm query`, no extra dependencies.
import { execFileSync } from "node:child_process";

const ALLOWED = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Python-2.0",
  "Unlicense",
]);
const DEV_ONLY_EXTRA = new Set(["MPL-2.0"]);

interface PackageInfo {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  location?: string;
}

// A license expression is acceptable if it is an allowed id, or an OR-expression with at least one allowed id.
export function isAllowed(expression: string, devOnly = false): boolean {
  const trimmed = expression.trim().replace(/^\((.*)\)$/, "$1");
  if (/\bAND\b/.test(trimmed)) return trimmed.split(/\s+AND\s+/).every((e) => isAllowed(e, devOnly));
  return trimmed.split(/\s+OR\s+/).some((raw) => {
    const id = raw.trim();
    return ALLOWED.has(id) || (devOnly && DEV_ONLY_EXTRA.has(id));
  });
}

function query(selector: string): PackageInfo[] {
  const out = execFileSync("npm", ["query", selector], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // The root project has an empty location.
  return (JSON.parse(out) as PackageInfo[]).filter((p) => p.location);
}

function licenseOf(p: PackageInfo): string | undefined {
  return typeof p.license === "string" ? p.license : p.license?.type;
}

function main(): void {
  const prod = query(".prod");
  const prodLocations = new Set(prod.map((p) => p.location));
  const dev = query("*").filter((p) => !prodLocations.has(p.location));
  const bad: string[] = [];
  for (const [list, devOnly] of [
    [prod, false],
    [dev, true],
  ] as const) {
    for (const p of list) {
      const raw = licenseOf(p);
      if (!raw || !isAllowed(raw, devOnly)) {
        bad.push(`${p.name}@${p.version} (${devOnly ? "dev" : "runtime"}): ${raw ?? "UNKNOWN"}`);
      }
    }
  }
  if (bad.length > 0) {
    console.error(`Disallowed or unknown licenses:\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`licenses ok (${prod.length} runtime, ${dev.length} dev packages)`);
}

if (import.meta.main) main();
