import assert from "node:assert/strict";

const criterion = "Confirm the example against the React state documentation.";
export const unavailableReference = "Unavailable React state reference";
let beforeReviewResult;

/**
 * Advise on a fixture recipe only after reading the configured Context7 reference.
 * @param request Fixture Responses API request made by the Worker.
 */
export async function context7ReviewFixture(request) {
  if (!request.instructions.includes(criterion)) {
    return undefined;
  }
  assert.deepEqual(
    request.tools.map(({ name }) => name),
    ["query_context7_docs"],
  );
  assert.deepEqual(request.reasoning, { effort: "low" });
  const last = request.input.at(-1);
  if (last.role === "user") {
    return Response.json({
      status: "completed",
      output: [
        {
          type: "function_call",
          name: "query_context7_docs",
          arguments: "{}",
          call_id: "context7-review-reference",
        },
      ],
    });
  }
  assert.equal(last.call_id, "context7-review-reference");
  assert.deepEqual(JSON.parse(last.output), { excerpt: "React documentation excerpt" });
  const beforeResult = beforeReviewResult;
  beforeReviewResult = undefined;
  await beforeResult?.();
  const text = JSON.stringify({
    results: [{ part: "documentation", acceptable: true, reason: "" }],
  });
  return Response.json({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  });
}

/**
 * Require a live MCP lookup during submission and leave no revision when the reference fails.
 * @param dispatch HTTP transport for the local Worker with synthetic outbound services.
 * @param db Disposable D1 database used to inspect writes after failed submissions.
 */
export async function verifyContext7RecipeReview(dispatch, db) {
  const settings = "/api/settings/llm-review";
  const connection = "/api/settings/mcp/context7";
  const initialPolicy = await (await dispatch(settings, "maintainer")).json();
  const initialConnection = await (await dispatch(connection, "maintainer")).json();
  const actor = "context7-review-fixture";
  const recipe = {
    slug: "context7-review-fixture",
    title: "React state notes",
    summary: "Explain updates derived from the previous state.",
    files: { documentation: "Pass an updater when the next value depends on previous state." },
  };
  const policy = {
    enabled: true,
    model: "gpt-6.2-sol",
    reasoningEffort: "low",
    referenceQuery: "React state",
    referenceLibraryId: "/react/react",
    rules: { documentation: { mode: "warn", instruction: criterion } },
  };
  try {
    assert.equal((await dispatch(settings, "maintainer", policy)).status, 200);
    assert.equal((await dispatch(connection, "maintainer", { enabled: false })).status, 200);
    const disabled = await dispatch("/api/submit", actor, recipe);
    assert.equal(disabled.status, 503);
    assert.match((await disabled.json()).error, /Enable the MCP connection/u);
    assert.equal((await dispatch(connection, "maintainer", { enabled: true })).status, 200);
    const unavailable = await dispatch(settings, "maintainer", {
      ...policy,
      referenceQuery: unavailableReference,
    });
    assert.equal(unavailable.status, 200);
    assert.equal((await dispatch("/api/submit", actor, recipe)).status, 502);
    const revision = db.prepare("SELECT state FROM revisions WHERE slug = ?").bind(recipe.slug);
    assert.equal(await revision.first(), null);
    assert.equal((await dispatch(settings, "maintainer", policy)).status, 200);
    const created = await dispatch("/api/submit", actor, recipe);
    assert.equal(created.status, 201);
    assert.deepEqual(await revision.first(), { state: "pending" });
    const { id, editVersion } = await created.json();
    const replacement = { ...recipe, replace: id, editVersion, allowDuplicates: true };
    const winner = "Document the new updater before recording the fallback.";
    /** Commit a second replacement while the first awaits its review result. */
    beforeReviewResult = async () => {
      const result = await dispatch("/api/submit", actor, {
        ...replacement,
        files: { documentation: winner },
      });
      assert.equal(result.status, 200);
      assert.equal((await result.json()).editVersion, editVersion + 1);
    };
    const stale = await dispatch("/api/submit", actor, {
      ...replacement,
      files: { documentation: "Review this alternate updater example before saving it." },
    });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /This draft cannot be replaced/u);
    const query = new URLSearchParams({ slug: recipe.slug, revision: id });
    const current = await (await dispatch("/api/recipe?" + query, actor)).json();
    assert.equal(current.editVersion, editVersion + 1);
    assert.equal(current.files.documentation.trim(), winner);
  } finally {
    beforeReviewResult = undefined;
    assert.equal((await dispatch(settings, "maintainer", initialPolicy)).status, 200);
    assert.equal((await dispatch(connection, "maintainer", initialConnection)).status, 200);
  }
}
