// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { missingSignoff } from "./check-dco.ts";
import { isAllowed } from "./check-licenses.ts";
import { checkFile, checkInvisible } from "./check-source.ts";

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

  it("rejects invisible and bidi characters and reports their position", () => {
    expect(checkInvisible("a.md", "plain text, emoji \u26A0\uFE0F\n")).toEqual([]);
    expect(checkInvisible("a.ts", "ok\n// a\u200Bb\n")).toEqual([
      "a.ts:2:5: invisible or bidi character U+200B",
    ]);
    expect(checkInvisible("a.ts", "/* \u202E admin \u2066 */")).toHaveLength(2);
    expect(checkInvisible("a.md", "x\u{E0041}\u{E0049}")).toHaveLength(2);
    expect(checkInvisible("a.md", "\uFEFFtitle")).toHaveLength(1);
    expect(checkInvisible("a.md", "x\u{E0100}")).toHaveLength(1);
    // characters that hide code: blank identifier characters, and line separators that end a // comment
    expect(checkInvisible("a.ts", "const \u3164 = 1; exec(\u3164)")).toHaveLength(2);
    expect(checkInvisible("a.ts", "const \u115F\u1160\uFFA0 = 1")).toHaveLength(3);
    expect(checkInvisible("a.ts", "// note\u2028doEvil()")).toEqual([
      "a.ts:1:8: invisible or bidi character U+2028",
    ]);
    expect(checkInvisible("a.ts", "a\u2029b\u034Fc\u180Bd\uFFF9e\u{1D173}f")).toHaveLength(5);
  });
});

describe("DCO", () => {
  it("requires a sign-off matching the commit author", () => {
    const author = "Jane Doe <jane@example.org>";
    expect(missingSignoff([{ sha: "a", author, signoffs: [author] }])).toEqual([]);
    expect(missingSignoff([{ sha: "b", author, signoffs: [] }])).toHaveLength(1);
    expect(missingSignoff([{ sha: "c", author, signoffs: ["Other <o@example.org>"] }])).toHaveLength(1);
    const bot = "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>";
    expect(missingSignoff([{ sha: "d", author: bot, signoffs: [] }])).toEqual([]);
    expect(missingSignoff([{ sha: "e", author: "dependabot <d@example.org>", signoffs: [] }])).toHaveLength(
      1,
    );
  });
});
