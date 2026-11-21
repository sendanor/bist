import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchOpenAiModelCatalog, runOpenAiAssistant } from "../src/openai.ts";

const config = { key: "test-provider-credential", model: "fixture-model" };

test("model catalog rejects redirects and returns safe authorization failures", async () => {
  const catalog = await fetchOpenAiModelCatalog(config.key, async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal(options?.redirect, "manual");
    assert.ok(options?.signal);
    return Response.json({ detail: "Upstream credentials detail." }, { status: 401 });
  });
  assert.deepEqual(catalog, { status: "unauthorized" });
});

test("assistant never executes unknown tools and stops after four requests", async () => {
  let requests = 0;
  await assert.rejects(
    runOpenAiAssistant(
      config,
      "Find a recipe.",
      async () => assert.fail("Unexpected lookup"),
      async (url, options) => {
        assert.equal(url, "https://api.openai.com/v1/responses");
        assert.equal(options?.redirect, "manual");
        const payload = JSON.parse(String(options?.body));
        if (requests > 0) {
          assert.match(payload.input.at(-1).output, /Unknown tool/);
        }
        requests++;
        return Response.json({
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: String(requests),
              name: "publish_recipe",
              arguments: '{"slug":"demo"}',
            },
          ],
        });
      },
    ),
    { status: 502 },
  );
  assert.equal(requests, 4);
});
