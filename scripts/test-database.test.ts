// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { requireTestDatabase } from "./test-database.ts";

describe("e2e database guard", () => {
  it("accepts only a database whose name ends in _test, because the scripts reset its schema", () => {
    const ok = "postgres://u:p@postgres:5432/nocustody_test";
    expect(requireTestDatabase(ok)).toBe(ok);
    expect(() => requireTestDatabase("postgres://u:p@postgres:5432/nocustody")).toThrow(/_test/);
    expect(() => requireTestDatabase("postgres://u:p@postgres:5432/production_test_db")).toThrow(/_test/);
    expect(() => requireTestDatabase(undefined)).toThrow(/required/);
    expect(() => requireTestDatabase("not a url")).toThrow(/URL/);
  });
});
