import assert from "node:assert/strict";

/**
 * Check that a request fails with the expected status and a usable JSON diagnostic.
 * @param dispatch Request transport for the disposable Worker.
 * @param path API route to invoke.
 * @param user Synthetic caller identity.
 * @param data Optional POST body.
 * @param status Expected HTTP error status.
 * @param detail Pattern for the exposed diagnostic.
 */
async function expectError(dispatch, path, user, data, status, detail) {
  const response = await dispatch(path, user, data);
  assert.equal(response.status, status, path);
  assert.match((await response.json()).error, detail, path);
}

/**
 * Verify protocol negotiation, error correlation and public asset delivery.
 * @param dispatch Request transport against the routed Worker.
 */
async function verifyProtocol(dispatch) {
  /**
   * Send an MCP JSON-RPC request with a recognizable correlation ID.
   * @param method Protocol operation to invoke.
   * @param params Optional RPC parameters.
   * @param user Optional synthetic signed-in identity.
   */
  const rpc = (method, params, user = null) =>
    dispatch("/mcp", user, { jsonrpc: "2.0", id: "fixture-rpc", method, params });
  const discover = await (await rpc("server/discover")).json();
  assert.equal(discover.id, "fixture-rpc");
  assert.ok(discover.result.supportedVersions.length);
  const bareInitialize = await dispatch("/mcp", null, { jsonrpc: "2.0", method: "initialize" });
  const initialized = await bareInitialize.json();
  assert.equal(initialized.id, null);
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  for (const [offered, expected] of [
    ["2025-11-25", "2025-11-25"],
    ["unknown", "2025-06-18"],
  ]) {
    const result = await (await rpc("initialize", { protocolVersion: offered })).json();
    assert.equal(result.result.protocolVersion, expected);
  }
  assert.equal((await rpc("notifications/initialized")).status, 202);
  assert.deepEqual(await (await rpc("ping")).json(), {
    jsonrpc: "2.0",
    id: "fixture-rpc",
    result: {},
  });
  for (const [method, params, code] of [
    [null, {}, -32600],
    ["unknown/method", {}, -32601],
    ["tools/call", { name: "unknown_tool" }, -32602],
    ["tools/call", { name: 1 }, -32602],
  ]) {
    const result = await (await rpc(method, params, "author")).json();
    assert.equal(result.id, "fixture-rpc");
    assert.equal(result.error.code, code);
  }
  for (const [params, user, pattern] of [
    [null, "author", /Expected a JSON object/u],
    [{ name: "search_recipes" }, null, /Sign in/u],
    [{ name: "search_recipes", arguments: [] }, "author", /Expected a JSON object/u],
  ]) {
    const { result } = await (await rpc("tools/call", params, user)).json();
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, pattern);
  }
  const css = await dispatch("/styles.css", null);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /^text\/css/u);
  assert.match(await css.text(), /\.recipe-part/u);
  assert.equal((await dispatch("/api/mine", "author")).status, 200);
  const withoutArguments = await rpc("tools/call", { name: "search_recipes" }, "author");
  assert.equal(withoutArguments.status, 200);
  const { result } = await withoutArguments.json();
  assert.equal(result.isError, undefined);
  assert.ok(Array.isArray(JSON.parse(result.content[0].text).items));
  await expectError(dispatch, "/api/unknown", "author", undefined, 404, /Route not found/u);
  await expectError(dispatch, "/api/unknown", "author", {}, 404, /Route not found/u);
}

/**
 * Exercise invalid settings and conversation requests before any provider call is needed.
 * @param dispatch Request transport against the routed Worker.
 */
async function verifySettingsValidation(dispatch) {
  for (const [path, input, detail] of [
    ["/api/settings/openai", {}, /Enter an OpenAI API key or choose a model/u],
    ["/api/settings/openai", { model: "invalid model" }, /valid OpenAI model identifier/u],
    ["/api/settings/openai", { apiKey: "!" }, /valid OpenAI API key/u],
    ["/api/settings/openai", { apiKey: 1234 }, /valid OpenAI API key/u],
    ["/api/settings/llm-review", { enabled: true, rules: [] }, /review mode and rules/u],
    [
      "/api/settings/llm-review",
      { enabled: true, rules: { source: { mode: "maybe" } } },
      /Off, Warn, or Block/u,
    ],
    [
      "/api/settings/llm-review",
      { enabled: false, rules: {}, referenceLibraryId: "/fixture/ui" },
      /reference query and an exact Context7 library ID/u,
    ],
    [
      "/api/settings/llm-review",
      { enabled: false, rules: {}, model: "gpt-6.2-sol", reasoningEffort: "impossible" },
      /supported reasoning effort/u,
    ],
    [
      "/api/settings/mcp/context7",
      { enabled: "false" },
      /enable the documentation MCP connection/u,
    ],
    ["/api/assistant", { question: "Help", history: {} }, /at most eight previous messages/u],
    [
      "/api/assistant",
      {
        question: "Help",
        history: Array.from({ length: 8 }, () => ({ role: "user", content: "☃".repeat(600) })),
      },
      /Conversation history is too large/u,
    ],
  ]) {
    await expectError(dispatch, path, "maintainer", input, 400, detail);
  }
  for (const [input, detail] of [
    [{ prettier: [] }, /Expected a settings object/u],
    [{ unknown: true }, /Unsupported code policy field/u],
    [{ prettier: { fixtureStyle: true } }, /Unsupported Prettier setting/u],
    [{ eslint: { "fixture-unknown-rule": "warn" } }, /Unknown bundled ESLint rule/u],
    [{ eslint: { eqeqeq: "optional" } }, /Invalid severity/u],
    [
      { eslint: { "react-hooks/rules-of-hooks": ["error", {}] } },
      /Invalid options for react-hooks\/rules-of-hooks/u,
    ],
    [{ globals: { fixtureValue: "optional" } }, /Invalid ESLint global/u],
    [{ quality: { warningsAsErrors: "yes" } }, /warningsAsErrors must be a boolean/u],
    [{ quality: { duplicateCode: "maybe" } }, /Invalid severity for duplicateCode/u],
  ]) {
    await expectError(
      dispatch,
      "/api/settings",
      "maintainer",
      { prettier: {}, eslint: {}, ...input },
      400,
      detail,
    );
  }
}

/**
 * Reject malformed snapshots and produce bounded, file-specific validation errors.
 * @param dispatch Authenticated transport to the disposable Worker.
 */
async function verifyRecipeValidation(dispatch) {
  const recipe = {
    slug: "validation-edge-fixture",
    title: "Validation fixture",
    summary: "Check submitted part limits and diagnostics.",
    files: { documentation: "Example prose." },
  };
  const settings = await (await dispatch("/api/settings", "maintainer")).json();
  for (const [overrides, detail] of [
    [{ slug: "Invalid Slug" }, /lowercase hyphenated slug/u],
    [{ allowDuplicates: "yes" }, /allowDuplicates must be a boolean/u],
    [{ tags: "fixture" }, /up to eight tags/u],
    [{ files: [] }, /Provide a files object/u],
    [{ files: { documentation: "ä".repeat(6_001) } }, /at most 12 KB/u],
    [{ fileNames: [] }, /Provide a fileNames object/u],
    [{ fileNames: { source: "index.ts" } }, /parts included in this recipe/u],
    [{ files: { styles: ".recipe { color red; }" } }, /styles:1:\d+ .*\(css-syntax\)/u],
    [{ files: { source: "const value = ;" } }, /source:1:\d+ .*\(parse\)/u],
    [{ files: { source: "// prettier-ignore\nexport const value=3;" } }, /prettier-ignore/u],
    [
      { files: { styles: ".recipe{color:red}\n".repeat(480) } },
      /Styles exceed 12 KB after formatting/u,
    ],
    [
      { files: { source: "export const wide = [" + "1,".repeat(4_500) + "];" } },
      /source exceeds 12 KB after formatting/u,
    ],
  ]) {
    await expectError(dispatch, "/api/submit", "author", { ...recipe, ...overrides }, 400, detail);
  }
  const strict = {
    ...settings.policy,
    quality: { ...settings.policy.quality, cssClasses: "error" },
  };
  assert.equal((await dispatch("/api/settings", "maintainer", strict)).status, 200);
  try {
    const styles = Array.from(
      { length: 24 },
      (_, index) => ".Invalid-" + index + "{color:red}",
    ).join("\n");
    await expectError(
      dispatch,
      "/api/submit",
      "author",
      { ...recipe, files: { styles } },
      400,
      /Plus 4 more violations/u,
    );
  } finally {
    assert.equal((await dispatch("/api/settings", "maintainer", settings.policy)).status, 200);
  }
  await expectError(
    dispatch,
    "/api/search?query=" + encodeURIComponent("one ".repeat(13)),
    "reader",
    undefined,
    400,
    /up to 12 terms/u,
  );
  await expectError(
    dispatch,
    "/api/search?cursor=next",
    "reader",
    undefined,
    400,
    /Invalid page cursor/u,
  );
  const search = new URLSearchParams(
    Array.from({ length: 9 }, (_, index) => ["tag", "tag-" + index]),
  );
  await expectError(
    dispatch,
    "/api/search?" + search,
    "reader",
    undefined,
    400,
    /up to eight tags/u,
  );
  const tags = search.getAll("tag").slice(0, 8);
  for (const tag of [tags[0].toUpperCase(), "ninth-distinct-tag"]) {
    const response = await dispatch("/mcp", "reader", {
      jsonrpc: "2.0",
      id: "tag-boundary",
      method: "tools/call",
      params: { name: "search_recipes", arguments: { tags, tag } },
    });
    assert.equal(response.status, 200);
    const { result } = await response.json();
    if (tag === "ninth-distinct-tag") {
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /up to eight tags/u);
    } else {
      assert.equal(result.isError, undefined);
      assert.deepEqual(JSON.parse(result.content[0].text).items, []);
    }
  }
  await expectError(
    dispatch,
    "/api/recipe?slug=validation-edge-fixture&parts=oops",
    "author",
    undefined,
    400,
    /Select supported file parts/u,
  );
}

/**
 * Distinguish module boundaries from type diagnostics when maintainers adjust lint rules.
 * @param dispatch Authenticated transport to the disposable Worker.
 */
async function verifyVirtualModules(dispatch) {
  const settingsPath = "/api/settings";
  const { policy } = await (await dispatch(settingsPath, "maintainer")).json();
  const recipe = {
    slug: "module-diagnostic-fixture",
    title: "Virtual module boundaries",
    summary: "Check that the recipe compiler reports unavailable modules in the importing file.",
  };
  await expectError(
    dispatch,
    "/api/submit",
    "author",
    {
      ...recipe,
      files: {
        interface: 'export type Shared = import("./source.js").Result;',
        source: "export type Result = string;",
      },
    },
    400,
    /interface:1:\d+ .*public interface must stand on its own/u,
  );
  const compilerOnly = {
    ...policy,
    eslint: { ...policy.eslint, "quality/recipe-imports": "off" },
    quality: { ...policy.quality, typeCheck: "error" },
  };
  assert.equal((await dispatch(settingsPath, "maintainer", compilerOnly)).status, 200);
  try {
    await expectError(
      dispatch,
      "/api/submit",
      "author",
      {
        ...recipe,
        files: {
          source: '/// <reference no-default-lib="true" />\nexport const value = 1;',
        },
      },
      400,
      /^recipe .*Cannot find global type.*\(TS2318\)/u,
    );
    for (const specifier of ["./interface.js", "./absent-module.js"]) {
      const response = await dispatch("/api/submit", "author", {
        ...recipe,
        files: { source: `export type RecipeValue = import("${specifier}").Shared;` },
      });
      assert.equal(response.status, 400);
      const { error } = await response.json();
      assert.match(error, /^source:1:\d+ .*TS2307/u);
      assert.ok(error.includes(specifier));
    }
    for (const [typescript, javascript] of [
      ["mts", "mjs"],
      ["cts", "cjs"],
    ]) {
      const response = await dispatch("/api/submit", "author", {
        ...recipe,
        files: {
          interface: "export type RecipeCount = number;",
          source: `import type { RecipeCount } from "./recipe-contract.${javascript}";\nexport const count: RecipeCount = "wrong";`,
        },
        fileNames: {
          source: "recipe-entry." + typescript,
          interface: "recipe-contract.d." + typescript,
        },
      });
      assert.equal(response.status, 400);
      const { error } = await response.json();
      assert.match(error, /^source:2:\d+ .*TS2322/u);
      assert.doesNotMatch(error, /TS2307/u);
    }
    await expectError(
      dispatch,
      "/api/submit",
      "author",
      {
        ...recipe,
        files: {
          source: "export const count = 4;",
          tests:
            'import { count } from "./recipe-value.d.js";\nexport const shown: string = count;',
        },
        fileNames: { source: "recipe-value.d.js" },
      },
      400,
      /^tests:2:\d+ .*TS2322/u,
    );
  } finally {
    assert.equal((await dispatch(settingsPath, "maintainer", policy)).status, 200);
  }
}

/**
 * Verify that invalid stored values surface a controlled error and can be read after repair.
 * @param dispatch Request transport to the disposable Worker.
 * @param db Local D1 binding containing only integration fixtures.
 */
async function verifyStoredData(dispatch, db) {
  const recipe = {
    slug: "stored-data-fixture",
    title: "Stored recipe validation",
    summary: "Verify the API response when legacy storage contains an invalid value.",
    files: {
      documentation: "# Validate stored recipe data\n\nRestore valid values before reopening.",
    },
  };
  const created = await dispatch("/api/submit", "author", recipe);
  assert.equal(created.status, 201);
  const saved = await created.json();
  const target = { slug: recipe.slug, revision: saved.id, editVersion: saved.editVersion };
  const detail = "/api/recipe?" + new URLSearchParams(target);
  const comment = await dispatch(
    "/api/comment",
    "maintainer",
    { ...target, part: "documentation", line: null, body: "Check the reviewer name fallback." },
    { "oai-authenticated-user-full-name": "%GG" },
  );
  assert.equal(comment.status, 201);
  assert.equal((await comment.json()).authorName, "maintainer");
  const withoutName = await dispatch(
    "/api/comment",
    "maintainer",
    { ...target, part: "documentation", line: null, body: "Check an empty reviewer name." },
    { "oai-authenticated-user-full-name": "%E2%80%8B" },
  );
  assert.equal(withoutName.status, 201);
  assert.equal((await withoutName.json()).authorName, null);
  const anonymousReviewer = await dispatch(detail + "&reviewComments=1", "maintainer", undefined, {
    "oai-authenticated-user-full-name": "%E2%80%8B",
  });
  assert.equal(anonymousReviewer.status, 200);
  const { review } = await anonymousReviewer.json();
  assert.deepEqual(
    review.comments.map(({ authorName }) => authorName),
    ["maintainer", null],
  );
  await db
    .prepare(
      "CREATE TRIGGER skip_test_comment BEFORE INSERT ON revision_comments BEGIN SELECT RAISE(IGNORE); END",
    )
    .run();
  try {
    await expectError(
      dispatch,
      "/api/comment",
      "maintainer",
      {
        ...target,
        part: "documentation",
        line: null,
        body: "This write must not be acknowledged.",
      },
      409,
      /Reload it before adding a comment/u,
    );
  } finally {
    await db.prepare("DROP TRIGGER skip_test_comment").run();
  }
  const count = await db
    .prepare("SELECT count(*) AS total FROM revision_comments WHERE revision = ?")
    .bind(saved.id)
    .first();
  assert.equal(count.total, 2);
  const anonymousName = await dispatch("/api/session", "identity-fixture", undefined, {
    "oai-authenticated-user-email": "",
    "oai-authenticated-user-full-name": " ",
  });
  assert.equal(anonymousName.status, 200);
  assert.deepEqual(await anonymousName.json(), { maintainer: false });
  await expectError(
    dispatch,
    "/api/recipe/file",
    "author",
    { ...target, part: "documentation", content: "   " },
    400,
    /Enter file contents/u,
  );
  for (const [action, detail] of [
    ["request_changes", /Explain the requested changes/u],
    ["quarantine", /Give a quarantine reason/u],
    ["request_removal", /Give a removal reason/u],
    ["unknown", /Unknown action/u],
  ]) {
    await expectError(dispatch, "/api/action", "maintainer", { ...target, action }, 400, detail);
  }
  const nonexistent = "00000000-0000-4000-8000-000000000003";
  await expectError(
    dispatch,
    "/api/comment",
    "maintainer",
    { ...target, revision: nonexistent, part: "documentation", body: "Review comment" },
    404,
    /Recipe revision not found/u,
  );
  await expectError(
    dispatch,
    "/api/submit",
    "author",
    { ...recipe, base: nonexistent, files: { documentation: "Missing base validation." } },
    409,
    /Choose an accessible base revision/u,
  );
  const record = await db
    .prepare("SELECT tags, files, llm_warnings FROM revisions WHERE id = ?")
    .bind(saved.id)
    .first();
  /**
   * Update only the disposable fixture and preserve the untouched fields from its original row.
   * @param fields Known synthetic values for each storage field being exercised.
   */
  const overwrite = (fields) =>
    db
      .prepare("UPDATE revisions SET tags = ?, files = ?, llm_warnings = ? WHERE id = ?")
      .bind(fields.tags, fields.files, fields.llm_warnings, saved.id)
      .run();
  try {
    for (const corrupt of [{ tags: "{}" }, { files: "[]" }, { files: '{"documentation":true}' }]) {
      await overwrite({ ...record, ...corrupt });
      const response = await dispatch(detail, "author");
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "The operation failed. Please retry." });
    }
    await overwrite({ ...record, llm_warnings: "{}" });
    const sanitized = await dispatch(detail, "author");
    assert.equal(sanitized.status, 200);
    assert.deepEqual((await sanitized.json()).llmWarnings, []);
  } finally {
    await overwrite(record);
  }
  assert.equal(
    (await (await dispatch(detail, "author")).json()).files.documentation,
    recipe.files.documentation + "\n",
  );
  const codePolicy = db.prepare("SELECT config FROM code_policy WHERE id = 1");
  const savedCodePolicy = await codePolicy.first();
  assert.ok(savedCodePolicy);
  try {
    await db
      .prepare("UPDATE code_policy SET config = ? WHERE id = 1")
      .bind(JSON.stringify({ prettier: { printWidth: 92 } }))
      .run();
    const legacy = await dispatch("/api/settings", "maintainer");
    assert.equal(legacy.status, 200);
    const { policy } = await legacy.json();
    assert.equal(policy.prettier.printWidth, 92);
    assert.equal(policy.eslint["quality/documentation"], "error");
    await db.prepare("UPDATE code_policy SET config = '[]' WHERE id = 1").run();
    const invalid = await dispatch("/api/settings", "maintainer");
    assert.equal(invalid.status, 500);
    assert.deepEqual(await invalid.json(), { error: "The operation failed. Please retry." });
  } finally {
    await db
      .prepare("UPDATE code_policy SET config = ? WHERE id = 1")
      .bind(savedCodePolicy.config)
      .run();
  }
  assert.equal((await dispatch("/api/settings", "maintainer")).status, 200);
  const storedPolicy = await db
    .prepare("SELECT policy FROM llm_review_settings WHERE id = 1")
    .first();
  try {
    await db
      .prepare(
        "INSERT INTO llm_review_settings (id, policy) VALUES (1, '[]') ON CONFLICT(id) DO UPDATE SET policy = excluded.policy",
      )
      .run();
    await expectError(
      dispatch,
      "/api/settings/llm-review",
      "maintainer",
      undefined,
      503,
      /saved LLM review policy is invalid/u,
    );
  } finally {
    if (storedPolicy) {
      await db
        .prepare("UPDATE llm_review_settings SET policy = ? WHERE id = 1")
        .bind(storedPolicy.policy)
        .run();
    } else {
      await db.prepare("DELETE FROM llm_review_settings WHERE id = 1").run();
    }
  }
}

/**
 * Check that invalid or unavailable provider storage fails without starting inference.
 * @param dispatch Authenticated transport for the local Worker.
 * @param db Disposable D1 database with a configured synthetic provider.
 */
async function verifyProviderStorage(dispatch, db) {
  const read = db.prepare("SELECT model FROM openai_settings WHERE id = 1");
  const { model } = await read.first();
  const save = db.prepare("UPDATE openai_settings SET model = ? WHERE id = 1");
  const actor = "provider-storage-fixture";
  const created = await dispatch("/api/submit", actor, {
    slug: actor,
    title: "Stored provider settings",
    summary: "Fail closed when a saved model identifier is invalid.",
    files: { documentation: "Explain how to recover an invalid model configuration." },
  });
  assert.equal(created.status, 201);
  const { id, editVersion } = await created.json();
  try {
    await save.bind("invalid model identifier").run();
    await expectError(
      dispatch,
      "/api/recipe/file/suggest",
      actor,
      {
        slug: actor,
        revision: id,
        editVersion,
        part: "documentation",
        content: "The working copy is only sent to a configured model.",
        instruction: "Clarify the second sentence.",
      },
      503,
      /Configure a valid OpenAI connection/u,
    );
  } finally {
    await save.bind(model).run();
  }
  await db.prepare("ALTER TABLE openai_settings RENAME TO unavailable_openai_settings").run();
  try {
    const failed = await dispatch("/api/settings/openai", "maintainer");
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), {
      error: "The OpenAI operation failed. Please retry.",
    });
  } finally {
    await db.prepare("ALTER TABLE unavailable_openai_settings RENAME TO openai_settings").run();
  }
  const restored = await (await dispatch("/api/settings/openai", "maintainer")).json();
  assert.equal(restored.model, model);
  assert.equal(restored.configured, true);
}

/**
 * Keep malformed saved tool and skill selections from expanding the assistant's permissions.
 * @param dispatch Authenticated transport for inspecting instance settings.
 * @param db Disposable local database with persisted MCP and skill selections.
 */
async function verifyStoredAddOnSelections(dispatch, db) {
  for (const [read, update, route, field] of [
    [
      "SELECT enabled_tools AS config FROM mcp_settings WHERE id = 1",
      "UPDATE mcp_settings SET enabled_tools = ? WHERE id = 1",
      "/api/settings/mcp",
      "enabledTools",
    ],
    [
      "SELECT enabled AS config FROM assistant_skill_settings WHERE id = 1",
      "UPDATE assistant_skill_settings SET enabled = ? WHERE id = 1",
      "/api/settings/mcp/skills",
      "enabled",
    ],
  ]) {
    const saved = await db.prepare(read).first();
    assert.ok(saved, route);
    const write = db.prepare(update);
    try {
      await write.bind("{}").run();
      const response = await dispatch(route, "maintainer");
      assert.equal(response.status, 200, route);
      assert.deepEqual((await response.json())[field], [], route);
    } finally {
      await write.bind(saved.config).run();
    }
  }
}

/**
 * Check that rate limits reject quota-exhausted requests before contacting a provider.
 * @param dispatch Request transport for the disposable Worker.
 * @param db Local D1 database containing synthetic quota state.
 */
async function verifyProviderQuotas(dispatch, db) {
  const catalogLimit = db.prepare(
    "SELECT window, hits FROM openai_rate_limits WHERE actor = 'maintainer' AND action = 'catalog'",
  );
  const existing = await catalogLimit.first();
  const reviewSettings = "/api/settings/llm-review";
  const policy = await (await dispatch(reviewSettings, "maintainer")).json();
  try {
    await db
      .prepare(
        "INSERT INTO openai_rate_limits (actor, action, window, hits) VALUES ('maintainer', 'catalog', unixepoch(), 12) ON CONFLICT(actor, action) DO UPDATE SET window = excluded.window, hits = excluded.hits",
      )
      .run();
    await expectError(
      dispatch,
      "/api/assistant/models",
      "maintainer",
      undefined,
      429,
      /Too many OpenAI requests/u,
    );
    assert.equal(
      (
        await dispatch(reviewSettings, "maintainer", {
          ...policy,
          enabled: true,
          model: "gpt-6.2-sol",
          rules: { documentation: { mode: "warn", instruction: "Describe the expected result." } },
        })
      ).status,
      200,
    );
    await db
      .prepare(
        "INSERT INTO openai_rate_limits (actor, action, window, hits) VALUES ('quota-fixture', 'review', unixepoch(), 6)",
      )
      .run();
    const response = await dispatch("/mcp", "quota-fixture", {
      jsonrpc: "2.0",
      id: "quota-check",
      method: "tools/call",
      params: {
        name: "submit_recipe",
        arguments: {
          slug: "review-quota-fixture",
          title: "Review queue",
          summary: "Verify that review quota prevents a provider call.",
          files: { documentation: "The fixture checks rate-limited review." },
        },
      },
    });
    assert.equal(response.status, 200);
    const { result } = await response.json();
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Too many LLM review requests/u);
    assert.equal(result.structuredContent, undefined);
    assert.equal(
      await db.prepare("SELECT id FROM revisions WHERE slug = 'review-quota-fixture'").first(),
      null,
    );
  } finally {
    assert.equal((await dispatch(reviewSettings, "maintainer", policy)).status, 200);
    if (existing) {
      await db
        .prepare(
          "UPDATE openai_rate_limits SET window = ?, hits = ? WHERE actor = 'maintainer' AND action = 'catalog'",
        )
        .bind(existing.window, existing.hits)
        .run();
    } else {
      await db
        .prepare("DELETE FROM openai_rate_limits WHERE actor = 'maintainer' AND action = 'catalog'")
        .run();
    }
  }
}

/**
 * Verify submissions retry after a bounded batch of legacy fingerprints is rebuilt.
 * @param dispatch Request transport to the disposable Worker.
 * @param db Local D1 binding populated with legacy fixtures for this check.
 */
async function verifyLegacyBatch(dispatch, db) {
  const slug = "legacy-batch-fixture";
  await db.batch([
    db.prepare("INSERT INTO recipes (slug, owner) VALUES (?, 'legacy-fixture')").bind(slug),
    ...Array.from({ length: 25 }, (_, index) =>
      db
        .prepare(
          "INSERT INTO revisions (id, slug, author, title, summary, tags, files, state, fingerprints_ready) VALUES (?, ?, 'legacy-fixture', 'Legacy fixture', 'Awaiting fingerprinting', '[]', ?, 'quarantined', 0)",
        )
        .bind(
          "10000000-0000-4000-8000-" + String(index).padStart(12, "0"),
          slug,
          JSON.stringify({ documentation: "Archived fixture " + index }),
        ),
    ),
  ]);
  const recipe = {
    slug: "legacy-batch-retry-fixture",
    title: "Retry after indexing",
    summary: "Verify normal submission resumes after batched indexing.",
    files: { documentation: "Wait until the archived fixtures have fingerprints." },
  };
  const remaining = db
    .prepare("SELECT count(*) AS total FROM revisions WHERE slug = ? AND fingerprints_ready = 0")
    .bind(slug);
  await expectError(dispatch, "/api/submit", "author", recipe, 503, /still being indexed/u);
  assert.equal((await remaining.first()).total, 1);
  assert.equal(
    await db.prepare("SELECT id FROM revisions WHERE slug = ?").bind(recipe.slug).first(),
    null,
  );
  assert.equal((await dispatch("/api/submit", "author", recipe)).status, 201);
  assert.equal((await remaining.first()).total, 0);
}

/**
 * Test the public Worker boundary, including invalid input and malformed stored fixture values.
 * @param dispatch Request transport bound to the local instance.
 * @param db Disposable Worker database containing synthetic test records.
 */
export async function verifyWorkerValidation(dispatch, db) {
  await verifyProtocol(dispatch);
  await verifySettingsValidation(dispatch);
  await verifyRecipeValidation(dispatch);
  await verifyVirtualModules(dispatch);
  await verifyStoredData(dispatch, db);
  await verifyProviderStorage(dispatch, db);
  await verifyStoredAddOnSelections(dispatch, db);
  await verifyProviderQuotas(dispatch, db);
  await verifyLegacyBatch(dispatch, db);
}
