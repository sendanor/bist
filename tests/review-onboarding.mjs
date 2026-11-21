import assert from "node:assert/strict";
import { defaultReviewPolicy } from "../src/quality/review-defaults.ts";

/**
 * Exercise first-time connection setup, key removal and upgrades in the disposable Worker DB.
 * @param dispatch Request helper connected to the local Miniflare instance.
 * @param db Temporary D1 database owned exclusively by the integration suite.
 * @param key Synthetic credential accepted by the suite's provider fixture.
 */
export async function verifyReviewOnboarding(dispatch, db, key) {
  const path = "/api/settings/llm-review";
  const connection = "/api/settings/openai";
  const modelStep = { model: "gpt-6.2-sol" };
  const keyStep = { apiKey: key };
  const offered = { ...defaultReviewPolicy, enabled: false };
  /** Read the policy exposed by the Settings form. */
  async function readPolicy() {
    const response = await dispatch(path, "maintainer");
    assert.equal(response.status, 200);
    return response.json();
  }
  for (const [first, second] of [
    [keyStep, modelStep],
    [modelStep, keyStep],
  ]) {
    await db.batch([
      db.prepare("DELETE FROM llm_review_settings"),
      db.prepare("DELETE FROM openai_settings"),
      db.prepare("DELETE FROM openai_rate_limits WHERE action = 'settings'"),
    ]);
    assert.deepEqual(await readPolicy(), offered);
    assert.equal((await dispatch(connection, "maintainer", first)).status, 200);
    assert.deepEqual(await readPolicy(), offered);
    assert.equal((await dispatch(connection, "maintainer", second)).status, 200);
    assert.deepEqual(await readPolicy(), defaultReviewPolicy);
  }
  const recipe = {
    slug: "onboarding-readme-fixture",
    title: "Readiness check",
    summary: "Document a first setup step.",
    files: { documentation: "# Setup\n\nRun the unspecified command to finish setup." },
  };
  const warning = await dispatch("/api/submit", "author", recipe);
  assert.equal(warning.status, 409);
  assert.equal((await warning.json()).code, "llm_warning");
  assert.equal((await dispatch(connection + "/remove-key", "maintainer", {})).status, 200);
  assert.deepEqual(await readPolicy(), defaultReviewPolicy);
  assert.equal((await dispatch("/api/submit", "author", recipe)).status, 503);

  const customized = {
    ...offered,
    rules: { source: { mode: "off", instruction: "Handled by the local build." } },
  };
  assert.equal((await dispatch(path, "maintainer", customized)).status, 200);
  assert.equal((await dispatch(connection, "maintainer", keyStep)).status, 200);
  assert.deepEqual(await readPolicy(), customized);

  // Simulate an upgraded installation that used the Assistant before review defaults existed.
  await db.prepare("DELETE FROM llm_review_settings").run();
  assert.equal((await dispatch(connection, "maintainer", { model: "fixture-model" })).status, 200);
  assert.deepEqual(await readPolicy(), offered);
}
