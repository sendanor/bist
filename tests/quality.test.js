import assert from "node:assert/strict";
import { test } from "node:test";
import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import { qualityRules } from "../src/quality/rules.js";
import { recipeRules, resolveRecipePart } from "../src/quality/recipe-rules.js";
import { findDuplicates } from "../src/quality/duplicates.js";
import { secretKinds } from "../scripts/secret-patterns.mjs";
import { assertPublicBundle } from "../scripts/public-bundle.mjs";

const ruleSet = { ...qualityRules, ...recipeRules };

/**
 * Evaluate one quality rule against a synthetic recipe source fixture.
 * @param rule The bundled rule to enable for this check.
 * @param source The TypeScript or JSX fixture to lint.
 * @param options The optional settings for the chosen rule.
 * @param filename The virtual recipe filename associated with the fixture.
 */
function check(rule, source, options = [], filename = "source.tsx") {
  const linter = new Linter();
  return linter.verify(
    source,
    {
      files: ["**/*.tsx"],
      languageOptions: { parser },
      plugins: { quality: { rules: ruleSet } },
      settings: { cookbookParts: ["source", "tests"] },
      rules: { [`quality/${rule}`]: ["error", ...options] },
    },
    { filename, allowInlineConfig: false },
  );
}

const cases = [
  ["documentation", "function f(x: number) { return x; }", /describe what this callable/i],
  [
    "documentation",
    "/** Return the supplied count.\n * @param count Total entries already processed.\n */\nfunction f(count: number) { return count; }",
  ],
  [
    "documentation",
    "/** Return the supplied count. */\nconst f = (count: number) => count;",
    /describe what parameter/i,
  ],
  ["documentation", "const inputs = [1].map((n) => n + 1);"],
  ["documentation", "/* Explain the intended use. */\nfunction f() {}", /add jsdoc/i],
  [
    "documentation",
    "/** @returns {number} Number of loaded records. */\nfunction f() { return 0; }",
    /add jsdoc/i,
  ],
  ["documentation", "const api = { load(count: number) {} };", /add jsdoc/i],
  [
    "documentation",
    "const api = {\n/** Load the selected records.\n * @param count Maximum number of records to load.\n */\nload(count: number) {} };",
  ],
  [
    "documentation",
    "class Loader {\n/** Store the supplied count.\n * @param quantity Maximum records returned at once.\n */\nconstructor(readonly count: number) {} }",
    /parameter 'count'/i,
  ],
  ["documentation", "abstract class Loader { abstract load(count: number): void }", /add jsdoc/i],
  ["documentation", "interface Factory { new (count: number): object }", /add jsdoc/i],
  ["documentation", "let onSubmit; onSubmit = () => {};", /add jsdoc/i],
  [
    "documentation",
    "// quality-ignore-next-line documentation -- Framework generates its contract\nfunction f() {}",
  ],
  [
    "documentation",
    "// quality-ignore-next-line documentation -- Framework generates its contract\n\nfunction f() {}",
    /add jsdoc/i,
  ],
  [
    "documentation",
    "/** Count provided values.\n * @param values Remaining items to count.\n */\nfunction count(...values: number[]) { return values.length; }",
  ],
  ["document-throws", "function f() { throw new TypeError('reason'); }", /TypeError/],
  ["document-throws", "throw new Error('module initialization failed');"],
  ["document-throws", "function f() { try { throw new Error('handled'); } catch {} }"],
  [
    "document-throws",
    "/** Load the recipe snapshot.\n * @throws {RangeError} When the count is negative.\n */\nasync function f() { throw new RangeError(); }",
  ],
  [
    "document-throws",
    "/** Load the recipe snapshot.\n * @throws {TypeError} When the count is negative.\n */\nasync function f() { throw new RangeError(); }",
    /RangeError/,
  ],
  ["promise-chains", "const x = input.then(fn).catch(onError);", /prefer await/i],
  ["promise-chains", "async function f() { try { return await input; } catch {} }"],
  ["promise-all", "async function f() { await Promise.all(jobs); }", /continue after/i],
  [
    "promise-all",
    "// quality-ignore-next-line promise-all -- Jobs remain independently tracked\nawait Promise.all(jobs);",
  ],
  ["promise-all", "await Promise.allSettled(jobs);"],
  ["directives", "/* eslint-disable */\nexport const x = 1;", /broad/i],
  ["directives", "/* eslint-disable-next-line no-alert */\nalert(1);", /explain/i],
  [
    "directives",
    "// quality-ignore-next-line made-up -- This reason is present\nexport const x = 1;",
    /one supported/i,
  ],
  [
    "directives",
    "// quality-ignore-next-line function-size -- Framework owns this entry point\nexport const x = 1;",
  ],
  ["no-loose-return", "async function f(): Promise<unknown> { return 1; }", /concrete/i],
  ["no-loose-return", "function f(): string | any { return 1; }", /concrete/i],
  ["no-loose-return", "function f(x: unknown): Record<string, unknown> {return {x};}"],
  ["no-loose-return", "interface Contract { (): unknown }", /concrete/i],
  ["explicit-any", "const x: any = true;", /explicit any/i],
  ["explicit-any", "const x: boolean = true;"],
  ["review-unknown", "const x: unknown = JSON.parse(body);", /unvalidated input/i],
  ["review-unknown", "function f(x: unknown) { return x === null; }"],
  [
    "named-parameter-types",
    "function f(opts: { count: number }) { return opts.count; }",
    /named contract/i,
  ],
  [
    "named-parameter-types",
    "/** Controls the requested batch count. */\ntype Options = { count: number }; function f(opts: Options) { return opts.count; }",
  ],
  [
    "named-parameter-types",
    "interface Options { count: number }; function f(opts: Options) { return opts.count; }",
    /document the meaning/i,
  ],
  ["documentation", "declare function load(id: string): number;", /describe what this callable/i],
  [
    "documentation",
    "/** Read a cached value.\n * @param [id] Revision to retrieve from cache.\n */\ndeclare function load(id?: string): number;",
  ],
  ["readonly-input", "function f(list: number[]) { return list.length; }", /readonly array/i],
  ["readonly-input", "function f(list: Array<number>) { list.push(1); }"],
  ["readonly-input", "function f(list: number[]) { list[0]++; }"],
  ["readonly-input", "function f(list: number[]) { list = []; return list.length; }"],
  ["readonly-input", "function f(list: readonly number[]) { return list.length; }"],
  ["readonly-contract", "interface Options { value: number }", /readonly/i],
  ["readonly-contract", "interface Options { readonly value: number }"],
  ["readonly-contract", "class Cache { private size = 0; }", /field is only set/i],
  ["named-guards", "if (typeof input === 'number') {}", /named guard/i],
  ["named-guards", "if (Array.isArray(input)) {}", /named array guard/i],
  ["named-guards", "if (isArray(input)) {}"],
  ["named-guards", "const isId = /^[0-9a-f]{12}$/.test(input);", /named UUID guard/i],
  ["localize-jsx", "const title = <h1>Recipe title</h1>;", /translation catalog/i],
  ["localize-jsx", "const search = <input placeholder='Find recipes' />;", /translation catalog/i],
  ["localize-jsx", "const title = <h1>{t('title')}</h1>;"],
  ["localize-jsx", "const title = <h1>{`Welcome ${name}`}</h1>;", /translation catalog/i],
  [
    "localize-jsx",
    'const title = <h1>{loading ? "Loading" : t("title")}</h1>;',
    /translation catalog/i,
  ],
  [
    "browser-boundaries",
    "export function Panel() { window.fetch('/api'); return <p/>; }",
    /injected service/i,
  ],
  [
    "browser-boundaries",
    "export function Panel() { const state = localStorage.getItem('a'); return <p>{state}</p>; }",
    /injected service/i,
  ],
  ["browser-boundaries", "export function Panel() { return <p>{service.getText()}</p>; }"],
  ["browser-boundaries", "const view = <>{localStorage}</>;", /injected service/i],
  ["browser-boundaries", "const view = <>{new WebSocket(url)}</>;", /injected service/i],
  ["browser-boundaries", "export function request() { return fetch('/api'); }"],
  ["recipe-imports", "import type { X } from './interface.js';", /missing/i],
  ["recipe-imports", "import { X } from './tests.js';", /cannot depend/i],
  ["recipe-imports", "const x = await import(path);", /literal/i],
  ["recipe-imports", "const x = require('../server');", /outside/i],
  ["recipe-imports", "import { useState } from 'react';", /allowlist/i],
  ["recipe-imports", "import { useState } from 'react';", undefined, [{ external: ["react"] }]],
  ["recipe-imports", "export { example } from './source.js';", undefined, [], "tests.tsx"],
  ["recipe-imports", "import { own } from './source';", /cannot import itself/i],
  ["recipe-imports", "type Value = import('./interface').Value;", /missing/i],
  ["recipe-imports", "import contract = require('./interface.js');", /missing/i],
  ["recipe-imports", "export * from 'react';", /allowlist/i],
  ["recipe-imports", "const optional = require();", /literal module path/i],
];

for (const [rule, input, expected, options, filename] of cases) {
  test(`${rule} ${expected ? "reports" : "allows"} ${input.slice(0, 65)}`, () => {
    const diagnostics = check(rule, input, options, filename).filter(
      (entry) => entry.ruleId || entry.fatal,
    );
    if (expected) {
      assert.equal(diagnostics[0]?.ruleId, `quality/${rule}`);
      assert.match(diagnostics[0].message, expected);
      assert.ok(diagnostics[0].line > 0 && diagnostics[0].column > 0);
    } else {
      assert.deepEqual(diagnostics, []);
    }
  });
}

test("size counts only code lines and allows a scoped exception", () => {
  const boilerplate = "// explanatory prose\n\n".repeat(550);
  const big = "doWork();\n".repeat(101);
  assert.deepEqual(check("function-size", `function f() {\n${boilerplate}}`), []);
  assert.match(check("function-size", `function f() {\n${big}}`)[0].message, /103 code lines/);
  assert.match(check("file-size", big.repeat(5))[0].message, /505 code lines/);
});

test("custom recipe filenames resolve ESM and CommonJS aliases without choosing an ambiguous stem", () => {
  const names = { source: "entry.mts", tests: "entry.cts", interface: "contract.d.ts" };
  assert.equal(resolveRecipePart("./entry.mts", names), "source");
  assert.equal(resolveRecipePart("./entry.mjs", names), "source");
  assert.equal(resolveRecipePart("./entry.cjs", names), "tests");
  assert.equal(resolveRecipePart("./contract.js", names), "interface");
  assert.equal(resolveRecipePart("./entry", names), undefined);
  assert.equal(resolveRecipePart("./source.js", names), undefined);
  assert.equal(resolveRecipePart("./source.js"), "source");
});

test("duplication requires 80 tokens on at least 12 lines and does not match overlapping runs", () => {
  const duplicate = "result = add(result, offset);\n".repeat(12);
  assert.deepEqual(check("duplicate-code", duplicate), []);
  assert.equal(check("duplicate-code", duplicate.repeat(2)).length, 1);
  assert.deepEqual(check("duplicate-code", "result = add(result, offset); ".repeat(30)), []);
  const tokens = Array.from({ length: 84 }, (_, index) => ({
    value: String(index),
    line: Math.floor(index / 7) + 1,
    column: 1,
    endLine: Math.floor(index / 7) + 1,
  }));
  assert.equal(
    findDuplicates([
      { name: "a.js", tokens },
      { name: "b.ts", tokens },
    ])[0].other,
    "a.js",
  );
});

test("duplicate matching stops at its result limit and rejects short prefix matches", () => {
  const tokens = Array.from({ length: 96 }, (_, index) => ({
    value: String(index),
    line: Math.floor(index / 8) + 1,
    column: (index % 8) + 1,
  }));
  const uniqueTail = tokens.map((token, index) =>
    index < 80 ? token : { ...token, value: "other-" + token.value },
  );
  const files = [
    { name: "first.js", tokens },
    { name: "similar.ts", tokens: uniqueTail },
  ];
  assert.deepEqual(findDuplicates(files), []);
  files.push({ name: "second.ts", tokens }, { name: "third.ts", tokens });
  const [first] = findDuplicates(files);
  assert.equal(first.length, 96);
  assert.deepEqual(findDuplicates(files, 1), [first]);
});

test("public bundle check permits UI settings and rejects private bindings and source maps", () => {
  assert.doesNotThrow(() => assertPublicBundle('const settings = "Code Policy";'));
  assert.throws(
    () => assertPublicBundle("const binding = 'MAINTAINER_EMAILS';"),
    /private setting/,
  );
  assert.throws(() => assertPublicBundle("//# sourceMappingURL=bundle.js.map"), /source map/);
});

test("secret scanner flags a known token shape but permits public setting names", () => {
  assert.deepEqual(secretKinds("MAINTAINER_EMAILS=maintainer@example.test"), []);
  const synthetic = "ghp_" + "a".repeat(36);
  assert.deepEqual(secretKinds(synthetic), ["GitHub token"]);
  assert.throws(() => assertPublicBundle(synthetic), /Value omitted/);
});
