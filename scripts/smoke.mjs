import { repositoryRecipe } from "./repository-recipes.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Miniflare } from "miniflare";
import { getEncoding } from "js-tiktoken";
import { performance } from "node:perf_hooks";

const folder = await mkdtemp(join(tmpdir(), "cookbook-"));
const worker = () =>
  new Miniflare({
    scriptPath: resolve("dist/server/index.js"),
    modules: true,
    compatibilityDate: "2026-07-30",
    d1Databases: { DB: "cookbook" },
    d1Persist: folder,
    bindings: { MAINTAINER_EMAILS: "maintainer@example.test" },
  });
let runtime = worker();
function dispatch(path, user, data) {
  const origin = "https://cookbook.local";
  const headers = { origin: origin };
  if (user) {
    headers["oai-authenticated-user-id"] = user;
    headers["oai-authenticated-user-email"] = user + "@example.test";
  }
  if (data) {
    headers["content-type"] = "application/json";
  }
  return runtime.dispatchFetch(origin + path, {
    method: data ? "POST" : "GET",
    headers,
    body: data && JSON.stringify(data),
  });
}
async function tool(name, args, user = "author") {
  const response = await dispatch("/mcp", user, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const { result } = await response.json();
  assert.equal(result?.isError, undefined, result?.content[0]?.text);
  return JSON.parse(result.content[0].text);
}
const tokenizer = getEncoding("o200k_base");
const measure = (result) => {
  const text = JSON.stringify(result);
  return { bytes: Buffer.byteLength(text), tokens: tokenizer.encode(text).length };
};
try {
  const db = await runtime.getD1Database("DB");
  for (const name of ["0000_cookbook", "0001_code_policy"]) {
    const migration = await readFile("drizzle/" + name + ".sql", "utf8");
    await db.batch(
      migration.split("--> statement-breakpoint").map((sql) => db.prepare(sql.trim())),
    );
  }
  assert.equal((await dispatch("/api/search", null)).status, 401);
  const payload = {
    slug: "batch-items",
    title: "Batch items into chunks",
    summary: "Split items into fixed-size batches.",
    tags: ["arrays", "utilities"],
    files: {
      source:
        'export function chunk(items,size){if(!Number.isSafeInteger(size)||size<1){throw new RangeError("Invalid size");}const out=[];for(let i=0;i<items.length;i+=size){out.push(items.slice(i,i+size));}return out;}',
      interface: "export declare function chunk<T>(items:readonly T[],size:number):T[][];",
      tests:
        'import assert from "node:assert/strict";\nimport {chunk} from "./source.js";\nassert.deepEqual(chunk([1,2,3],2),[[1,2],[3]]);',
      documentation:
        "Use this recipe to split a list into bounded batches. The final batch may be smaller than the requested size.",
      instructions: "Save source as source.js or source.ts and adapt the test import path.",
    },
  };
  const settings = await (await dispatch("/api/settings", "maintainer")).json();
  assert.equal((await dispatch("/api/settings", "author")).status, 403);
  assert.equal((await dispatch("/api/settings", "author", settings.policy)).status, 403);
  assert.equal(settings.policy.prettier.printWidth, 100);
  assert.equal(settings.policy.prettier.singleAttributePerLine, true);
  assert.equal(settings.policy.quality.warningsAsErrors, false);

  const legacyPolicy = {
    prettier: { singleQuote: true, printWidth: 90 },
    eslint: { "no-debugger": false },
  };
  await db
    .prepare("INSERT INTO code_policy (id, config) VALUES (1, ?)")
    .bind(JSON.stringify(legacyPolicy))
    .run();
  const upgraded = (await (await dispatch("/api/settings", "maintainer")).json()).policy;
  assert.equal(upgraded.prettier.printWidth, 90);
  assert.equal(upgraded.prettier.singleQuote, true);
  assert.equal(upgraded.eslint["no-debugger"], 0);
  assert.equal(upgraded.eslint.curly, "error");
  assert.equal((await dispatch("/api/settings", "maintainer", settings.policy)).status, 200);
  const shell = await (await dispatch("/", null)).text();
  assert.match(shell, /TypeScript recipes/);
  assert.doesNotMatch(shell, /\{\{t:/);

  const submit = (slug, files) => dispatch("/api/submit", "author", { ...payload, slug, files });
  const violationsByPart = [
    ["undeclared", { source: "missing();" }, /source:1:1.*undeclared-value/i],
    ["constant", { source: "const id = 1; id = 2;" }, /no-const-assign/],
    ["duplicate-keys", { source: "export const x = { a: 1, a: 2 };" }, /no-dupe-keys/],
    ["braces", { source: "if (true) console.log(1);" }, /curly/],
    ["browser-alert", { source: 'window.alert("notice");' }, /no-alert/],
    [
      "invalid-directive",
      { source: "/* eslint-disable */\nexport const x = 1;" },
      /quality\/directives/,
    ],
    [
      "module-boundary",
      { source: 'export type { T } from "./tests.js";', tests: "export type T = string;" },
      /quality\/recipe-imports/,
    ],
    [
      "bad-style-name",
      { source: "export const x = 1;", styles: ".My_Class { color: red; }" },
      /styles:1:1.*cssClasses/,
    ],
    [
      "bad-style-property",
      { source: "export const x = 1;", styles: ".my-class { colro: red; }" },
      /styles:1:13.*cssValidation/,
    ],
    [
      "duplicated-code",
      { source: "let value = 0;\n" + "value = Math.abs(value + 1);\n".repeat(24) },
      /duplicate-code/,
    ],
    [
      "hook-order",
      {
        source:
          "declare function useState(input: number): number; export function Panel(){ if (true){ useState(0); } return <p/>; }",
      },
      /rules-of-hooks/,
    ],
  ];
  for (const [slug, parts, expected] of violationsByPart) {
    const response = await submit(slug, parts);
    assert.equal(response.status, 400, slug);
    assert.match((await response.json()).error, expected, slug);
  }
  const hookDeps = await (
    await submit("hook-dependencies", {
      source: `declare function useEffect(callback: () => void, deps: readonly string[]): void;
export function Panel(label: string) {
  useEffect(() => { console.log(label); }, []);
  return <p aria-label={label} id="recipe" />;
}`,
    })
  ).json();
  assert.match(hookDeps.warnings.join("\n"), /react-hooks\/exhaustive-deps/);
  const badTypes = { source: 'export const value: number = "wrong";' };
  const warnedTypes = await (await submit("type-warning", badTypes)).json();
  assert.match(warnedTypes.warnings.join("\n"), /source:1:14.*TS2322/);
  const strictPolicy = {
    ...settings.policy,
    quality: { ...settings.policy.quality, typeCheck: "error", warningsAsErrors: true },
  };
  assert.equal((await dispatch("/api/settings", "maintainer", strictPolicy)).status, 200);
  const typeMismatch = await submit("type-error", badTypes);
  assert.equal(typeMismatch.status, 400);
  assert.match((await typeMismatch.json()).error, /TS2322/);
  const crossPartMismatch = await submit("cross-part-type-error", {
    source: "export const value = 1;",
    tests: 'import { value } from "./source.js"; export const output: string = value;',
  });
  assert.equal(crossPartMismatch.status, 400);
  assert.match((await crossPartMismatch.json()).error, /tests:1:51.*TS2322/);
  const mustBeDocumented = await submit("blocked-warning", {
    source: "export function add() { return 1; }",
  });
  assert.equal(mustBeDocumented.status, 400);
  assert.match((await mustBeDocumented.json()).error, /quality\/documentation/);
  const cleanParts = await tool("submit_recipe", {
    ...payload,
    slug: "valid-style-and-type",
    files: { source: "export const x:number=1;", styles: ".recipe-2{color: red;}" },
  });
  const savedParts = await tool("get_recipe", {
    slug: cleanParts.slug,
    revision: cleanParts.id,
    parts: ["styles", "source"],
  });
  assert.equal(savedParts.files.styles, ".recipe-2 {\n  color: red;\n}\n");
  assert.equal(savedParts.files.source, "export const x: number = 1;\n");
  assert.equal((await dispatch("/api/settings", "maintainer", settings.policy)).status, 200);

  for (const slug of ["bounded-line-diff", "bounded-json-object-reader"]) {
    const files = await repositoryRecipe(slug);
    const submission = { ...payload, slug, title: slug, files };
    const revision =
      slug === "bounded-line-diff"
        ? await tool("submit_recipe", submission)
        : await (await dispatch("/api/submit", "author", submission)).json();
    assert.equal(revision.state, "pending", JSON.stringify(revision));
    const stored = await tool("get_recipe", {
      slug,
      revision: revision.id,
      parts: ["source", "tests"],
    });
    const directory = await mkdtemp(join(tmpdir(), "bist-repository-recipe-"));
    try {
      await writeFile(join(directory, "package.json"), '{"type":"module"}');
      await writeFile(join(directory, "source.ts"), stored.files.source);
      await writeFile(join(directory, "recipe.test.ts"), stored.files.tests);
      execFileSync(process.execPath, [join(directory, "recipe.test.ts")], { cwd: directory });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const allRules = Object.fromEntries(
    [
      "no-debugger",
      "no-console",
      "no-alert",
      "no-self-compare",
      "no-sparse-arrays",
      "no-empty-pattern",
    ].map((rule) => [rule, true]),
  );
  const policy = {
    prettier: { ...settings.policy.prettier, singleQuote: false, semi: false },
    eslint: { ...allRules, eqeqeq: ["error", "always"], "no-undef": "warn" },
  };
  assert.equal(
    (
      await dispatch("/api/settings", "maintainer", {
        ...policy,
        prettier: { ...policy.prettier, tabWidth: 99 },
      })
    ).status,
    400,
  );
  assert.equal((await dispatch("/api/settings", "maintainer", policy)).status, 200);
  const violations = {
    eqeqeq: "const x: number = 1; x == 2;",
    "no-debugger": "debugger;",
    "no-console": "console.log(1);",
    "no-alert": 'alert("stop");',
    "no-self-compare": "const x: number = 1; x === x;",
    "no-sparse-arrays": "const x: number[] = [, 1];",
    "no-empty-pattern": "const {} = { x: 1 };",
  };
  for (const [rule, source] of Object.entries(violations)) {
    const r = await dispatch("/api/submit", "author", { ...payload, files: { source } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, new RegExp(rule));
  }
  const blocked = await dispatch("/mcp", "author", {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "submit_recipe",
      arguments: {
        ...payload,
        files: {
          source: '/* eslint-disable no-console */\nconsole.log("blocked");',
        },
      },
    },
  });
  const rejected = (await blocked.json()).result;
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /source:2:1.*no-console/);
  assert.equal(
    (
      await dispatch("/api/settings", "maintainer", {
        ...policy,
        eslint: { eqeqeq: ["error", "bad"] },
      })
    ).status,
    400,
  );
  const warned = await tool("submit_recipe", {
    ...payload,
    slug: "policy-warning",
    files: { source: "unknownSymbol();" },
  });
  assert.match(warned.warnings[0], /no-undef/);
  const clean = await tool("submit_recipe", {
    ...payload,
    slug: "policy-example",
    files: { source: "export const example: string = 'formatted';" },
  });
  const stored = await tool("get_recipe", {
    slug: clean.slug,
    revision: clean.id,
    parts: ["source"],
  });
  assert.equal(stored.files.source, 'export const example: string = "formatted"\n');
  assert.equal((await dispatch("/api/settings", "maintainer", settings.policy)).status, 200);
  const submitted = await tool("submit_recipe", payload);
  const revision = { slug: submitted.slug, revision: submitted.id };
  const action = (kind, user = "maintainer", reason) =>
    dispatch("/api/action", user, { ...revision, action: kind, reason });
  assert.deepEqual(await tool("search_recipes", {}, "reader"), []);
  assert.equal((await tool("get_recipe", { ...revision, parts: ["source"] })).state, "pending");
  assert.equal(
    (await dispatch("/api/recipe?" + new URLSearchParams(revision), "reader")).status,
    404,
  );
  assert.equal((await action("publish")).status, 409);
  assert.equal((await action("approve", "author")).status, 403);
  assert.equal((await action("approve")).status, 200);
  assert.deepEqual(await tool("search_recipes", {}, "reader"), []);
  assert.equal((await action("publish")).status, 200);
  const persistedPolicy = {
    ...settings.policy,
    quality: { ...settings.policy.quality, cssClasses: "warn" },
    overrides: {
      ...settings.policy.overrides,
      tests: { ...settings.policy.overrides.tests, "no-debugger": "off" },
    },
  };
  assert.equal((await dispatch("/api/settings", "maintainer", persistedPolicy)).status, 200);
  await runtime.dispose();
  runtime = worker();
  const restored = (await (await dispatch("/api/settings", "maintainer")).json()).policy;
  assert.equal(restored.quality.cssClasses, "warn");
  assert.equal(restored.overrides.tests["no-debugger"], "off");
  const override = await submit("part-override", {
    source: "export const value = 1;",
    tests: "debugger;",
    styles: ".Bist { color: red; }",
  });
  assert.equal(override.status, 201);
  assert.match((await override.json()).warnings.join("\n"), /cssClasses/);
  assert.equal((await submit("source-rule", { source: "debugger;" })).status, 400);
  assert.equal(
    (await tool("search_recipes", { query: "fixed-size batches", tag: "arrays" }, "reader"))[0].id,
    submitted.id,
  );
  const start = performance.now();
  const retrieved = await tool(
    "get_recipe",
    { slug: payload.slug, parts: ["source", "tests"] },
    "reader",
  );
  assert.deepEqual(Object.keys(retrieved.files), ["source", "tests"]);
  assert.match(retrieved.files.source, /export function chunk\(items, size\)/);
  const project = await mkdtemp(join(tmpdir(), "cookbook-consumer-"));
  try {
    await writeFile(join(project, "package.json"), '{"type":"module"}');
    await writeFile(join(project, "source.js"), retrieved.files.source);
    await writeFile(join(project, "chunk.test.js"), retrieved.files.tests);
    execFileSync(process.execPath, [join(project, "chunk.test.js")], { cwd: project });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
  const reuseMs = performance.now() - start;
  const full = await tool("get_recipe", { slug: payload.slug }, "reader");
  const next = await tool(
    "submit_recipe",
    { ...payload, base: submitted.id, summary: "A proposed revision." },
    "reader",
  );
  assert.equal((await tool("search_recipes", {}, "reader"))[0].id, submitted.id);
  assert.equal(
    (
      await dispatch("/api/action", "reader", {
        slug: next.slug,
        revision: next.id,
        action: "remove_draft",
      })
    ).status,
    200,
  );
  assert.equal(
    (await action("quarantine", "maintainer", "Exercise immediate removal from search")).status,
    200,
  );
  assert.deepEqual(await tool("search_recipes", {}, "reader"), []);
  assert.equal(
    (await dispatch("/api/recipe?" + new URLSearchParams(revision), "author")).status,
    404,
  );
  assert.equal(
    (await action("request_removal", "author", "Superseded by another approach")).status,
    200,
  );
  assert.equal((await action("approve_removal")).status, 200);
  console.log(
    JSON.stringify({
      passed:
        "Worker MCP → review → publication → restart → selective retrieval → second-project test, with permission and removal checks",
      reuseMs: Math.round(reuseMs),
      selective: measure(retrieved),
      full: measure(full),
    }),
  );
} finally {
  await runtime.dispose();
  await rm(folder, { recursive: true, force: true });
}
