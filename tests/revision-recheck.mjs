import assert from "node:assert/strict";

/** Criterion identifying positive and mixed responses from the simulated review provider. */
export const recheckCriterion = "The file should name something to use.";

const exampleCriterion = "Include a worked example.";
const nextStep = { part: "documentation", reason: "Add one concrete next step." };
const workedExample = { part: "documentation", reason: "Show one worked example." };
let beforeFixtureReply;

/**
 * Review stored fixture files, allowing a draft edit to complete while the model is running.
 * @param body OpenAI Responses request from the Worker under test.
 */
export async function reviewStoredFixture(body) {
  const expected = { documentation: "Use this public recipe.", instructions: "Unselected text." };
  const files = JSON.parse(body.input[0].content);
  const results = files.map(({ part, content }) => {
    if (body.instructions.includes(exampleCriterion)) {
      assert.equal(content, "Review this new prose fixture for one exact next step.\n");
      assert.equal(part, "documentation");
      return { ...workedExample, acceptable: false };
    }
    assert.equal(content, expected[part]);
    return { part, acceptable: part === "documentation", reason: "Name something to use." };
  });
  if (beforeFixtureReply) {
    await beforeFixtureReply();
  }
  return Response.json({
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({ results }) }] },
    ],
  });
}

/**
 * Verify that rechecking a pending draft preserves an acknowledged warning on the same file.
 * @param dispatch Authenticated request helper for the local Worker.
 * @param tool Invoke a fixture MCP tool with a chosen identity.
 * @param submission Original submission payload, including the author's unchanged files.
 * @param draft Stored draft with the warning previously acknowledged by its author.
 */
export async function verifyDraftRecheck(dispatch, tool, submission, draft) {
  const settings = "/api/settings/llm-review";
  const policy = await (await dispatch(settings, "maintainer")).json();
  const rules = {
    documentation: { mode: "error", instruction: recheckCriterion + " " + exampleCriterion },
  };
  assert.equal((await dispatch(settings, "maintainer", { ...policy, rules })).status, 200);
  const target = { slug: draft.slug, revision: draft.id };
  const recheck = await dispatch("/api/review/recheck", "maintainer", {
    ...target,
    editVersion: draft.editVersion,
  });
  assert.equal(recheck.status, 200);
  const savedWarnings = [nextStep, workedExample];
  assert.deepEqual(await recheck.json(), {
    checkedParts: ["documentation"],
    warnings: [workedExample],
    savedWarnings,
  });
  assert.deepEqual(await tool("get_recipe", target, "maintainer"), {
    ...draft,
    llmWarnings: savedWarnings,
  });
  const edit = { ...submission, replace: draft.id, editVersion: draft.editVersion };
  const metadata = await dispatch("/api/submit", "author", { ...edit, title: "A new title" });
  assert.equal(metadata.status, 200);
  assert.deepEqual((await tool("get_recipe", target, "author")).llmWarnings, savedWarnings);
  const { editVersion } = await metadata.json();
  /** Remove the reviewed file after the next recheck reads it and before its findings arrive. */
  beforeFixtureReply = async () => {
    const replacement = await dispatch("/api/submit", "author", {
      ...edit,
      editVersion,
      files: { instructions: "Follow the revised recipe instructions." },
    });
    assert.equal(replacement.status, 200);
  };
  try {
    const stale = await dispatch("/api/review/recheck", "maintainer", { ...target, editVersion });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /revision changed/u);
  } finally {
    beforeFixtureReply = undefined;
  }
  assert.equal((await tool("get_recipe", target, "author")).llmWarnings, undefined);
  assert.equal((await dispatch(settings, "maintainer", policy)).status, 200);
}

/**
 * Exercise manual review against a published revision that predates the current policy.
 * @param dispatch Local authenticated Worker request helper.
 * @param target Slug and ID of the existing published integration fixture.
 * @param calls Read the number of actual Responses calls observed by the fixture.
 */
export async function verifyRevisionRecheck(dispatch, target, calls) {
  const route = "/api/review/recheck";
  const settings = "/api/settings/llm-review";
  const detail = "/api/recipe?" + new URLSearchParams({ ...target, reviewComments: "1" });
  const original = await (await dispatch(detail, "maintainer")).json();
  const selection = { ...target, editVersion: original.editVersion };
  const policy = await (await dispatch(settings, "maintainer")).json();
  assert.equal(original.state, "published");
  assert.equal(policy.rules.documentation.mode, "error");
  const start = calls();

  assert.equal((await dispatch(route, null, selection)).status, 401);
  assert.equal((await dispatch(route, "author", selection)).status, 403);
  assert.equal((await dispatch(route, "maintainer", target)).status, 400);
  assert.equal(
    (await dispatch(route, "maintainer", { ...selection, slug: "missing" })).status,
    404,
  );
  assert.equal(
    (await dispatch(route, "maintainer", { ...selection, editVersion: selection.editVersion + 1 }))
      .status,
    409,
  );
  assert.equal(calls(), start);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await dispatch(route, "maintainer", selection);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      checkedParts: ["documentation"],
      warnings: [nextStep],
      savedWarnings: [nextStep],
    });
    assert.equal(calls(), start + attempt);
  }

  const rule = { mode: "warn", instruction: recheckCriterion };
  /**
   * Replace the fixture's active criteria through the regular Settings route.
   * @param rules Active rules for the next check.
   */
  async function setRules(rules) {
    assert.equal((await dispatch(settings, "maintainer", { ...policy, rules })).status, 200);
  }
  await setRules({ documentation: rule, instructions: { ...rule, mode: "off" } });
  const clean = await dispatch(route, "maintainer", {
    ...selection,
    files: { documentation: "Forged." },
  });
  assert.deepEqual(await clean.json(), {
    checkedParts: ["documentation"],
    warnings: [],
    savedWarnings: [nextStep],
  });
  await setRules({ documentation: rule, instructions: { ...rule, mode: "error" } });
  const mixed = await dispatch(route, "maintainer", selection);
  assert.equal(mixed.status, 200);
  const instructions = { part: "instructions", reason: "Name something to use." };
  const savedWarnings = [nextStep, instructions];
  assert.deepEqual(await mixed.json(), {
    checkedParts: ["documentation", "instructions"],
    warnings: [instructions],
    savedWarnings,
  });
  await setRules({ tests: rule });
  const empty = await dispatch(route, "maintainer", selection);
  assert.deepEqual(await empty.json(), { checkedParts: [], warnings: [], savedWarnings });
  const missingReference = { ...policy, referenceQuery: "Responses streaming" };
  assert.equal((await dispatch(settings, "maintainer", missingReference)).status, 200);
  assert.equal((await dispatch(route, "maintainer", selection)).status, 503);
  assert.equal((await dispatch(settings, "maintainer", { ...policy, enabled: false })).status, 200);
  assert.equal((await dispatch(route, "maintainer", selection)).status, 409);
  assert.equal(calls(), start + 4);
  assert.deepEqual(await (await dispatch(detail, "maintainer")).json(), {
    ...original,
    llmWarnings: savedWarnings,
  });
  const author = await (await dispatch(detail, "author")).json();
  assert.deepEqual(author.llmWarnings, savedWarnings);
  const reader = await dispatch(detail, "reader");
  assert.equal(reader.status, 200);
  assert.equal((await reader.json()).llmWarnings, undefined);
}
