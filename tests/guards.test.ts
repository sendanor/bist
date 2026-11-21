import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecord } from "../src/guards.ts";

test("isRecord accepts objects without checking their prototype", () => {
  for (const value of [{}, { id: 17 }, Object.create(null), new Date(0)]) {
    assert.equal(isRecord(value), true);
  }
});

test("isRecord rejects null, arrays, primitives, and functions", () => {
  for (const value of [null, [], [1], undefined, "record", 17, false, () => ({})]) {
    assert.equal(isRecord(value), false);
  }
});

test("isRecord leaves individual field values unknown until checked", () => {
  const input: unknown = { title: "Recipe", year: 2026 };
  assert.ok(isRecord(input));
  assert.equal(input.title, "Recipe");
  assert.equal(typeof input.year, "number");
});
