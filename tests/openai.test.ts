import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchOpenAiModelCatalog, runOpenAiAssistant } from "../src/openai.ts";
import { searchOpenAiDocs } from "../src/openai-docs-mcp.ts";

const config = { key: "test-provider-credential", model: "fixture-model" };

test("Docs MCP rechecks availability and discards oversized results", async () => {
  for (const enabledAfterInitialize of [false, true]) {
    let checks = 0;
    let searchCalls = 0;
    const hits = await searchOpenAiDocs(
      "Responses API",
      async () => ++checks === 1 || enabledAfterInitialize,
      async (url, init) => {
        assert.equal(url, "https://developers.openai.com/mcp");
        assert.equal(init?.redirect, "manual");
        const { method, id } = JSON.parse(String(init?.body));
        if (method === "initialize") {
          return new Response(
            "data: " +
              JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-11-25" } }) +
              "\r\n\r\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        searchCalls++;
        return new Response("x".repeat(32_001), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    );
    assert.equal(hits, null);
    assert.equal(searchCalls, Number(enabledAfterInitialize));
  }
});

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
