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
  await expectError(dispatch, "/api/unknown", "author", undefined, 404, /Route not found/u);
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
 * Test the public Worker boundary with invalid and oversized inputs before integration fixtures run.
 * @param dispatch Request transport bound to the local instance.
 */
export async function verifyWorkerValidation(dispatch) {
  await verifyProtocol(dispatch);
  await verifySettingsValidation(dispatch);
  await verifyRecipeValidation(dispatch);
}
