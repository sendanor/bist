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
    requestToolItems(config, turn, live.signal, async () => {
      throw new TypeError("Private provider transport diagnostics.");
    }),
    {
      status: 502,
      message: "OpenAI could not complete the request. Check the configured model and API access.",
    },
  );
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
        {
          type: "message",
          content: [
            { type: "output_text", text: null },
            { type: "refusal", refusal: "Cannot answer." },
          ],
        },
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
  let rounds = 0;
  const validFinding = {
    type: "message",
    content: [
      {
        type: "output_text",
        text: JSON.stringify({
          results: [{ part: "documentation", acceptable: true, reason: "" }],
        }),
      },
    ],
  };
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
      async () =>
        Response.json({
          status: "completed",
          output: ++rounds === 1 ? [call] : [validFinding, call],
        }),
    ),
    { status: 502 },
  );
  assert.equal(lookups, 1);
  assert.equal(rounds, 2);
});

test("review preserves rate limiting and rejects malformed or unfinished upstream responses", async () => {
  const items = [{ part: "documentation", instruction: "Review usage.", content: "# Usage" }];
  for (const [reply, status] of [
    [Response.json({ error: "private details" }, { status: 429 }), 429],
    [Response.json({ error: "private details" }, { status: 503 }), 502],
    [Response.json({ status: "incomplete", output: [] }), 502],
    [Response.json({ status: "completed", output: [null] }), 502],
  ] as const) {
    await assert.rejects(
      runOpenAiReview(config, items, async () => reply),
      {
        status,
        message:
          status === 429
            ? "OpenAI is rate limiting requests. Try again later."
            : "OpenAI could not complete the request. Check the configured model and API access.",
      },
    );
  }
});

test("review reports a provider deadline without disclosing any transport details", async (t) => {
  const timedOut = AbortSignal.abort(new DOMException("Private provider detail", "TimeoutError"));
  t.mock.method(AbortSignal, "timeout", () => timedOut);
  await assert.rejects(
    runOpenAiReview(
      config,
      [{ part: "documentation", instruction: "Review usage.", content: "# Usage" }],
      async (_url, options) => {
        assert.equal(options?.signal, timedOut);
        timedOut.throwIfAborted();
        return assert.fail("expired review reached provider");
      },
    ),
    { status: 504, message: "The OpenAI request timed out." },
  );
});

test("assistant rejects oversized tool arguments before executing a local lookup", async () => {
  let calls = 0;
  const answer = await runOpenAiAssistant(
    config,
    "Find a guide",
    async () => assert.fail("unvalidated lookup executed"),
    async (_url, options) => {
      const input = JSON.parse(String(options?.body)).input;
      calls++;
      if (calls === 1) {
        return Response.json({
          status: "completed",
          output: [
            {
              type: "function_call",
              name: "search_recipes",
              call_id: "oversized",
              arguments: JSON.stringify({ query: "x".repeat(1_001) }),
            },
          ],
        });
      }
      assert.deepEqual(JSON.parse(input.at(-1).output), { error: "Invalid tool arguments." });
      return Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Use shorter search terms." }],
          },
        ],
      });
    },
  );
  assert.equal(answer, "Use shorter search terms.");
  assert.equal(calls, 2);
});

test("assistant rejects extra fields in a tool call before performing any lookup", async () => {
  let turns = 0;
  const answer = await runOpenAiAssistant(
    config,
    "Look up a public recipe",
    async () => assert.fail("malformed tool input reached the recipe lookup"),
    async (_url, options) => {
      if (++turns === 1) {
        return Response.json({
          status: "completed",
          output: [
            {
              type: "function_call",
              name: "get_recipe",
              call_id: "extra-input",
              arguments: JSON.stringify({ slug: "public-example", revision: "unexpected" }),
            },
          ],
        });
      }
      const input = JSON.parse(String(options?.body)).input;
      assert.deepEqual(JSON.parse(input.at(-1).output), {
        error: "Unknown tool or invalid arguments.",
      });
      return Response.json({
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "Lookup was rejected." }] },
        ],
      });
    },
  );
  assert.equal(answer, "Lookup was rejected.");
  assert.equal(turns, 2);
});
