// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { isAllowed } from "./check-licenses.ts";
import { checkFile } from "./check-source.ts";

const HEADER = "// SPDX-License-Identifier: Apache-2.0\n";

describe("license policy", () => {
  it("accepts permissive licenses and OR-expressions with one permissive option", () => {
    expect(isAllowed("MIT")).toBe(true);
    expect(isAllowed("(MIT OR Apache-2.0)")).toBe(true);
    expect(isAllowed("GPL-3.0 OR MIT")).toBe(true);
  });

  it("rejects copyleft licenses and AND-expressions containing them", () => {
    expect(isAllowed("GPL-3.0")).toBe(false);
    expect(isAllowed("LGPL-2.1")).toBe(false);
    expect(isAllowed("MIT AND GPL-3.0")).toBe(false);
  });

  it("allows MPL-2.0 for dev-only dependencies but not for runtime ones", () => {
    expect(isAllowed("MPL-2.0")).toBe(false);
    expect(isAllowed("MPL-2.0", true)).toBe(true);
    expect(isAllowed("GPL-3.0", true)).toBe(false);
  });
});

describe("source policy", () => {
  it("requires the SPDX header", () => {
    expect(checkFile("src/a.ts", "export {};\n")).toHaveLength(1);
    expect(checkFile("src/a.ts", `${HEADER}export {};\n`)).toEqual([]);
  });

  it("rejects Math.random, parseFloat and eval", () => {
    expect(checkFile("src/a.ts", `${HEADER}const x = Math.random();\n`)).toHaveLength(1);
    expect(checkFile("src/a.ts", `${HEADER}const x = parseFloat("1.5");\n`)).toHaveLength(1);
    expect(checkFile("src/a.ts", `${HEADER}eval("1");\n`)).toHaveLength(1);
  });
});
