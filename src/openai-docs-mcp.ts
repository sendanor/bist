import { isArray, isRecord, isString } from "./guards.ts";
import { readJsonObject, readUtf8 } from "./read-json-object.ts";

const openAiDocsEndpoint = "https://developers.openai.com/mcp";
const context7Endpoint = "https://mcp.context7.com/mcp";
const protocol = "2025-11-25";
const resultLimit = 3;
const maxBytes = 32_000;
const docsOrigins = new Set([
  "https://developers.openai.com",
  "https://platform.openai.com",
  "https://learn.chatgpt.com",
]);

/** Public documentation fields allowed into the model context. */
export interface DocsHit {
  readonly url: string;
  readonly title: string;
  readonly excerpt: string;
}

/**
 * Decode a bounded MCP reply in the documented JSON or event-stream format.
 * @param response Upstream HTTP reply from the fixed OpenAI Docs endpoint.
 * @param id Correlation identifier for this request.
 */
async function reply(response: Response, id: number) {
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const messages: unknown[] =
    type === "text/event-stream"
      ? (await readUtf8(response.body, maxBytes))
          .split(/\r?\n\r?\n/u)
          .map((event) =>
            event
              .split(/\r?\n/u)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /u, ""))
              .join("\n"),
          )
          .filter(Boolean)
          .map((data) => JSON.parse(data))
      : [await readJsonObject(response, maxBytes)];
  const message = messages.find((value) => isRecord(value) && value.id === id);
  return isRecord(message) && message.jsonrpc === "2.0" && isRecord(message.result)
    ? message.result
    : null;
}

/**
 * Keep only bounded public titles, excerpts and links on verified documentation origins.
 * @param result JSON-RPC tool result returned by the documentation service.
 */
function docsHits(result: Record<string, unknown> | null): DocsHit[] | null {
  if (!result || result.isError === true || !isArray(result.content)) {
    return null;
  }
  const content = result.content[0];
  if (!isRecord(content) || content.type !== "text" || !isString(content.text)) {
    return null;
  }
  const payload: unknown = JSON.parse(content.text);
  if (!isRecord(payload) || !isArray(payload.hits)) {
    return null;
  }
  return payload.hits.slice(0, resultLimit).flatMap((hit) => {
    if (!isRecord(hit) || !isString(hit.url) || hit.url.length > 500) {
      return [];
    }
    const link = URL.parse(hit.url);
    if (!link || !docsOrigins.has(link.origin) || link.username || link.password) {
      return [];
    }
    link.search = "";
    const title =
      isRecord(hit.hierarchy) && isString(hit.hierarchy.lvl1)
        ? hit.hierarchy.lvl1.slice(0, 160)
        : link.pathname.slice(0, 160);
    return [
      { url: link.href, title, excerpt: isString(hit.content) ? hit.content.slice(0, 350) : "" },
    ];
  });
}

/**
 * Call a fixed public MCP tool over Streamable HTTP without sending credentials.
 * @param endpoint Server URL selected by the provider adapter.
 * @param name The single approved tool for this adapter.
 * @param args Tool arguments selected by the adapter.
 * @param authorized Recheck the saved setting before negotiating and calling the tool.
 * @param send Fetch implementation that dispatches requests to the public MCP endpoint.
 */
async function callDocsMcp(
  endpoint: string,
  name: string,
  args: Readonly<Record<string, string | number>>,
  authorized: () => Promise<boolean>,
  send: typeof fetch,
) {
  const signal = AbortSignal.timeout(6_000);
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  /**
   * Send one JSON-RPC operation to the fixed endpoint without credentials or redirects.
   * @param message Protocol fields for initialization, notification or search.
   */
  const post = (message: object) =>
    send(endpoint, {
      method: "POST",
      redirect: "manual",
      signal,
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    });
  try {
    if (!(await authorized())) {
      return null;
    }
    const response = await post({
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: protocol,
        capabilities: {},
        clientInfo: { name: "bist", version: "1.0.0" },
      },
    });
    if ((await reply(response, 1))?.protocolVersion !== protocol) {
      return null;
    }
    const session = response.headers.get("mcp-session-id");
    if (session) {
      if (session.length > 256 || !/^[!-~]+$/u.test(session)) {
        return null;
      }
      headers.set("mcp-session-id", session);
    }
    headers.set("mcp-protocol-version", protocol);
    const notification = await post({ method: "notifications/initialized" });
    await notification.body?.cancel();
    if (!notification.ok || !(await authorized())) {
      return null;
    }
    const search = await post({
      method: "tools/call",
      id: 2,
      params: { name, arguments: args },
    });
    return await reply(search, 2);
  } catch {
    return null;
  }
}

/**
 * Search OpenAI Docs and keep only approved public link and excerpt fields.
 * @param query Public search terms entered by the maintainer.
 * @param authorized Recheck the saved connection setting during the request.
 * @param send Optional fetch implementation for tests.
 */
export async function searchOpenAiDocs(
  query: string,
  authorized: () => Promise<boolean>,
  send: typeof fetch = fetch,
) {
  try {
    return docsHits(
      await callDocsMcp(
        openAiDocsEndpoint,
        "search_openai_docs",
        { query, limit: resultLimit },
        authorized,
        send,
      ),
    );
  } catch {
    return null;
  }
}

/**
 * Look up a selected public library through Context7's read-only documentation tool.
 * @param query Public search terms entered by the maintainer.
 * @param libraryId Exact Context7 library ID entered by the maintainer.
 * @param authorized Recheck the saved connection setting during the request.
 */
export async function searchContext7(
  query: string,
  libraryId: string,
  authorized: () => Promise<boolean>,
) {
  const result = await callDocsMcp(
    context7Endpoint,
    "query-docs",
    { query, libraryId },
    authorized,
    fetch,
  );
  if (!result || result.isError === true || !isArray(result.content)) {
    return null;
  }
  const content = result.content[0];
  return isRecord(content) && content.type === "text" && isString(content.text)
    ? content.text.slice(0, 2_500)
    : null;
}
