import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchOpenAiDocs } from "../src/openai-docs-mcp.ts";

const protocol = "2025-11-25";

/**
 * Encode an MCP response for the request ID supplied by the test transport.
 * @param id Correlation ID returned by the endpoint.
 * @param result Simulated upstream operation result.
 * @param headers Transport headers provided by the endpoint.
 */
function reply(id: number, result: object, headers?: HeadersInit) {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers });
}

/**
 * Simulate a complete MCP search after a standard initialization and notification.
 * @param result Search response to return to the adapter.
 */
function searchTransport(result: Response): typeof fetch {
  return async (_url, options) => {
    const message = JSON.parse(String(options?.body));
    switch (message.method) {
      case "initialize":
        return reply(message.id, { protocolVersion: protocol });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      default:
        assert.equal(message.method, "tools/call");
        return result;
    }
  };
}

describe("OpenAI documentation MCP transport", () => {
  it("negotiates a session and sends only the approved public lookup", async () => {
    const methods: string[] = [];
    const title = "A".repeat(180);
    const excerpt = "B".repeat(360);
    const hits = await searchOpenAiDocs(
      "streaming",
      async () => true,
      async (url, request) => {
        assert.equal(url, "https://developers.openai.com/mcp");
        assert.equal(request?.redirect, "manual");
        const headers = new Headers(request?.headers);
        assert.equal(headers.has("authorization"), false);
        const message = JSON.parse(String(request?.body));
        methods.push(message.method);
        if (message.method === "initialize") {
          assert.equal(headers.has("mcp-session-id"), false);
          return reply(
            message.id,
            { protocolVersion: protocol },
            { "mcp-session-id": "fixture-session" },
          );
        }
        assert.equal(headers.get("mcp-session-id"), "fixture-session");
        assert.equal(headers.get("mcp-protocol-version"), protocol);
        if (message.method === "notifications/initialized") {
          assert.equal(message.id, undefined);
          return new Response(null, { status: 202 });
        }
        assert.deepEqual(message.params, {
          name: "search_openai_docs",
          arguments: { query: "streaming", limit: 3 },
        });
        return reply(message.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                hits: [
                  {
                    url: "https://developers.openai.com/docs#stream",
                    hierarchy: { lvl1: title },
                    content: excerpt,
                  },
                  { url: "https://platform.openai.com/docs?tracking=fixture" },
                  { url: "https://user:password@learn.chatgpt.com/docs" },
                  { url: "https://learn.chatgpt.com/after-result-limit" },
                ],
              }),
            },
          ],
        });
      },
    );
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/call"]);
    assert.deepEqual(hits, [
      {
        url: "https://developers.openai.com/docs#stream",
        title: title.slice(0, 160),
        excerpt: excerpt.slice(0, 350),
      },
      { url: "https://platform.openai.com/docs", title: "/docs", excerpt: "" },
    ]);
  });

  it("discards mismatched response IDs, malformed content and invalid hits", async () => {
    for (const result of [
      reply(9, { content: [] }),
      reply(2, { isError: true }),
      reply(2, {}),
      reply(2, { content: [{ type: "resource", text: "{}" }] }),
      reply(2, { content: [{ type: "text", text: "{" }] }),
      reply(2, { content: [{ type: "text", text: '{"hits":"invalid"}' }] }),
    ]) {
      assert.equal(
        await searchOpenAiDocs("reference", async () => true, searchTransport(result)),
        null,
      );
    }
    const content = JSON.stringify({
      hits: [null, { url: "malformed" }, { url: "x".repeat(501) }],
    });
    assert.deepEqual(
      await searchOpenAiDocs(
        "reference",
        async () => true,
        searchTransport(reply(2, { content: [{ type: "text", text: content }] })),
      ),
      [],
    );
  });

  it("stops after a rejected handshake or unaccepted notification", async () => {
    const wrongProtocol = reply(1, { protocolVersion: "2025-06-18" });
    const longSession = reply(
      1,
      { protocolVersion: protocol },
      { "mcp-session-id": "a".repeat(257) },
    );
    const rejected = new Response("Unavailable", { status: 503 });
    for (const response of [wrongProtocol, longSession, rejected]) {
      let calls = 0;
      assert.equal(
        await searchOpenAiDocs(
          "reference",
          async () => true,
          async () => {
            calls++;
            return response;
          },
        ),
        null,
      );
      assert.equal(calls, 1);
    }
    let stage = 0;
    assert.equal(
      await searchOpenAiDocs(
        "reference",
        async () => true,
        async () => {
          stage++;
          return stage === 1
            ? reply(1, { protocolVersion: protocol })
            : new Response("Rejected", { status: 400 });
        },
      ),
      null,
    );
    assert.equal(stage, 2);
    assert.equal(
      await searchOpenAiDocs(
        "reference",
        async () => false,
        async () => assert.fail("disabled connection made a request"),
      ),
      null,
    );
  });
});
