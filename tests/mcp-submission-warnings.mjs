import assert from "node:assert/strict";

/** Documentation that satisfies the simulated provider's next-step rule. */
export const correctedReadme =
  "Run `npm test` from the repository root to execute the recipe checks.";

/**
 * Call the actual MCP submit tool, retaining error results for protocol assertions.
 * @param dispatch Local Worker's authenticated HTTP request helper.
 * @param submission Complete recipe snapshot and any acknowledgement supplied by the client.
 * @param actor Signed-in fixture user making the submission.
 */
export async function submitOverMcp(dispatch, submission, actor = "author") {
  const response = await dispatch("/mcp", actor, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "submit_recipe", arguments: submission },
  });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

/**
 * Require actionable agent instructions and reject the former human-confirmation gate.
 * @param advice The instructions advertised in discovery or returned after a submission.
 * @param action Expected primary action for this particular finding.
 */
export function assertAgentAdvice(advice, action) {
  assert.match(advice, action);
  assert.doesNotMatch(
    advice,
    /ask (?:whether|the user)|wait for their|only (?:with approval|after the user)|explicitly approve/iu,
  );
}

/**
 * Require every warning and its acknowledgement receipt in both MCP result formats.
 * @param dispatch Local Worker request helper.
 * @param submission Snapshot for which the server must pause before storage.
 * @param warnings Expected findings for this submitter.
 * @param actor Signed-in user who should receive the challenge.
 */
export async function expectMcpWarnings(dispatch, submission, warnings, actor = "author") {
  const result = await submitOverMcp(dispatch, submission, actor);
  assert.equal(result.isError, true);
  const { code, reviewReceipt } = result.structuredContent;
  assert.equal(code, "llm_warning");
  assert.deepEqual(result.structuredContent.warnings, warnings);
  assert.match(reviewReceipt, /^[a-f0-9-]{36}$/u);
  const text = result.content[0].text;
  for (const { part, reason } of warnings) {
    assert.ok(text.includes(part + ": " + reason));
  }
  assert.ok(text.includes(JSON.stringify({ reviewReceipt })));
  const { guidance } = result.structuredContent;
  assertAgentAdvice(guidance, /^Fix .*resubmit .*corrected snapshot/iu);
  assert.match(guidance, /omit reviewReceipt when correcting/iu);
  assert.match(guidance, /deliberately retain all remaining warnings/iu);
  assert.ok(text.includes(guidance));
  return reviewReceipt;
}

/**
 * Submit corrections to both advisory and blocking LLM findings using ordinary MCP calls.
 * @param dispatch Authenticated transport to the local Worker.
 * @param submission Recipe whose initial documentation fails the fixture's review rule.
 * @param policy Review configuration that accepts the corrected README.
 */
export async function verifyMcpRepairs(dispatch, submission, policy) {
  const settings = "/api/settings/llm-review";
  const previous = await (await dispatch(settings, "maintainer")).json();
  try {
    for (const mode of ["warn", "error"]) {
      const rule = { ...policy.rules.documentation, mode };
      assert.equal(
        (await dispatch(settings, "maintainer", { ...policy, rules: { documentation: rule } }))
          .status,
        200,
      );
      const actor = "repair-" + mode;
      const draft = { ...submission, slug: actor };
      const rejected = await submitOverMcp(dispatch, draft, actor);
      assert.equal(rejected.isError, true);
      assert.equal(Boolean(rejected.structuredContent.reviewReceipt), mode === "warn");
      assertAgentAdvice(rejected.structuredContent.guidance, /^Fix .*resubmit/iu);
      assert.ok(rejected.content[0].text.includes(rejected.structuredContent.guidance));
      const repaired = await submitOverMcp(
        dispatch,
        { ...draft, files: { documentation: correctedReadme } },
        actor,
      );
      assert.equal(repaired.isError, undefined, repaired.content[0].text);
      const revision = JSON.parse(repaired.content[0].text);
      const target = new URLSearchParams({ slug: draft.slug, revision: revision.id });
      const stored = await (await dispatch("/api/recipe?" + target, actor)).json();
      assert.equal(stored.state, "pending");
      assert.equal(stored.files.documentation.trimEnd(), correctedReadme);
      assert.equal(stored.llmWarnings, undefined);
    }
  } finally {
    assert.equal((await dispatch(settings, "maintainer", previous)).status, 200);
  }
}

/**
 * Verify that blind retries, expired receipts and altered snapshots cannot accept warnings.
 * @param dispatch Local Worker request helper.
 * @param db Disposable D1 binding, used to inspect writes and expire one acknowledgement.
 * @param submission Initial candidate that the simulated provider flagged for its documentation.
 * @param warnings Expected findings visible to the author.
 * @param receipt Receipt already issued by the shared HTTP submission pipeline.
 */
export async function verifyMcpAcknowledgement(dispatch, db, submission, warnings, receipt) {
  assert.equal(await expectMcpWarnings(dispatch, submission, warnings), receipt);
  const blind = { ...submission, allowDuplicates: true, reviewReceipt: crypto.randomUUID() };
  assert.equal(await expectMcpWarnings(dispatch, blind, warnings), receipt);
  const renamed = { ...submission, title: "A different proposal", reviewReceipt: receipt };
  assert.notEqual(await expectMcpWarnings(dispatch, renamed, warnings), receipt);
  const extraFile = { ...submission.files, instructions: "Keep this additional file." };
  const changed = { ...submission, files: extraFile, reviewReceipt: receipt };
  assert.notEqual(await expectMcpWarnings(dispatch, changed, warnings), receipt);
  await db
    .prepare("UPDATE llm_review_receipts SET expires = 0 WHERE receipt = ?")
    .bind(receipt)
    .run();
  const next = await expectMcpWarnings(
    dispatch,
    { ...submission, reviewReceipt: receipt },
    warnings,
  );
  assert.notEqual(next, receipt);
  assert.equal(
    await db.prepare("SELECT id FROM revisions WHERE slug = ?").bind(submission.slug).first(),
    null,
  );
  const accepted = await submitOverMcp(dispatch, { ...submission, reviewReceipt: next });
  assert.equal(accepted.isError, undefined, accepted.content[0].text);
  const revision = JSON.parse(accepted.content[0].text);
  assert.equal(revision.state, "pending");
  return revision;
}
