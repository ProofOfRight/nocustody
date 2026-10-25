// SPDX-License-Identifier: Apache-2.0
// Source policy checks: SPDX header in every source file, and constructs forbidden by the security rules
// (docs/security.md): Math.random (use node:crypto), floating-point parsing, eval / new Function.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "scripts", "test"];
const SPDX = "SPDX-License-Identifier: Apache-2.0";

export const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bMath\.random\s*\(/, reason: "use node:crypto randomBytes/randomUUID" },
  {
    pattern: /\bparseFloat\s*\(|\bNumber\.parseFloat\s*\(/,
    reason: "no floating point for amounts or rates",
  },
  { pattern: /\beval\s*\(|\bnew\s+Function\s*\(/, reason: "dynamic code execution" },
];

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true, encoding: "utf8" });
  } catch {
    return; // root does not exist (yet)
  }
  for (const name of names) {
    if (/\.(ts|mjs|js)$/.test(name)) yield join(dir, name);
  }
}

export function checkFile(path: string, text: string): string[] {
  const problems: string[] = [];
  if (!text.split("\n", 3).some((l) => l.includes(SPDX))) problems.push(`${path}: missing "${SPDX}" header`);
  // The policy implementation and its tests name the forbidden patterns themselves.
  if (!/scripts\/(check-source|policy\.test)\.ts$/.test(path)) {
    for (const { pattern, reason } of FORBIDDEN) {
      if (pattern.test(text)) problems.push(`${path}: ${pattern.source} — ${reason}`);
    }
  }
  return problems;
}

function main(): void {
  const problems: string[] = [];
  let count = 0;
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      count++;
      problems.push(...checkFile(file, readFileSync(file, "utf8")));
    }
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`source policy ok (${count} files)`);
}

if (import.meta.main) main();
