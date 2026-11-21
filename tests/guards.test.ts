import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRecord } from "../src/guards.ts";

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
