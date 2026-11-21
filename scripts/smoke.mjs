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
/**
 * Start a test Worker using the shared temporary database directory.
 * @param options Optional bindings and outbound fixture transport.
 */
const worker = (options = {}) =>
  new Miniflare({
    scriptPath: resolve("dist/server/index.js"),
    modules: true,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "cookbook" },
    d1Persist: folder,
    ...options,
    bindings: { MAINTAINER_EMAILS: "maintainer@example.test", ...options.bindings },
  });
let runtime = worker();
/**
 * Dispatch a request against the local Worker with a synthetic identity.
 * @param path The path to request within the Worker.
 * @param user The fixture identity or null for anonymous access.
 * @param data The optional JSON payload for a POST request.
 */
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

/**
 * Invoke a local MCP tool and require a successful result.
 * @param name The MCP tool name to invoke.
 * @param args The arguments to pass to the tool.
 * @param user The synthetic identity making the request.
 */
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
/**
 * Measure the serialized size of an MCP result in bytes and tokens.
 * @param result The result to serialize exactly as returned.
 */
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
  const legacyReviewRevision = "00000000-0000-4000-8000-000000000006";
  await db.batch([
    db.prepare("INSERT INTO recipes (slug, owner) VALUES ('legacy-comment', 'legacy-author')"),
    db
      .prepare(
        `INSERT INTO revisions (id, slug, author, title, summary, tags, files)
         VALUES (?, 'legacy-comment', 'legacy-author', 'Legacy recipe', 'Migration fixture', '[]', '{}')`,
      )
      .bind(legacyReviewRevision),
    db
      .prepare(
        `INSERT INTO revision_line_comments (revision, edit_version, part, line, excerpt, body, reviewer)
         VALUES (?, 0, 'documentation', 2, 'Previous line', 'Previous comment', 'maintainer')`,
      )
      .bind(legacyReviewRevision),
  ]);
  const commentMigration = await readFile("drizzle/0007_revision_comments.sql", "utf8");
  await db.batch(
    commentMigration.split("--> statement-breakpoint").map((sql) => db.prepare(sql.trim())),
  );
  const listingMigration = await readFile("drizzle/0008_revision_listing_indexes.sql", "utf8");
  await db.batch(
    listingMigration.split("--> statement-breakpoint").map((sql) => db.prepare(sql.trim())),
  );
  const secretsMigration = await readFile("drizzle/0009_openai_settings.sql", "utf8");
  await db.batch(
    secretsMigration.split("--> statement-breakpoint").map((sql) => db.prepare(sql.trim())),
  );
  await db.prepare(await readFile("drizzle/0010_recipe_file_names.sql", "utf8")).run();
  await db.prepare(await readFile("drizzle/0011_mcp_settings.sql", "utf8")).run();
  await db.prepare(await readFile("drizzle/0012_assistant_docs_mcp.sql", "utf8")).run();
  await db.prepare(await readFile("drizzle/0013_context7.sql", "utf8")).run();
  await db.prepare(await readFile("drizzle/0014_assistant_skills.sql", "utf8")).run();
  const legacyReview = await db
    .prepare("SELECT line, excerpt, body FROM revision_comments WHERE revision = ?")
    .bind(legacyReviewRevision)
    .first();
  assert.deepEqual(legacyReview, { line: 2, excerpt: "Previous line", body: "Previous comment" });
  await db
    .prepare("UPDATE revisions SET state = 'removed', files = NULL WHERE id = ?")
    .bind(legacyReviewRevision)
    .run();

  assert.equal((await dispatch("/api/search", null)).status, 401);
  const mcpPath = "/api/settings/mcp";
  const docsMcpPath = mcpPath + "/openai-docs";
  const context7Path = mcpPath + "/context7";
  const skillsPath = mcpPath + "/skills";
  const builtInSkills = ["caveman", "suomenkieli"];
  const skillCatalog = [...builtInSkills, "seo", "design", "import", "publication"];
  assert.deepEqual(await (await dispatch(skillsPath, "maintainer")).json(), {
    enabled: builtInSkills,
    skills: skillCatalog,
  });
  assert.equal((await dispatch(skillsPath, "author")).status, 403);
  assert.equal((await dispatch(skillsPath, "author", { enabled: [] })).status, 403);
  assert.equal(
    (await dispatch(skillsPath, "maintainer", { enabled: ["caveman", "caveman"] })).status,
    400,
  );
  assert.equal((await dispatch(skillsPath, "maintainer", { enabled: ["unknown"] })).status, 400);
  assert.equal((await dispatch(skillsPath, "maintainer", { enabled: [] })).status, 200);
  assert.deepEqual(await (await dispatch(skillsPath, "maintainer")).json(), {
    enabled: [],
    skills: skillCatalog,
  });
  assert.equal(
    (await dispatch("/api/assistant", "maintainer", { question: "Briefly.", skill: "caveman" }))
      .status,
    403,
  );
  assert.equal((await dispatch(skillsPath, "maintainer", { enabled: builtInSkills })).status, 200);
  assert.equal(
    (await dispatch(skillsPath, "maintainer", { enabled: ["publication"] })).status,
    200,
  );
  assert.deepEqual(await (await dispatch(skillsPath, "maintainer")).json(), {
    enabled: ["publication"],
    skills: skillCatalog,
  });
  assert.equal((await dispatch(skillsPath, "maintainer", { enabled: builtInSkills })).status, 200);
  const finnishSkill = await dispatch("/api/skill?name=suomenkieli", "author");
  assert.equal(finnishSkill.headers.get("content-disposition"), 'attachment; filename="SKILL.md"');
  assert.match(await finnishSkill.text(), /^---\nname: suomenkieli/u);
  assert.equal((await dispatch("/api/skill?name=unknown", "author")).status, 404);
  assert.equal((await dispatch(context7Path, "author", { enabled: true })).status, 403);
  assert.deepEqual(await (await dispatch(context7Path, "maintainer")).json(), { enabled: false });

  assert.deepEqual(await (await dispatch(docsMcpPath, "maintainer")).json(), { enabled: false });
  assert.equal((await dispatch(docsMcpPath, "author", { enabled: true })).status, 403);
  const mcpSettings = await (await dispatch(mcpPath, "maintainer")).json();
  const mcpSelection = { enabled: true, enabledTools: ["search_recipes"] };
  const listMcp = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const readMcp = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_recipe", arguments: { slug: "example" } },
  };
  assert.equal((await dispatch(mcpPath, null)).status, 401);
  assert.equal((await dispatch(mcpPath, "author")).status, 403);
  assert.equal((await dispatch(mcpPath + "/check", "author")).status, 403);
  assert.equal((await dispatch(mcpPath, "author", mcpSelection)).status, 403);
  assert.equal(
    (await dispatch(mcpPath, "maintainer", { enabled: true, enabledTools: ["other"] })).status,
    400,
  );
  assert.equal(mcpSettings.enabled, true);
  assert.deepEqual(
    mcpSettings.enabledTools,
    mcpSettings.tools.map(({ name }) => name),
  );
  assert.equal((await dispatch(mcpPath, "maintainer", mcpSelection)).status, 200);
  const limitedTools = await (await dispatch("/mcp", "author", listMcp)).json();
  assert.deepEqual(
    limitedTools.result.tools.map(({ name }) => name),
    ["search_recipes"],
  );
  assert.deepEqual(await (await dispatch(mcpPath + "/check", "maintainer")).json(), {
    tools: ["search_recipes"],
  });
  const disabledCall = await (await dispatch("/mcp", "maintainer", readMcp)).json();
  assert.equal(disabledCall.result.isError, true);
  assert.match(disabledCall.result.content[0].text, /disabled/u);
  assert.ok(Array.isArray((await tool("search_recipes", {})).items));
  assert.equal(
    (await dispatch(mcpPath, "maintainer", { ...mcpSelection, enabled: false })).status,
    200,
  );
  const paused = await (await dispatch("/mcp", "author", listMcp)).json();
  assert.deepEqual(paused.result.tools, []);
  const pausedCall = await (
    await dispatch("/mcp", "author", {
      ...readMcp,
      params: { name: "search_recipes" },
    })
  ).json();
  assert.equal(pausedCall.result.isError, true);
  assert.match(pausedCall.result.content[0].text, /disabled/u);
  assert.deepEqual(
    (await (await dispatch(mcpPath, "maintainer")).json()).enabledTools,
    mcpSelection.enabledTools,
  );
  assert.equal((await dispatch(mcpPath, "maintainer", mcpSettings)).status, 200);
  assert.equal((await dispatch("/assistant", null)).status, 200);
  assert.equal((await dispatch("/api/assistant", null)).status, 401);
  assert.equal(
    (await dispatch("/api/assistant", "author", { question: "Find a recipe." })).status,
    403,
  );
  assert.equal((await dispatch("/api/assistant/models", "reader")).status, 403);
  assert.deepEqual(await (await dispatch("/api/assistant", "maintainer")).json(), {
    configured: false,
    docsSearch: false,
    context7Search: false,
    skills: builtInSkills,
    model: null,
  });
  assert.equal(
    (await dispatch("/api/assistant", "maintainer", { question: "Find a recipe." })).status,
    503,
  );
  assert.equal((await dispatch("/api/settings/openai", "author")).status, 403);
  assert.equal(
    (
      await dispatch("/api/settings/openai", "author", {
        model: "fixture-model",
        apiKey: "test-provider-credential",
        maintainer: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await dispatch("/api/settings/openai", "maintainer", {
        model: "fixture-model",
        apiKey: "test-provider-credential",
      })
    ).status,
    503,
  );
  assert.deepEqual(await (await dispatch("/api/settings/openai", "maintainer")).json(), {
    model: null,
    hasCredential: false,
    encryptionAvailable: false,
    configured: false,
  });
  const payload = {
    slug: "batch-items",
    title: "Batch items into chunks",
    summary: "Split items into fixed-size batches.",
    tags: ["arrays", "utilities"],
    files: {
      source: `/**
 * Divide items into consecutive batches.
 * @param items Values to allocate to batches.
 * @param size Maximum number of items per batch.
 * @throws {RangeError} When size is not a positive safe integer.
 */
export function chunk(items,size){if(!Number.isSafeInteger(size)||size<1){throw new RangeError("Invalid size");}const out=[];for(let i=0;i<items.length;i+=size){out.push(items.slice(i,i+size));}return out;}`,
      interface: `/**
 * Divide items into consecutive batches.
 * @param items Values to allocate to batches.
 * @param size Maximum number of items per batch.
 */
export declare function chunk<T>(items:readonly T[],size:number):T[][];`,
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
  assert.equal(settings.policy.prettier.blankLinesBetweenDeclarations, true);
  assert.equal(settings.policy.quality.warningsAsErrors, false);
  assert.equal(settings.policy.eslint["quality/documentation"], "error");

  const legacyPolicy = {
    prettier: { singleQuote: true, printWidth: 90 },
    eslint: { "no-debugger": false, "quality/documentation": "warn" },
  };
  await db
    .prepare("INSERT INTO code_policy (id, config) VALUES (1, ?)")
    .bind(JSON.stringify(legacyPolicy))
    .run();
  const upgraded = (await (await dispatch("/api/settings", "maintainer")).json()).policy;
  assert.equal(upgraded.prettier.printWidth, 90);
  assert.equal(upgraded.prettier.singleQuote, true);
  assert.equal(upgraded.prettier.blankLinesBetweenDeclarations, true);
  assert.equal(upgraded.eslint["no-debugger"], 0);
  assert.equal(upgraded.eslint.curly, "error");
  assert.equal(upgraded.eslint["quality/documentation"], "error");
  assert.equal((await dispatch("/api/settings", "maintainer", settings.policy)).status, 200);
  const namingPolicy = {
    ...settings.policy,
    quality: { ...settings.policy.quality, typeCheck: "error" },
  };
  assert.equal((await dispatch("/api/settings", "maintainer", namingPolicy)).status, 200);
  const namedPayload = {
    ...payload,
    slug: "file-naming-fixture",
    files: {
      source:
        'import type { Entry } from "./entry-contract.ts"; export const namedEntry: Entry = { name: "fixture" };',
      interface: "export interface Entry { readonly name: string; }",
      tests:
        'import { namedEntry } from "./named-entry.js"; export const received = namedEntry.name;',
      styles: ".named-entry { color: red; }",
      documentation: "# Naming fixture",
      instructions: "Preserve the file names.",
    },
    fileNames: {
      source: "named-entry.ts",
      interface: "entry-contract.ts",
      tests: "entry.test.ts",
      styles: "entry.css",
      documentation: "guide.md",
      instructions: "workflow.txt",
    },
  };
  const named = await tool("submit_recipe", namedPayload);
  const namedRef = { slug: named.slug, revision: named.id };
  assert.deepEqual((await tool("get_recipe", namedRef)).fileNames, namedPayload.fileNames);
  assert.deepEqual((await tool("get_recipe", { ...namedRef, parts: ["interface"] })).fileNames, {
    interface: "entry-contract.ts",
  });
  const rename = { ...namedPayload, replace: named.id, editVersion: named.editVersion };
  const invalidName = await dispatch("/api/submit", "author", {
    ...rename,
    fileNames: { source: "../outside.ts" },
  });
  assert.equal(invalidName.status, 400);
  const collision = await dispatch("/api/submit", "author", {
    ...rename,
    fileNames: { tests: "NAMED-ENTRY.ts" },
  });
  assert.equal(collision.status, 400);
  const staleImport = await dispatch("/api/submit", "author", {
    ...rename,
    fileNames: { source: "new-entry.ts" },
  });
  assert.equal(staleImport.status, 400);
  assert.match((await staleImport.json()).error, /recipe-imports/);
  const renamed = await tool("submit_recipe", {
    ...rename,
    fileNames: { source: "new-entry.ts", documentation: "" },
    files: { ...rename.files, tests: rename.files.tests.replace("named-entry.js", "new-entry.js") },
  });
  assert.equal(renamed.id, named.id);
  assert.deepEqual((await tool("get_recipe", namedRef)).fileNames, {
    ...namedPayload.fileNames,
    source: "new-entry.ts",
    documentation: "README.md",
  });
  assert.equal((await dispatch("/api/settings", "maintainer", settings.policy)).status, 200);
  const spacingPayload = {
    ...payload,
    slug: "declaration-spacing",
    files: {
      source:
        "export type First = string;\n/** Describe the second type. */\nexport type Second = number;",
    },
  };
  const spacedRecipe = await tool("submit_recipe", spacingPayload);
  const reference = { slug: spacedRecipe.slug, revision: spacedRecipe.id };
  assert.match((await tool("get_recipe", reference)).files.source, /;\n\n\/\*\*/u);
  const noSpacing = {
    ...settings.policy,
    prettier: { ...settings.policy.prettier, blankLinesBetweenDeclarations: false },
  };
  assert.equal((await dispatch("/api/settings", "maintainer", noSpacing)).status, 200);
  await tool("submit_recipe", {
    ...spacingPayload,
    replace: spacedRecipe.id,
    editVersion: spacedRecipe.editVersion,
  });
  assert.match((await tool("get_recipe", reference)).files.source, /[^\n]\n\/\*\*/u);
  assert.equal((await dispatch("/api/settings", "maintainer", settings.policy)).status, 200);
  const shell = await (await dispatch("/", null)).text();
  assert.match(shell, /recipes and guides/);
  assert.doesNotMatch(shell, /\{\{t:/);
  assert.match(shell, /href="\/review"/);
  assert.match(shell, /aria-controls="assistant-panel"/);
  assert.doesNotMatch(shell, /href="\/assistant"/);
  assert.doesNotMatch(shell, /href="#(?:library|contribute|mine|review|settings)"/);
  const routeRevision = "00000000-0000-4000-8000-000000000001";
  for (const path of [
    "/library",
    "/contribute",
    "/mine",
    "/review",
    "/settings",
    "/settings/openai",
    "/settings/code-policy",
    "/settings/mcp",
    "/recipe/review/route-example/" + routeRevision,
    "/edit/route-example/" + routeRevision,
    "/improve/route-example/" + routeRevision,
  ]) {
    const response = await dispatch(path, null);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), shell, path);
  }
  for (const path of [
    "/missing-page",
    "/recipe/review/route-example",
    "/recipe/missing/route-example/" + routeRevision,
    "/recipe/review/route-example/invalid-revision",
    "/recipe/review/%2F/" + routeRevision,
    "/edit/%ZZ/" + routeRevision,
    "/styles/extra.css",
  ]) {
    assert.equal((await dispatch(path, null)).status, 404, path);
  }

  /**
   * Submit a recipe snapshot as the test author.
   * @param slug The slug assigned to the fixture.
   * @param files The files included with the submitted snapshot.
   */
  const submit = (slug, files) => dispatch("/api/submit", "author", { ...payload, slug, files });
  const attemptedDowngrade = {
    ...settings.policy,
    eslint: { ...settings.policy.eslint, "quality/documentation": "off" },
    overrides: { tests: { "quality/documentation": "off" } },
  };
  assert.equal((await dispatch("/api/settings", "maintainer", attemptedDowngrade)).status, 200);
  for (const part of ["source", "interface", "tests"]) {
    const source =
      part === "interface" ? "declare function value(): number;" : "function value() { return 1; }";
    const rejected = await submit("missing-jsdoc-" + part, { [part]: source });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /quality\/documentation/);
  }
  assert.equal((await dispatch("/api/settings", "maintainer", settings.policy)).status, 200);
  const guide = await tool("submit_recipe", {
    ...payload,
    slug: "architecture-guide",
    files: { documentation: "# Architecture\nUse a service boundary." },
  });
  const guideFiles = await tool("get_recipe", { slug: guide.slug, revision: guide.id });
  assert.deepEqual(guideFiles.files, {
    documentation: "# Architecture\nUse a service boundary.\n",
  });
  /**
   * Send a maintainer action for the documentation-only fixture.
   * @param action The review action to apply to the guide.
   */
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
  /**
   * Submit the shared duplicate-policy fixture for a new slug.
   * @param slug The slug assigned to the duplicate-policy attempt.
   * @param options The extra submission flags used by this case.
   */
  const submitPolicyExample = (slug, options = {}) =>
    dispatch("/api/submit", "author", { ...payload, slug, files: units, ...options });
  assert.equal((await submitPolicyExample("policy-duplicate-original")).status, 201);
  /**
   * Save duplicate severities on the local test Worker.
   * @param duplicateCode The severity for matching code snapshots.
   * @param duplicateProse The severity for matching documentation and instructions.
   */
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
      source: `/**
 * Register the effect with its dependencies.
 * @param callback The effect to run after rendering.
 * @param deps The inputs that trigger another run.
 */
declare function useEffect(callback: () => void, deps: readonly string[]): void;
/**
 * Render a paragraph labelled for assistive technology.
 * @param label The accessible name for the paragraph.
 */
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
    source: `/**
 * Check that a value is a non-null object.
 * @param value The input to narrow before use.
 */
export function hasFields(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }`,
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
  const fileFeedback = { ...feedback, line: null, body: "Clarify the scope of this guide." };
  assert.equal((await dispatch("/api/comment", "author", feedback)).status, 403);
  assert.equal((await dispatch("/api/comment", "author", fileFeedback)).status, 403);
  assert.equal(
    (await dispatch("/api/comment", "maintainer", { ...feedback, line: 4 })).status,
    400,
  );
  assert.equal(
    (await dispatch("/api/comment", "maintainer", { ...feedback, part: "tests" })).status,
    400,
  );
  assert.equal(
    (await dispatch("/api/comment", "maintainer", { ...fileFeedback, part: "tests" })).status,
    400,
  );
  assert.equal(
    (await dispatch("/api/comment", "maintainer", { ...fileFeedback, line: 0 })).status,
    400,
  );
  const filePosted = await dispatch("/api/comment", "maintainer", fileFeedback);
  assert.equal(filePosted.status, 201);
  const fileNote = await filePosted.json();
  assert.equal(fileNote.part, "documentation");
  assert.equal(fileNote.line, null);
  assert.equal(fileNote.excerpt, null);
  assert.equal(fileNote.body, fileFeedback.body);
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
  assert.deepEqual(
    authorReview.comments.find(({ id }) => id === fileNote.id),
    fileNote,
  );
  assert.equal((await dispatch(reviewPath, "reader")).status, 404);
  const replace = {
    ...payload,
    slug: draft.slug,
    replace: draft.id,
    editVersion: draft.editVersion,
    files: { source: "export const value = 2;" },
  };
  /**
   * Send a review action for the submitted revision at a specified edit version.
   * @param action The review operation to request.
   * @param editVersion The saved edit version that the request expects.
   * @param user The synthetic user exercising review access.
   */
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
  assert.equal((await dispatch("/api/comment", "maintainer", fileFeedback)).status, 409);
  const oldFeedback = (await (await dispatch(reviewPath, "author")).json()).review.comments;
  assert.deepEqual(
    oldFeedback.find(({ id }) => id === note.id),
    note,
  );
  assert.deepEqual(
    oldFeedback.find(({ id }) => id === fileNote.id),
    fileNote,
  );
  assert.equal(
    (await tool("my_revisions", {})).items.filter(({ slug }) => slug === draft.slug).length,
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
  /**
   * Exercise a review action against the duplicate fixture.
   * @param user The synthetic user making the request.
   * @param action The review action to apply to the duplicate.
   */
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
        line: undefined,
      })
    ).status,
    201,
  );
  assert.equal((await duplicateAction("maintainer", "request_changes")).status, 200);
  assert.equal((await duplicateAction("reader", "remove_draft")).status, 409);
  assert.equal((await duplicateAction("author", "remove_draft")).status, 200);
  assert.equal(
    await db
      .prepare("SELECT id FROM revision_comments WHERE revision = ?")
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
  /**
   * Exercise state transitions on the submitted recipe revision.
   * @param kind The review or removal operation to exercise.
   * @param user The fixture user making the request.
   * @param reason The optional explanation for the action.
   */
  const action = (kind, user = "maintainer", reason) =>
    dispatch("/api/action", user, { ...revision, action: kind, reason });
  assert.deepEqual((await tool("search_recipes", {}, "reader")).items, []);
  assert.equal((await tool("get_recipe", { ...revision, parts: ["source"] })).state, "pending");
  assert.equal(
    (await dispatch("/api/recipe?" + new URLSearchParams(revision), "reader")).status,
    404,
  );
  assert.equal((await action("publish")).status, 409);
  assert.equal((await action("approve", "author")).status, 403);
  assert.equal((await action("approve")).status, 200);
  assert.deepEqual((await tool("search_recipes", {}, "reader")).items, []);
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
    (await tool("search_recipes", { query: "fixed-size batches", tag: "arrays" }, "reader"))
      .items[0].id,
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
  assert.equal((await tool("search_recipes", {}, "reader")).items[0].id, submitted.id);
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
  assert.deepEqual((await tool("search_recipes", {}, "reader")).items, []);
  assert.equal(
    (await dispatch("/api/recipe?" + new URLSearchParams(revision), "author")).status,
    404,
  );
  assert.equal(
    (await action("request_removal", "author", "Superseded by another approach")).status,
    200,
  );
  assert.equal((await action("approve_removal")).status, 200);
  const paginationDb = await runtime.getD1Database("DB");
  const sampleSize = 27;
  const sampleIds = Array.from(
    { length: sampleSize },
    (_, index) => "00000000-0000-4000-8000-" + String(index + 100).padStart(12, "0"),
  );
  await paginationDb.batch(
    sampleIds.flatMap((id, index) => {
      const slug = "paging-fixture-" + index;
      const state = index < 25 ? "pending" : index === 25 ? "quarantined" : "published";
      return [
        paginationDb
          .prepare("INSERT INTO recipes (slug, owner, live) VALUES (?, 'author', ?)")
          .bind(slug, state === "published" ? id : null),
        paginationDb
          .prepare(
            `INSERT INTO revisions
             (id, slug, author, title, summary, tags, state, created, published_at, removal_reason)
           VALUES (?, ?, 'author', 'Cursor sample', 'Shared paging keyword', '["paging"]', ?,
                   '2026-01-02 03:04:05', ?, ?)`,
          )
          .bind(
            id,
            slug,
            state,
            state === "published" ? "2026-01-02 03:04:05" : null,
            state === "published" ? "Private review note" : null,
          ),
      ];
    }),
  );
  const filters = { query: "CURSOR KEYWORD", tag: "paging", state: "pending" };
  await paginationDb.batch([
    paginationDb
      .prepare("UPDATE revisions SET tags = ? WHERE id = ?")
      .bind(JSON.stringify(["paging", "draft-only"]), sampleIds[0]),
    paginationDb
      .prepare("UPDATE revisions SET tags = ? WHERE id = ?")
      .bind(JSON.stringify(["paging", "public-only"]), sampleIds.at(-1)),
  ]);
  assert.equal((await dispatch("/api/tags", null)).status, 401);
  assert.equal((await dispatch("/api/tags?scope=review", "reader")).status, 403);
  assert.equal((await dispatch("/api/tags?scope=unknown", "maintainer")).status, 400);
  const publicTags = await (await dispatch("/api/tags", "reader")).json();
  assert.ok(publicTags.includes("paging"));
  assert.ok(publicTags.includes("public-only"));
  assert.ok(!publicTags.includes("draft-only"));
  const contributorTags = await (await dispatch("/api/tags?scope=contribute", "reader")).json();
  assert.ok(publicTags.every((tag) => contributorTags.includes(tag)));
  assert.ok(!contributorTags.includes("draft-only"));
  assert.ok(
    (await (await dispatch("/api/tags?scope=mine", "author")).json()).includes("draft-only"),
  );
  assert.ok(
    (await (await dispatch("/api/tags?scope=review", "maintainer")).json()).includes("draft-only"),
  );
  const first = await tool("review_queue", filters, "maintainer");
  assert.equal(first.items.length, 20);
  assert.equal(first.previousCursor, null);
  assert.equal(first.items[0].id, sampleIds[24]);
  assert.equal(first.items[0].files, undefined);
  assert.match(first.nextCursor, /^next\|/u);
  const second = await tool("review_queue", { ...filters, cursor: first.nextCursor }, "maintainer");
  assert.equal(second.items.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(({ id }) => id)).size, 25);
  const previous = await tool(
    "review_queue",
    { ...filters, cursor: second.previousCursor },
    "maintainer",
  );
  assert.deepEqual(previous, first);
  const path = "/api/queue?" + new URLSearchParams({ ...filters, limit: "4" });
  const filtered = await (await dispatch(path, "maintainer")).json();
  assert.equal(filtered.items.length, 4);
  assert.equal((await dispatch(path, "author")).status, 403);
  const multiTagPath = "/api/queue?query=cursor+keyword&tag=PAGING&tag=draft-only&state=pending";
  const multiTagPage = await (await dispatch(multiTagPath, "maintainer")).json();
  assert.deepEqual(
    multiTagPage.items.map(({ id }) => id),
    [sampleIds[0]],
  );
  const disjointTags = await tool(
    "review_queue",
    { ...filters, tags: ["draft-only", "public-only"] },
    "maintainer",
  );
  assert.deepEqual(disjointTags.items, []);
  const publicMultiTag = await tool(
    "search_recipes",
    { query: "paging keyword", tags: ["paging", "public-only"] },
    "reader",
  );
  assert.deepEqual(
    publicMultiTag.items.map(({ id }) => id),
    [sampleIds.at(-1)],
  );
  for (const query of ["", "?query=++", "?tag=paging&tag=public-only"]) {
    const response = await dispatch("/api/search" + query, "reader");
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.deepEqual(
      page.items.map(({ id }) => id),
      [sampleIds.at(-1)],
    );
  }
  const unfilteredQueue = await (await dispatch("/api/queue", "maintainer")).json();
  assert.equal(unfilteredQueue.items.length, 20);
  assert.match(unfilteredQueue.nextCursor, /^next\|/u);
  for (const params of ["limit=51", "limit=0", "cursor=malformed", "state=published"]) {
    assert.equal((await dispatch("/api/queue?" + params, "maintainer")).status, 400);
  }
  const denied = await dispatch("/mcp", "author", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "review_queue", arguments: filters },
  });
  assert.equal((await denied.json()).result.isError, true);
  const authored = await tool("my_revisions", { query: "paging keyword", limit: 1 });
  assert.equal(authored.items.length, 1);
  assert.equal(typeof authored.nextCursor, "string");
  const publicPage = await tool("search_recipes", { query: "paging keyword", limit: 1 }, "reader");
  assert.equal(publicPage.items.length, 1);
  assert.equal(publicPage.items[0].removal_reason, undefined);
  assert.equal(publicPage.nextCursor, null);
  const removal = await tool("review_queue", { ...filters, state: "removal" }, "maintainer");
  assert.deepEqual(
    removal.items.map(({ id }) => id),
    [sampleIds.at(-1)],
  );
  await paginationDb
    .prepare("UPDATE revisions SET files = ? WHERE id = ?")
    .bind(
      JSON.stringify({
        documentation: "Use this public recipe.",
        instructions: "Unselected text.",
      }),
      sampleIds.at(-1),
    )
    .run();
  const firstPrivate = sampleIds[0];
  await paginationDb
    .prepare("UPDATE revisions SET files = ? WHERE id = ?")
    .bind(JSON.stringify({ documentation: "Private draft." }), firstPrivate)
    .run();
  await runtime.dispose();
  const model = "fixture-model";
  let key = "test-provider-credential";
  const deploymentKey = "12".repeat(32);
  const rotatedDeploymentKey = "34".repeat(32);
  let inferenceCalls = 0;
  const docsMethods = [];
  const provider = {
    bindings: { SETTINGS_ENCRYPTION_KEY: deploymentKey },
    /**
     * Emulate the provider and validate the request transcript without network access.
     * @param request The local Worker outgoing request.
     */
    outboundService: async (request) => {
      const url = new URL(request.url);
      const context7 = url.href === "https://mcp.context7.com/mcp";
      if (url.href === "https://developers.openai.com/mcp" || context7) {
        assert.equal(request.headers.get("authorization"), null);
        const { method, id, params } = await request.json();
        if (!context7) {
          docsMethods.push(method);
        }
        if (method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: { protocolVersion: "2025-11-25" },
          });
        }
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        assert.equal(method, "tools/call");
        if (context7) {
          assert.deepEqual(params, {
            name: "query-docs",
            arguments: { query: "React state", libraryId: "/react/react" },
          });
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "React documentation excerpt" }] },
          });
        }
        assert.deepEqual(params, {
          name: "search_openai_docs",
          arguments: { query: "Responses streaming", limit: 3 },
        });
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  hits: [
                    {
                      url: "https://developers.openai.com/api/docs/guides/streaming-responses",
                      hierarchy: { lvl1: "Streaming" },
                      content: "Public excerpt",
                    },
                    { url: "https://outside.example/unknown", content: "Rejected result" },
                  ],
                }),
              },
            ],
          },
        });
      }
      assert.equal(request.headers.get("authorization"), "Bearer " + key);
      assert.equal(url.origin, "https://api.openai.com");
      if (url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: model }, { id: model }, { id: "invalid model" }] });
      }
      assert.equal(url.pathname, "/v1/responses");
      const body = await request.json();
      assert.equal(body.model, model);
      assert.equal(body.store, false);
      assert.equal(body.parallel_tool_calls, false);
      if (body.tools.some(({ name }) => name === "query_context7_docs")) {
        assert.match(body.instructions, /Use clear standard Finnish\./u);
        const last = body.input.at(-1);
        const item =
          last.role === "user"
            ? {
                type: "function_call",
                call_id: "context7",
                name: "query_context7_docs",
                arguments: "{}",
              }
            : { type: "message", content: [{ type: "output_text", text: "React-ohje löytyi." }] };
        if (last.role !== "user") {
          assert.deepEqual(JSON.parse(last.output), { excerpt: "React documentation excerpt" });
        }
        return Response.json({ status: "completed", output: [item] });
      }
      if (body.tools.some(({ name }) => name === "search_openai_docs")) {
        assert.equal(body.tools.at(-1).strict, true);
        const last = body.input.at(-1);
        if (last.role === "user") {
          return Response.json({
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "docs",
                name: "search_openai_docs",
                arguments: "{}",
              },
            ],
          });
        }
        assert.match(last.output, /Public excerpt/u);
        assert.doesNotMatch(last.output, /outside\.example|Rejected result/u);
        return Response.json({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "See Streaming." }] }],
        });
      }
      assert.deepEqual(
        body.tools.map(({ name }) => name),
        ["search_recipes", "get_recipe"],
      );
      inferenceCalls++;
      const last = body.input.at(-1);
      let output;
      if (inferenceCalls === 1) {
        assert.equal(last.content, "Find the paging recipe.");
        output = {
          type: "function_call",
          call_id: "blocked",
          name: "get_recipe",
          arguments: JSON.stringify({ slug: "paging-fixture-0" }),
        };
      } else if (inferenceCalls === 2) {
        assert.match(last.output, /Could not look up/);
        output = {
          type: "function_call",
          call_id: "searched",
          name: "search_recipes",
          arguments: JSON.stringify({ query: "paging keyword" }),
        };
      } else if (inferenceCalls === 3) {
        assert.deepEqual(
          JSON.parse(last.output).items.map(({ slug }) => slug),
          ["paging-fixture-26"],
        );
        output = {
          type: "function_call",
          call_id: "read",
          name: "get_recipe",
          arguments: JSON.stringify({ slug: "paging-fixture-26" }),
        };
      } else if (inferenceCalls === 4) {
        assert.deepEqual(JSON.parse(last.output).parts, {
          documentation: { text: "Use this public recipe.", truncated: false },
        });
        output = {
          type: "message",
          content: [{ type: "output_text", text: "Use the paging recipe." }],
        };
      } else {
        return Response.json({ error: { message: "Private provider failure." } }, { status: 429 });
      }
      return Response.json({ status: "completed", output: [output] });
    },
  };
  runtime = worker(provider);
  const refused = await runtime.dispatchFetch("https://cookbook.local/api/settings/openai", {
    method: "POST",
    headers: {
      origin: "https://outside.example",
      "oai-authenticated-user-id": "maintainer",
      "oai-authenticated-user-email": "maintainer@example.test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, apiKey: key }),
  });
  assert.equal(refused.status, 403);
  const savedOpenAi = await dispatch("/api/settings/openai", "maintainer", { apiKey: key });
  assert.equal(savedOpenAi.status, 200);
  assert.deepEqual(await savedOpenAi.json(), {
    model: null,
    hasCredential: true,
    encryptionAvailable: true,
    configured: false,
  });
  assert.deepEqual(await (await dispatch("/api/assistant/models", "maintainer")).json(), {
    status: "ready",
    models: [model],
  });
  assert.equal(
    (await dispatch("/api/assistant", "maintainer", { question: "Find a recipe." })).status,
    503,
  );
  const secretsDb = await runtime.getD1Database("DB");
  const row = await secretsDb
    .prepare("SELECT credential FROM openai_settings WHERE id = 1")
    .first();
  assert.match(row.credential, /^v1\.[a-f0-9]{24}\.[a-f0-9]+$/u);
  assert.ok(!JSON.stringify(row).includes(key));
  const metadataOnly = await dispatch("/api/settings/openai", "maintainer", { model });
  assert.equal(metadataOnly.status, 200);
  assert.deepEqual(
    await secretsDb.prepare("SELECT credential FROM openai_settings WHERE id = 1").first(),
    row,
  );
  await runtime.dispose();
  runtime = worker(provider);
  assert.deepEqual(await (await dispatch("/api/assistant", "maintainer")).json(), {
    configured: true,
    model,
    docsSearch: false,
    context7Search: false,
    skills: builtInSkills,
  });
  assert.deepEqual(await (await dispatch("/api/assistant/models", "maintainer")).json(), {
    status: "ready",
    models: [model],
  });
  assert.equal((await dispatch("/api/assistant", "maintainer", { question: " " })).status, 400);
  const answer = await dispatch("/api/assistant", "maintainer", {
    question: "Find the paging recipe.",
    model: "unapproved",
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), {
    answer: "Use the paging recipe.",
    sources: [{ slug: "paging-fixture-26", id: sampleIds.at(-1), title: "Cursor sample" }],
    docsSources: [],
  });
  const docsQuestion = { question: "Explain streaming.", docsQuery: "Responses streaming" };
  assert.equal((await dispatch("/api/assistant", "maintainer", docsQuestion)).status, 403);
  assert.equal((await dispatch(docsMcpPath, "maintainer", { enabled: true })).status, 200);
  const docsAnswer = await dispatch("/api/assistant", "maintainer", docsQuestion);
  assert.equal(docsAnswer.status, 200);
  assert.deepEqual(await docsAnswer.json(), {
    answer: "See Streaming.",
    sources: [],
    docsSources: [
      {
        url: "https://developers.openai.com/api/docs/guides/streaming-responses",
        title: "Streaming",
      },
    ],
  });
  assert.deepEqual(docsMethods, ["initialize", "notifications/initialized", "tools/call"]);
  assert.equal((await dispatch(docsMcpPath, "maintainer", { enabled: false })).status, 200);
  const contextQuestion = {
    question: "Selitä tila.",
    docsQuery: "React state",
    libraryId: "/react/react",
    skill: "suomenkieli",
  };
  assert.equal((await dispatch("/api/assistant", "maintainer", contextQuestion)).status, 403);
  assert.equal((await dispatch(context7Path, "maintainer", { enabled: true })).status, 200);
  assert.deepEqual(await (await dispatch(docsMcpPath, "maintainer")).json(), { enabled: false });
  assert.equal(
    (
      await dispatch("/api/assistant", "maintainer", {
        ...contextQuestion,
        libraryId: "https://example.test",
      })
    ).status,
    400,
  );
  const contextAnswer = await dispatch("/api/assistant", "maintainer", contextQuestion);
  assert.equal(contextAnswer.status, 200);
  assert.equal((await contextAnswer.json()).answer, "React-ohje löytyi.");
  assert.equal((await dispatch(context7Path, "maintainer", { enabled: false })).status, 200);
  const exportedRecipe = await dispatch("/api/skill?slug=paging-fixture-26", "reader");
  assert.equal(exportedRecipe.status, 200);
  assert.match(await exportedRecipe.text(), /name: paging-fixture-26[\s\S]*Unselected text\./u);
  assert.equal(
    (await dispatch("/api/skill?slug=paging-fixture-0&revision=" + sampleIds[0], "author")).status,
    404,
  );
  const limited = await dispatch("/api/assistant", "maintainer", { question: "Try again." });
  assert.equal(limited.status, 429);
  assert.doesNotMatch(await limited.text(), /Private provider failure/);
  const activeSecretsDb = await runtime.getD1Database("DB");
  await activeSecretsDb
    .prepare("UPDATE openai_settings SET credential = ? WHERE id = 1")
    .bind(row.credential.slice(0, -2) + (row.credential.endsWith("ff") ? "00" : "ff"))
    .run();
  assert.equal((await dispatch("/api/assistant/models", "maintainer")).status, 503);
  assert.equal(inferenceCalls, 5);
  await activeSecretsDb
    .prepare("UPDATE openai_settings SET credential = ? WHERE id = 1")
    .bind(row.credential)
    .run();
  await runtime.dispose();
  runtime = worker({
    ...provider,
    bindings: {
      SETTINGS_ENCRYPTION_KEY: rotatedDeploymentKey,
      MAINTAINER_EMAILS: "different@example.test",
    },
  });
  assert.equal((await dispatch("/api/settings/openai/remove-key", "maintainer", {})).status, 403);
  await runtime.dispose();
  runtime = worker({ ...provider, bindings: { SETTINGS_ENCRYPTION_KEY: rotatedDeploymentKey } });
  assert.equal((await dispatch("/api/assistant/models", "maintainer")).status, 503);
  key = "replacement-provider-credential";
  assert.equal(
    (await dispatch("/api/settings/openai", "maintainer", { model, apiKey: key })).status,
    200,
  );
  assert.equal((await dispatch("/api/assistant/models", "maintainer")).status, 200);
  const removedKey = await dispatch("/api/settings/openai/remove-key", "maintainer", {});
  assert.deepEqual(await removedKey.json(), {
    model,
    hasCredential: false,
    encryptionAvailable: true,
    configured: false,
  });
  assert.equal((await dispatch("/api/assistant/models", "maintainer")).status, 503);
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
