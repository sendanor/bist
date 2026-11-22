import assert from "node:assert/strict";
import { test } from "node:test";
import { format } from "prettier";
import * as spacing from "../scripts/prettier-declaration-spacing.mjs";
import { spaceDeclarations } from "../src/quality/declaration-spacing.js";

test("formatter separates declarations before their comments when enabled", async () => {
  const compact = `interface First {}
/** Explain the second interface. */
interface Second {}
class Handler {
  start() {} // Keep this on start.
  /** Explain the stop method. */
  stop() {}
}`;
  const options = { parser: "typescript", filepath: "example.ts", plugins: [spacing] };
  const formatted = await format(compact, { ...options, blankLinesBetweenDeclarations: true });
  assert.match(
    formatted,
    /interface First \{\}\n\n\/\*\* Explain the second interface\. \*\/\ninterface Second/u,
  );
  assert.match(
    formatted,
    /start\(\) \{\} \/\/ Keep this on start\.\n\n {2}\/\*\* Explain the stop method\. \*\/\n {2}stop/u,
  );
  assert.equal(
    await format(formatted, { ...options, blankLinesBetweenDeclarations: true }),
    formatted,
  );
  assert.equal(
    await format(compact, { ...options, blankLinesBetweenDeclarations: false }),
    compact + "\n",
  );
});

test("spacing preserves JSX text, overload groups, directives and the selected line ending", () => {
  const source = [
    "function load(value: string): string;",
    "function load(value: string) { return value; }",
    "// quality-ignore-next-line documentation -- Framework generates the contract",
    "const View = () => <p>function sample() {{left:1,right:2}.left}</p>;",
    "/** Render the panel. */",
    "function Panel() { return <View />; }",
  ].join("\r\n");
  const spaced = spaceDeclarations(source, "example.tsx");
  assert.equal(spaced, source.replace("\r\n//", "\r\n\r\n//").replace("\r\n/**", "\r\n\r\n/**"));
  assert.equal(spaceDeclarations(spaced, "example.tsx"), spaced);
});

test("spacing falls back to TypeScript for casts and leaves malformed code intact", () => {
  assert.equal(
    spaceDeclarations('function a() { return <string>"hello"; } function b() {}'),
    'function a() { return <string>"hello"; }\n\n function b() {}',
  );
  const incomplete = "function broken( {";
  assert.equal(spaceDeclarations(incomplete), incomplete);
  assert.equal(spaceDeclarations(incomplete, "example.ts"), incomplete);
  assert.equal(
    spaceDeclarations("function a() {} /* same-line note */ /** About b. */ function b() {}"),
    "function a() {} /* same-line note */\n\n /** About b. */ function b() {}",
  );
});
