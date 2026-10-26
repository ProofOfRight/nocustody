// SPDX-License-Identifier: Apache-2.0
// Layer rules (.dependency-cruiser.mjs) with a completeness check. dependency-cruiser reports "no violations" with
// exit code 0 even when it parsed nothing (e.g. with an unsupported TypeScript version it cruised 0 modules), so
// this fails unless every source file under src/ was actually analysed.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Files the config excludes from analysis (keep in sync with options.exclude in .dependency-cruiser.mjs). */
const EXCLUDED = /(\.test\.ts|\/test-fixtures\.ts|\/testing\/.*)$/;

export interface CruiseResult {
  modules: { source: string }[];
  summary: {
    violations: { rule: { name: string; severity: string }; from: string; to: string }[];
    error: number;
  };
}

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name).replaceAll("\\", "/"))
    .filter((p) => !EXCLUDED.test(p))
    .sort();
}

/** Problems with a cruise result: rule violations, and expected files that were never analysed. */
export function layerProblems(result: CruiseResult, expected: readonly string[]): string[] {
  const cruised = new Set(result.modules.map((m) => m.source));
  const missed = expected.filter((f) => !cruised.has(f));
  return [
    ...result.summary.violations.map((v) => `${v.rule.severity} ${v.rule.name}: ${v.from} → ${v.to}`),
    ...(missed.length > 0
      ? [
          `${missed.length} of ${expected.length} source files were not analysed, e.g. ${missed.slice(0, 3).join(", ")}`,
        ]
      : []),
  ];
}

function main(): void {
  const run = spawnSync(
    "node_modules/.bin/depcruise",
    ["src", "--config", ".dependency-cruiser.mjs", "--output-type", "json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  if (run.stderr) process.stderr.write(run.stderr);
  const result = JSON.parse(run.stdout) as CruiseResult;
  const expected = sourceFiles("src");
  const problems = layerProblems(result, expected);
  if (problems.length > 0) {
    console.error(`Layer check failed:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`layers ok (${expected.length} source files analysed, no violations)`);
}

if (import.meta.main) main();
