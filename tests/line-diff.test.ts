import assert from "node:assert/strict";
import { diffLines } from "../src/line-diff.ts";

assert.deepEqual(diffLines("a\nold\nkeep\nend", "a\nnew\nkeep\nplus\nend"), [
  { before: "a", after: "a" },
  { before: "old", after: null },
  { before: null, after: "new" },
  { before: "keep", after: "keep" },
  { before: null, after: "plus" },
  { before: "end", after: "end" },
]);
const fallback = diffLines("a\nold\nz", "a\nnew\nz", 1);
assert.deepEqual(fallback, [
  { before: "a", after: "a" },
  { before: "old", after: null },
  { before: null, after: "new" },
  { before: "z", after: "z" },
]);
assert.deepEqual(diffLines("", ""), [{ before: "", after: "" }]);
