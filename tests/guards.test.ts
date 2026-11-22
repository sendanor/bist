import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRecord, isRevisionId } from "../src/guards.ts";

describe("isRecord", () => {
  it("accepts objects without checking their prototype", () => {
    for (const value of [{}, { id: 17 }, Object.create(null), new Date(0)]) {
      assert.equal(isRecord(value), true);
    }
  });

  it("rejects null, arrays, primitives, and functions", () => {
    for (const value of [null, [], [1], undefined, "record", 17, false, () => ({})]) {
      assert.equal(isRecord(value), false);
    }
  });

  it("leaves individual field values unknown until checked", () => {
    const input: unknown = { title: "Recipe", year: 2026 };
    assert.ok(isRecord(input));
    assert.equal(input.title, "Recipe");
    assert.equal(typeof input.year, "number");
  });
});

describe("isRevisionId", () => {
  it("requires lowercase version 4 UUIDs with an RFC 9562 variant", () => {
    for (const digit of ["8", "9", "a", "b"]) {
      assert.ok(isRevisionId("abc00000-0000-4000-" + digit + "000-000000000000"));
    }
    for (const value of [
      undefined,
      4,
      "ABC00000-0000-4000-8000-000000000000",
      "abc00000-0000-3000-8000-000000000000",
      "abc00000-0000-4000-c000-000000000000",
      "abc00000-0000-4000-8000-000000000000\n",
    ]) {
      assert.equal(isRevisionId(value), false, String(value));
    }
  });
});
