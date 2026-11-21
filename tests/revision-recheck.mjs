import assert from "node:assert/strict";

/** Criterion identifying positive and mixed responses from the simulated review provider. */
export const recheckCriterion = "The file should name something to use.";

/**
 * Review the known published fixture and verify that only stored content reached the model.
 * @param body OpenAI Responses request from the Worker under test.
 */
export function reviewStoredFixture(body) {
  const expected = { documentation: "Use this public recipe.", instructions: "Unselected text." };
  const files = JSON.parse(body.input[0].content);
  const results = files.map(({ part, content }) => {
    assert.equal(content, expected[part]);
    return { part, acceptable: part === "documentation", reason: "Name something to use." };
  });
  return Response.json({
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({ results }) }] },
    ],
  });
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
      warnings: [{ part: "documentation", reason: "Add one concrete next step." }],
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
  assert.deepEqual(await clean.json(), { checkedParts: ["documentation"], warnings: [] });
  await setRules({ documentation: rule, instructions: { ...rule, mode: "error" } });
  const mixed = await dispatch(route, "maintainer", selection);
  assert.equal(mixed.status, 200);
  assert.deepEqual(await mixed.json(), {
    checkedParts: ["documentation", "instructions"],
    warnings: [{ part: "instructions", reason: "Name something to use." }],
  });
  await setRules({ tests: rule });
  const empty = await dispatch(route, "maintainer", selection);
  assert.deepEqual(await empty.json(), { checkedParts: [], warnings: [] });
  const missingReference = { ...policy, referenceQuery: "Responses streaming" };
  assert.equal((await dispatch(settings, "maintainer", missingReference)).status, 200);
  assert.equal((await dispatch(route, "maintainer", selection)).status, 503);
  assert.equal((await dispatch(settings, "maintainer", { ...policy, enabled: false })).status, 200);
  assert.equal((await dispatch(route, "maintainer", selection)).status, 409);
  assert.equal(calls(), start + 4);
  assert.deepEqual(await (await dispatch(detail, "maintainer")).json(), original);
}
