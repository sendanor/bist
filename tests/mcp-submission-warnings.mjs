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
  assert.match(text, /explicitly approve/u);
  return reviewReceipt;
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
