// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { pageOffset, parseTimeCursor, recordProgress, windowStart } from "./cursor.ts";

describe("scan cursor", () => {
  it("parses stored cursors and drops anything that is not a safe integer", () => {
    expect(parseTimeCursor(null, "TRON")).toEqual({});
    expect(parseTimeCursor('{"a":1,"b":"x","c":1.5,"d":null}', "TRON")).toEqual({ a: 1 });
    expect(() => parseTimeCursor("[1]", "TON")).not.toThrow(); // an array is an object; entries are dropped
    expect(() => parseTimeCursor("42", "TON")).toThrow("invalid TON cursor");
  });

  it("re-reads the overlap, never before the floor, and starts tight after a scan without progress", () => {
    expect(windowStart({}, "a", 1_000, 600, 0)).toBe(400);
    expect(windowStart({}, "a", 1_000, 600, 900)).toBe(900);
    expect(windowStart({ "a#tight": 1 }, "a", 1_000, 600, 0)).toBe(1_000);
  });

  it("a burst larger than the page budget cannot freeze the cursor: tight, then deeper pages, then back to normal", () => {
    const state = { a: 1_000 };
    // budget used, cursor did not move → next scan is tight
    let next = { ...state };
    expect(recordProgress(next, state, "a", 1_000, true, 20)).toBe(true);
    expect(next).toEqual({ a: 1_000, "a#tight": 1 });
    // still no progress from a tight scan → resume 20 rows further
    const tight = next;
    next = { ...tight };
    expect(recordProgress(next, tight, "a", 1_000, true, 20)).toBe(true);
    expect(next).toEqual({ a: 1_000, "a#tight": 1, "a#offset": 20 });
    expect(pageOffset(next, "a")).toBe(20);
    // progress at last: the markers go away
    const deep = next;
    next = { ...deep, a: 1_050 };
    expect(recordProgress(next, deep, "a", 1_000, true, 20)).toBe(false);
    expect(next).toEqual({ a: 1_050 });
    // a short page (budget not used) is never stuck, even without progress (nothing new on the account)
    next = { ...state };
    expect(recordProgress(next, state, "a", 1_000, false, 3)).toBe(false);
    expect(next).toEqual({ a: 1_000 });
  });
});
