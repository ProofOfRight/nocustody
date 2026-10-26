// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { layerProblems, sourceFiles } from "./check-layers.ts";

const ok = { violations: [], error: 0 };

describe("layer check", () => {
  it("fails when dependency-cruiser analysed nothing (reported as 'no violations')", () => {
    const problems = layerProblems({ modules: [], summary: ok }, ["src/domain/a.ts", "src/app/b.ts"]);
    expect(problems).toEqual(["2 of 2 source files were not analysed, e.g. src/domain/a.ts, src/app/b.ts"]);
  });

  it("passes when every source file was analysed and there are no violations", () => {
    const modules = [{ source: "src/domain/a.ts" }, { source: "node_modules/zod/index.js" }];
    expect(layerProblems({ modules, summary: ok }, ["src/domain/a.ts"])).toEqual([]);
  });

  it("reports rule violations", () => {
    const summary = {
      error: 1,
      violations: [
        { rule: { name: "domain-is-pure", severity: "error" }, from: "src/domain/a.ts", to: "pg" },
      ],
    };
    expect(layerProblems({ modules: [{ source: "src/domain/a.ts" }], summary }, ["src/domain/a.ts"])).toEqual(
      ["error domain-is-pure: src/domain/a.ts → pg"],
    );
  });

  it("expects every non-test source file under src/", () => {
    const files = sourceFiles("src");
    expect(files).toContain("src/domain/money.ts");
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });
});
