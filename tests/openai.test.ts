import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchOpenAiModelCatalog,
  requestToolItems,
  runOpenAiAssistant,
  runOpenAiReview,
} from "../src/openai.ts";
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

test("model discovery validates the upstream response and sorts unique usable IDs", async () => {
  for (const reply of [
    Response.json({}, { status: 500 }),
    Response.json({ data: {} }),
    new Response("invalid response", { headers: { "content-type": "application/json" } }),
  ]) {
    assert.deepEqual(await fetchOpenAiModelCatalog(config.key, async () => reply), {
      status: "unavailable",
    });
  }
  const result = await fetchOpenAiModelCatalog(config.key, async () =>
    Response.json({
      data: [{ id: "zeta" }, null, { id: "alpha" }, { id: "zeta" }, { id: "not a model" }],
    }),
  );
  assert.deepEqual(result, { status: "ready", models: ["alpha", "zeta"] });
});

test("assistant rejects oversized requests and distinguishes timed-out or malformed provider replies", async () => {
  const turn = { instructions: "Fixture", input: [], tools: [] };
  const live = new AbortController();
  await assert.rejects(
    requestToolItems(
      config,
      turn,
      live.signal,
      async () => assert.fail("oversized request sent"),
      1,
    ),
    { status: 502 },
  );
  for (const reply of [
    Response.json({ detail: "internal upstream detail" }, { status: 403 }),
    Response.json({ status: "incomplete", output: [] }),
    Response.json({ status: "completed", output: [null] }),
    Response.json({ status: "completed", output: Array.from({ length: 21 }, () => ({})) }),
  ]) {
    await assert.rejects(
      requestToolItems(config, turn, live.signal, async () => reply),
      { status: 502 },
    );
  }
  const timeout = AbortSignal.abort(new DOMException("Fixture timed out", "TimeoutError"));
  await assert.rejects(
    requestToolItems(config, turn, timeout, async (_url, request) => {
      request?.signal?.throwIfAborted();
      return assert.fail("aborted request went through");
    }),
    { status: 504, message: "The OpenAI request timed out." },
  );
});

test("assistant returns provider refusals and rejects an empty answer", async () => {
  /** Fail if a plain provider message unexpectedly triggers a recipe lookup. */
  const lookup = async () => assert.fail("provider did not request a lookup");
  const refusal = await runOpenAiAssistant(config, "Example", lookup, async () =>
    Response.json({
      status: "completed",
      output: [
        { type: "reasoning" },
        { type: "message", content: [{ type: "refusal", refusal: "Cannot answer." }] },
      ],
    }),
  );
  assert.equal(refusal, "Cannot answer.");
  await assert.rejects(
    runOpenAiAssistant(config, "Example", lookup, async () =>
      Response.json({
        status: "completed",
        output: [{ type: "message", content: [] }],
      }),
    ),
    { status: 502 },
  );
});

test("review rejects missing findings, empty reasons and unapproved lookups", async () => {
  const item = { part: "documentation", instruction: "Explain the usage.", content: "# Usage" };
  const call = {
    type: "function_call",
    name: "search_openai_docs",
    call_id: "reference",
    arguments: "{}",
  };
  for (const results of [
    [],
    [{ part: "source", acceptable: true, reason: "" }],
    [{ part: "documentation", acceptable: false, reason: " " }],
  ]) {
    const output = [
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({ results }) }] },
    ];
    await assert.rejects(
      runOpenAiReview(config, [item], async () => Response.json({ status: "completed", output })),
      { status: 502 },
    );
  }
  await assert.rejects(
    runOpenAiReview(config, [item], async () =>
      Response.json({
        status: "completed",
        output: [call],
      }),
    ),
    { status: 502 },
  );
  let lookups = 0;
  await assert.rejects(
    runOpenAiReview(
      {
        ...config,
        /** Record each reference lookup to verify the per-review limit. */
        searchDocs: async () => {
          lookups++;
          return { hits: [] };
        },
      },
      [item],
      async () => Response.json({ status: "completed", output: [call] }),
    ),
    { status: 502 },
  );
  assert.equal(lookups, 1);
});
