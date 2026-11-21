import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprintRecipe } from "../src/quality/recipe-hash.ts";

test("fingerprint ignores insignificant TypeScript and CSS formatting", async () => {
  const original = await fingerprintRecipe({
    source: "export const data = { count: 1 };",
    styles: ".entry { color: red; }",
    documentation: "An example.",
  });
  const formatted = await fingerprintRecipe({
    styles: ".entry{ color:red }",
    source: "\nexport const data={\n\tcount: 1,\n}\n",
    documentation: "Documentation can change independently.",
  });
  assert.deepEqual(original, formatted);
  assert.deepEqual(Object.keys(original.units), ["source", "styles"]);
});

test("fingerprint keeps meaningful spaces, statement boundaries and changed tests", async () => {
  const pairs = [
    ['export function strict(){ "use strict"; }', 'export function strict(){ "use\\x20strict"; }'],
    ['export const text = "a  b";', 'export const text = "a b";'],
    ["export const node = <span>a b</span>;", "export const node = <span>ab</span>;"],
    ["export function f(){return\n 1;}", "export function f(){return 1;}"],
    ["export const ar = [1,,];", "export const ar = [1,];"],
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(
      (await fingerprintRecipe({ source: a })).snapshot,
      (await fingerprintRecipe({ source: b })).snapshot,
    );
  }
  const source = "export const value = 1;";
  const original = await fingerprintRecipe({ source, tests: "assert.equal(value, 1);" });
  const changed = await fingerprintRecipe({ source, tests: "assert.equal(value, 2);" });
  assert.equal(original.units.source, changed.units.source);
  assert.notEqual(original.snapshot, changed.snapshot);
});
