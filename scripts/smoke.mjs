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
    compatibilityFlags: ["nodejs_compat"],
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
/**
 * Execute repository-owned recipe fixtures from the files retrieved through the Worker.
 * @param files Known trusted source and test files.
 */
async function verifyRecipeTests(files) {
  const directory = await mkdtemp(join(tmpdir(), "bist-repository-recipe-"));
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(join(directory, "source.ts"), files.source);
    await writeFile(join(directory, "recipe.test.ts"), files.tests);
    execFileSync(process.execPath, ["--test", join(directory, "recipe.test.ts")], {
      cwd: directory,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const tokenizer = getEncoding("o200k_base");
const measure = (result) => {
  const text = JSON.stringify(result);
  return { bytes: Buffer.byteLength(text), tokens: tokenizer.encode(text).length };
};
try {
  const db = await runtime.getD1Database("DB");
  for (const name of [
    "0000_cookbook",
    "0001_code_policy",
    "0002_revision_edit_version",
    "0003_recipe_fingerprints",
    "0004_prose_recipes",
    "0005_prose_fingerprints",
    "0006_revision_line_comments",
  ]) {
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
  assert.match(shell, /recipes and guides/);
  assert.doesNotMatch(shell, /\{\{t:/);

  const submit = (slug, files) => dispatch("/api/submit", "author", { ...payload, slug, files });
  const guide = await tool("submit_recipe", {
    ...payload,
    slug: "architecture-guide",
    files: { documentation: "# Architecture\nUse a service boundary." },
  });
  const guideFiles = await tool("get_recipe", { slug: guide.slug, revision: guide.id });
  assert.deepEqual(guideFiles.files, {
    documentation: "# Architecture\nUse a service boundary.\n",
  });
  const guideDecision = (action) =>
    dispatch("/api/action", "maintainer", {
      slug: guide.slug,
      revision: guide.id,
      action,
      editVersion: 0,
    });
  assert.equal((await guideDecision("approve")).status, 200);
  assert.equal((await guideDecision("publish")).status, 200);
  assert.equal(
    (await tool("get_recipe", { slug: guide.slug }, "reader")).files.documentation,
    guideFiles.files.documentation,
  );
  const instruction = await submit("agent-guide", {
    instructions: "# Agent instructions\nReview if applicable.",
  });
  assert.equal(instruction.status, 201);
  assert.equal((await submit("empty-guide", { documentation: "   ", source: "\n" })).status, 400);
  const proseHash = await db
    .prepare("SELECT code_hash, unit_hashes FROM revisions WHERE id = ?")
    .bind(guide.id)
    .first();
  assert.equal(proseHash.code_hash, null);
  assert.equal(proseHash.unit_hashes, "{}");
  assert.equal(
    (
      await dispatch("/api/action", "maintainer", {
        slug: guide.slug,
        revision: guide.id,
        action: "quarantine",
        reason: "Hide the QA guide from later assertions.",
      })
    ).status,
    200,
  );

  const units = {
    source: "export const duplicatePolicyExample = 912;",
    instructions: "A unique instruction for duplicate policy QA.",
  };
  const submitPolicyExample = (slug, options = {}) =>
    dispatch("/api/submit", "author", { ...payload, slug, files: units, ...options });
  assert.equal((await submitPolicyExample("policy-duplicate-original")).status, 201);
  const setDuplicates = (duplicateCode, duplicateProse) =>
    dispatch("/api/settings", "maintainer", {
      ...settings.policy,
      quality: { ...settings.policy.quality, duplicateCode, duplicateProse },
    });
  assert.equal((await setDuplicates("warn", "warn")).status, 200);
  const warnedDuplicate = await submitPolicyExample("policy-duplicate-warning");
  assert.equal(warnedDuplicate.status, 409);
  const warning = await warnedDuplicate.json();
  assert.equal(warning.code, "duplicate_warning");
  assert.match(warning.error, /same code/);
  assert.match(warning.error, /same agent instructions/);
  assert.equal(
    await db.prepare("SELECT slug FROM recipes WHERE slug = 'policy-duplicate-warning'").first(),
    null,
  );
  assert.equal(
    (await submitPolicyExample("policy-duplicate-warning", { allowDuplicates: true })).status,
    201,
  );
  assert.equal((await setDuplicates("off", "error")).status, 200);
  const blockedProse = await submitPolicyExample("policy-duplicate-prose-error", {
    allowDuplicates: true,
  });
  assert.equal(blockedProse.status, 409);
  const blocking = await blockedProse.json();
  assert.equal(blocking.code, undefined);
  assert.match(blocking.error, /same agent instructions/);
  assert.doesNotMatch(blocking.error, /same code/);
  assert.equal((await setDuplicates("warn", "off")).status, 200);
  const warnedMcp = await dispatch("/mcp", "author", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "submit_recipe",
      arguments: { ...payload, slug: "policy-mcp-duplicate", files: units },
    },
  });
  const warnedMcpResult = (await warnedMcp.json()).result;
  assert.equal(warnedMcpResult.structuredContent.code, "duplicate_warning");
  assert.match(warnedMcpResult.content[0].text, /allowDuplicates/);
  assert.equal((await setDuplicates("off", "off")).status, 200);
  assert.equal((await submitPolicyExample("policy-duplicate-off")).status, 201);
  assert.equal((await dispatch("/api/settings", "maintainer", settings.policy)).status, 200);

  const legacySlug = "legacy-fingerprint";
  const legacyId = crypto.randomUUID();
  const legacyFiles = { source: "export const legacy = {label: 'keep two  spaces'};" };
  await db
    .prepare("INSERT INTO recipes (slug, owner) VALUES (?, ?)")
    .bind(legacySlug, "author")
    .run();
  await db
    .prepare(
      "INSERT INTO revisions (id, slug, author, title, summary, tags, files) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      legacyId,
      legacySlug,
      "author",
      "Legacy",
      "A legacy fixture before indexing.",
      "[]",
      JSON.stringify(legacyFiles),
    )
    .run();
  const sameCode = { source: 'export const legacy = {\n  label: "keep two  spaces",\n};' };
  const repeated = await submit("legacy-duplicate", sameCode);
  assert.equal(repeated.status, 409);
  assert.match((await repeated.json()).error, /same code/);
  const fingerprints = await db
    .prepare("SELECT code_hash, unit_hashes FROM revisions WHERE id = ?")
    .bind(legacyId)
    .first();
  assert.match(fingerprints.code_hash, /^[a-f0-9]{64}$/u);
  assert.match(JSON.parse(fingerprints.unit_hashes).source, /^[a-f0-9]{64}$/u);
  assert.equal(
    await db.prepare("SELECT slug FROM recipes WHERE slug = 'legacy-duplicate'").first(),
    null,
  );
  const privateMatch = await dispatch("/api/submit", "reader", {
    ...payload,
    slug: "private-match",
    files: sameCode,
  });
  assert.equal(privateMatch.status, 201);
  const metadataEdit = await dispatch("/api/submit", "author", {
    ...payload,
    slug: legacySlug,
    replace: legacyId,
    editVersion: 0,
    files: sameCode,
  });
  assert.equal(metadataEdit.status, 200);
  const changedLiteral = await submit("legacy-different", {
    source: 'export const legacy = { label: "keep two spaces" };',
  });
  assert.equal(changedLiteral.status, 201);
  const concurrent = await Promise.allSettled([
    submit("simultaneous-a", { source: "export const concurrent = 12345;" }),
    submit("simultaneous-b", { source: "export const concurrent = 12345;" }),
  ]);
  assert.deepEqual(concurrent.map((result) => result.value?.status).sort(), [201, 409]);

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
  const nativeTestPolicy = {
    ...settings.policy,
    quality: { ...settings.policy.quality, typeCheck: "error" },
  };
  assert.equal((await dispatch("/api/settings", "maintainer", nativeTestPolicy)).status, 200);
  const guardRecipe = {
    source:
      "export function hasFields(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }",
    tests: `import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasFields } from "./source.ts";

describe("hasFields", () => {
  it("narrows a value after an assertion", () => {
    const input: unknown = { label: "Cookbook" };
    assert.ok(hasFields(input));
    assert.equal(input.label, "Cookbook");
  });
});
`,
  };
  const validTests = await submit("native-test-fixture", guardRecipe);
  assert.equal(validTests.status, 201);
  const savedTests = await validTests.json();
  const testSnapshot = await tool("get_recipe", { slug: savedTests.slug, revision: savedTests.id });
  await verifyRecipeTests(testSnapshot.files);
  const invalidTests = await submit("native-test-type-error", {
    ...guardRecipe,
    tests: 'import { it } from "node:test"; it(123, () => {});',
  });
  assert.equal(invalidTests.status, 400);
  assert.match((await invalidTests.json()).error, /TS2769/);

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
    await verifyRecipeTests(stored.files);
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
  const draft = await tool("submit_recipe", {
    ...payload,
    slug: "editable-draft",
    files: {
      source: "export const value = 1;",
      documentation: "# Review notes\n\nPrefer a stable boundary.",
    },
  });
  const draftRef = { slug: draft.slug, revision: draft.id };
  const reviewPath = "/api/recipe?" + new URLSearchParams({ ...draftRef, reviewComments: "1" });
  const feedback = {
    ...draftRef,
    editVersion: 0,
    part: "documentation",
    line: 3,
    body: "Explain the <boundary>.",
  };
  assert.equal((await dispatch("/api/comment", "author", feedback)).status, 403);
  assert.equal(
    (await dispatch("/api/comment", "maintainer", { ...feedback, line: 4 })).status,
    400,
  );
  assert.equal(
    (await dispatch("/api/comment", "maintainer", { ...feedback, part: "tests" })).status,
    400,
  );
  const posted = await dispatch("/api/comment", "maintainer", feedback);
  assert.equal(posted.status, 201);
  const note = await posted.json();
  assert.equal(note.excerpt, "Prefer a stable boundary.");
  assert.equal(note.body, feedback.body);
  const blank = await dispatch("/api/comment", "maintainer", { ...feedback, line: 2 });
  assert.equal(blank.status, 201);
  assert.equal((await blank.json()).excerpt, "");
  const sourceComment = await dispatch("/api/comment", "maintainer", {
    ...feedback,
    part: "source",
    line: 1,
  });
  assert.equal(sourceComment.status, 201);
  assert.match((await sourceComment.json()).excerpt, /value = 1/);
  const authorReview = (await (await dispatch(reviewPath, "author")).json()).review;
  assert.equal(authorReview.canComment, false);
  assert.ok(authorReview.comments.some(({ id }) => id === note.id));
  assert.equal((await dispatch(reviewPath, "reader")).status, 404);
  const replace = {
    ...payload,
    slug: draft.slug,
    replace: draft.id,
    editVersion: draft.editVersion,
    files: { source: "export const value = 2;" },
  };
  const review = (action, editVersion, user = "maintainer") =>
    dispatch("/api/action", user, {
      ...draftRef,
      action,
      editVersion,
      reason: "Add the missing behavior.",
    });
  assert.equal((await tool("get_recipe", draftRef)).canReplace, true);
  assert.equal(
    (await dispatch("/api/submit", "author", { ...replace, base: draft.id })).status,
    400,
  );
  assert.equal(
    (await dispatch("/api/submit", "author", { ...replace, editVersion: undefined })).status,
    400,
  );
  assert.equal((await dispatch("/api/submit", "reader", replace)).status, 409);
  assert.equal(
    (await dispatch("/api/submit", "author", { ...replace, files: { source: "debugger;" } }))
      .status,
    400,
  );
  assert.equal((await tool("get_recipe", draftRef)).editVersion, 0);
  const saved = await tool("submit_recipe", replace);
  assert.equal(saved.id, draft.id);
  assert.equal(saved.editVersion, 1);
  assert.equal((await dispatch("/api/comment", "maintainer", feedback)).status, 409);
  const oldFeedback = (await (await dispatch(reviewPath, "author")).json()).review.comments;
  assert.deepEqual(
    oldFeedback.find(({ id }) => id === note.id),
    note,
  );
  assert.equal(
    (await tool("my_revisions", {})).filter(({ slug }) => slug === draft.slug).length,
    1,
  );
  assert.equal((await dispatch("/api/submit", "author", replace)).status, 409);
  assert.equal((await review("approve", 0)).status, 409);
  assert.equal((await review("remove_draft", 0, "author")).status, 409);
  assert.equal((await review("request_changes", 1)).status, 200);
  assert.equal((await tool("get_recipe", draftRef)).canRemoveDraft, true);
  const resubmitted = await dispatch("/api/submit", "author", {
    ...replace,
    editVersion: 1,
    files: { source: "export const value = 3;" },
  });
  assert.equal(resubmitted.status, 200);
  assert.equal((await resubmitted.json()).id, draft.id);
  const updated = await tool("get_recipe", draftRef);
  assert.equal(updated.state, "pending");
  assert.equal(updated.review_note, null);
  assert.match(updated.files.source, /value = 3/);
  assert.equal((await review("approve", 2)).status, 200);
  assert.equal(
    (await dispatch("/api/submit", "author", { ...replace, editVersion: 2 })).status,
    409,
  );
  assert.equal((await review("remove_draft", 2, "author")).status, 409);
  assert.equal((await tool("get_recipe", draftRef)).canReplace, false);

  const duplicate = await tool("submit_recipe", {
    ...replace,
    replace: undefined,
    base: draft.id,
    editVersion: undefined,
  });
  const duplicateRef = { slug: duplicate.slug, revision: duplicate.id };
  const duplicateAction = (user, action) =>
    dispatch("/api/action", user, {
      ...duplicateRef,
      action,
      editVersion: duplicate.editVersion,
      reason: "Duplicate revision.",
    });
  assert.notEqual(duplicate.id, draft.id);
  assert.equal(
    (
      await dispatch("/api/comment", "maintainer", {
        ...feedback,
        ...duplicateRef,
        editVersion: duplicate.editVersion,
        part: "source",
        line: 1,
      })
    ).status,
    201,
  );
  assert.equal((await duplicateAction("maintainer", "request_changes")).status, 200);
  assert.equal((await duplicateAction("reader", "remove_draft")).status, 409);
  assert.equal((await duplicateAction("author", "remove_draft")).status, 200);
  assert.equal(
    await db
      .prepare("SELECT id FROM revision_line_comments WHERE revision = ?")
      .bind(duplicate.id)
      .first(),
    null,
  );
  assert.equal(
    (await dispatch("/api/recipe?" + new URLSearchParams(duplicateRef), "author")).status,
    404,
  );
  assert.equal((await tool("get_recipe", draftRef)).state, "approved");

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
  const publishedFeedback = await dispatch("/api/comment", "maintainer", {
    ...feedback,
    ...revision,
    editVersion: submitted.editVersion,
    line: 1,
  });
  assert.equal(publishedFeedback.status, 201);
  const publicReviewPath =
    "/api/recipe?" + new URLSearchParams({ ...revision, reviewComments: "1" });
  assert.equal((await (await dispatch(publicReviewPath, "reader")).json()).review, undefined);
  assert.equal(
    (await (await dispatch(publicReviewPath, "author")).json()).review.comments.length,
    1,
  );
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
  const publishedDuplicate = await dispatch("/api/submit", "reader", {
    ...payload,
    slug: "duplicate-of-public-recipe",
  });
  assert.equal(publishedDuplicate.status, 409);
  assert.match((await publishedDuplicate.json()).error, /same code/);
  const next = await tool(
    "submit_recipe",
    {
      ...payload,
      base: submitted.id,
      summary: "A proposed revision.",
      allowDuplicates: true,
      files: { ...payload.files, styles: ".recipe-preview { color: red; }" },
    },
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
