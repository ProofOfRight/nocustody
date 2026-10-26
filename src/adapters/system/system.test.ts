// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { MEMO_ALPHABET, MEMO_LENGTH, normalizeMemo } from "../../domain/memo.ts";
import { cryptoMemos } from "./system.ts";

describe("cryptoMemos", () => {
  it("produces valid memos from the alphabet without look-alike characters", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      const m = cryptoMemos.newMemo();
      expect(m).toHaveLength(MEMO_LENGTH);
      expect([...m].every((c) => MEMO_ALPHABET.includes(c))).toBe(true);
      expect(normalizeMemo(m)).toBe(m);
      seen.add(m);
    }
    expect(seen.size).toBe(2_000);
    expect(MEMO_ALPHABET).not.toMatch(/[01ILO]/);
  });

  it("normalizes payer input but rejects free text", () => {
    expect(normalizeMemo(" ab2c3d4e\n")).toBe("AB2C3D4E");
    expect(normalizeMemo("pay AB2C3D4E")).toBeNull();
    expect(normalizeMemo("")).toBeNull();
    expect(normalizeMemo(null)).toBeNull();
  });
});
