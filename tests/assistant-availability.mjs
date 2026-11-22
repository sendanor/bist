import assert from "node:assert/strict";

const docsQuestion = "Can the assistant explain its unavailable streaming reference?";
const contextQuestion = "Can the assistant handle disabled skills and unavailable React docs?";
const docsQuery = "Fixture streaming reference unavailable";
const contextQuery = "Fixture React reference unavailable";
const libraryId = "/react/react";
const unavailable = { error: "Documentation search is unavailable." };
const answer = "I could not retrieve the requested documentation.";
const skillsPath = "/api/settings/mcp/skills";
let failedLookups = [];

/**
 * Fail only the selected documentation lookups and count actual transport calls.
 * @param params MCP parameters sent to the local upstream fixture.
 * @param context7 Whether the Worker chose Context7 for this lookup.
 */
export function unavailableAssistantReference(params, context7) {
  if (params.arguments.query !== (context7 ? contextQuery : docsQuery)) {
    return undefined;
  }
  assert.deepEqual(
    params,
    context7
      ? { name: "query-docs", arguments: { query: contextQuery, libraryId } }
      : { name: "search_openai_docs", arguments: { query: docsQuery, limit: 3 } },
  );
  failedLookups.push(params.name);
  return new Response(null, { status: 503 });
}

/**
 * Encode one synthetic provider tool request, or the final answer when no tool is supplied.
 * @param name Optional MCP or skill tool selected by the fixture model.
 * @param callId Identifier used to correlate the next model turn.
 * @param args Tool arguments to encode in the Responses format.
 */
function turn(name, callId, args = {}) {
  const item = name
    ? { type: "function_call", name, call_id: callId, arguments: JSON.stringify(args) }
    : { type: "message", content: [{ type: "output_text", text: answer }] };
  return Response.json({ status: "completed", output: [item] });
}

/**
 * Check the assistant's transcript after lookups fail or access changes mid-request.
 * @param request The stateless Responses request made by the Worker.
 * @param dispatch Authenticated test transport used to revoke a previously available skill.
 */
export async function assistantAvailabilityFixture(request, dispatch) {
  const question = request.input[0].content;
  if (question !== docsQuestion && question !== contextQuestion) {
    return undefined;
  }
  const last = request.input.at(-1);
  if (question === docsQuestion) {
    if (last.role === "user") {
      return turn("search_openai_docs", "docs-first");
    }
    assert.deepEqual(JSON.parse(last.output), unavailable);
    return last.call_id === "docs-first" ? turn("search_openai_docs", "docs-repeat") : turn();
  }
  if (last.role === "user") {
    const tool = request.tools.find(({ name }) => name === "load_task_skill");
    assert.deepEqual(tool.parameters.properties.id.enum, ["suomenkieli"]);
    assert.equal((await dispatch(skillsPath, "maintainer", { enabled: [] })).status, 200);
    return turn("load_task_skill", "revoked-skill", { id: "suomenkieli" });
  }
  if (last.call_id === "revoked-skill") {
    assert.deepEqual(JSON.parse(last.output), { error: "This skill is unavailable." });
    return turn("query_context7_docs", "context7-unavailable");
  }
  assert.deepEqual(JSON.parse(last.output), unavailable);
  return turn();
}

/**
 * Exercise both documentation providers through the Worker and restore instance preferences.
 * @param dispatch Authenticated transport to the disposable test Worker.
 */
export async function verifyAssistantAvailability(dispatch) {
  const docs = "/api/settings/mcp/openai-docs";
  const context7 = "/api/settings/mcp/context7";
  const reviewPath = "/api/settings/llm-review";
  const policy = await (await dispatch(reviewPath, "maintainer")).json();
  const initial = [];
  for (const route of [docs, context7, skillsPath]) {
    const response = await dispatch(route, "maintainer");
    assert.equal(response.status, 200);
    initial.push([route, await response.json()]);
  }
  failedLookups = [];
  try {
    assert.equal((await dispatch(docs, "maintainer", { enabled: true })).status, 200);
    assert.equal((await dispatch(context7, "maintainer", { enabled: true })).status, 200);
    assert.equal(
      (await dispatch(skillsPath, "maintainer", { enabled: ["suomenkieli"] })).status,
      200,
    );
    for (const request of [
      { question: docsQuestion, docsQuery },
      { question: contextQuestion, docsQuery: contextQuery, libraryId },
    ]) {
      const response = await dispatch("/api/assistant", "maintainer", request);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { answer, sources: [], docsSources: [] });
    }
    const configured = await dispatch(reviewPath, "maintainer", {
      ...policy,
      enabled: true,
      model: "gpt-6.2-sol",
      reasoningEffort: "low",
      referenceQuery: docsQuery,
      referenceLibraryId: "",
      rules: { documentation: { mode: "warn", instruction: "Require an exact next step." } },
    });
    assert.equal(configured.status, 200);
    const slug = "unavailable-review-reference";
    const submitted = await dispatch("/api/submit", slug, {
      slug,
      title: "Review with an unavailable reference",
      summary: "Do not accept a submission backed by a failed documentation lookup.",
      files: { documentation: "# Streaming\n\nRead the response events in order." },
    });
    assert.equal(submitted.status, 502);
    assert.match((await submitted.json()).error, /OpenAI could not complete the request/u);
    const drafts = await (await dispatch("/api/mine", slug)).json();
    assert.deepEqual(drafts.items, []);
    assert.deepEqual(failedLookups, ["search_openai_docs", "query-docs", "search_openai_docs"]);
  } finally {
    assert.equal((await dispatch(reviewPath, "maintainer", policy)).status, 200);
    for (const [route, settings] of initial) {
      assert.equal(
        (await dispatch(route, "maintainer", { enabled: settings.enabled })).status,
        200,
      );
    }
  }
}
