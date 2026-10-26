// SPDX-License-Identifier: Apache-2.0
// Source policy checks: SPDX header in every source file, and constructs forbidden by the security rules
// (docs/security.md): Math.random (use node:crypto), floating-point parsing, eval / new Function.
// Every text file in the repository is also checked for invisible and bidirectional-control characters.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "scripts", "tools", "test"];
const SPDX = "SPDX-License-Identifier: Apache-2.0";

export const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bMath\.random\s*\(/, reason: "use node:crypto randomBytes/randomUUID" },
  {
    pattern: /\bparseFloat\s*\(|\bNumber\.parseFloat\s*\(/,
    reason: "no floating point for amounts or rates",
  },
  { pattern: /\beval\s*\(|\bnew\s+Function\s*\(/, reason: "dynamic code execution" },
];

// Characters that hide text from a human reviewer while compilers and LLM agents still read it: zero-width and
// invisible formatting characters, bidi controls (Trojan Source, CVE-2021-42574), Unicode tags ("ASCII smuggling")
// and variation selectors used to smuggle bytes. U+FE0F (emoji presentation) is allowed.
// Variation selectors are a separate class: they combine with the preceding character.
export const INVISIBLE =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]|[\uFE00-\uFE0E\u{E0100}-\u{E01EF}]/gu;

const TEXT_FILE =
  /\.(ts|mjs|js|json|md|ya?ml|sql)$|(^|\/)(CODEOWNERS|Makefile|LICENSE|NOTICE|\.gitignore|\.npmrc)$/;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".cache", "internal-docs"]);

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

function* walkText(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkText(path);
    } else if (entry.isFile() && TEXT_FILE.test(path)) {
      yield path;
    }
  }
}

export function checkInvisible(path: string, text: string): string[] {
  const problems: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(INVISIBLE)) {
      const code = m[0].codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0");
      problems.push(`${path}:${i + 1}:${m.index + 1}: invisible or bidi character U+${code}`);
    }
  });
  return problems;
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
  let textCount = 0;
  for (const file of walkText(".")) {
    textCount++;
    problems.push(...checkInvisible(file, readFileSync(file, "utf8")));
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`source policy ok (${count} source files, ${textCount} text files)`);
}

if (import.meta.main) main();
