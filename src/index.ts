import { isRecord, isString } from "./guards";
import { JsonBodyError, readJsonObject } from "./read-json-object";
import { parsePagePath } from "./routes.ts";
import { Cookbook, RequestError, str, type Database, type Input } from "./store";
import {
  fetchOpenAiModelCatalog,
  isOpenAiModel,
  OpenAiError,
  runOpenAiAssistant,
} from "./openai.ts";
import html from "./page.html";
import css from "./styles.css";
import browser from "cookbook:browser";

interface Env {
  DB: Database;
  MAINTAINER_EMAILS?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}
const string = { type: "string" };
const listing = {
  query: { type: "string", maxLength: 160 },
  tag: { type: "string", maxLength: 32 },
  limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  cursor: {
    type: "string",
    description: "A nextCursor or previousCursor from the same filtered list.",
  },
};
const files = Object.fromEntries(
  ["source", "interface", "tests", "documentation", "instructions", "styles"].map((key) => [
    key,
    string,
  ]),
);
/**
 * Describe an MCP tool and its accepted argument object.
 * @param name The public name registered for the MCP tool.
 * @param description The tool purpose shown to MCP clients.
 * @param properties The JSON Schema definitions for accepted arguments.
 * @param required The argument keys required by the tool.
 */
const tool = (name: string, description: string, properties: Input, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});
const tools = [
  tool(
    "search_recipes",
    "Find one page of published recipe summaries. Read items and use nextCursor or previousCursor to continue.",
    listing,
  ),
  tool(
    "get_recipe",
    "Retrieve selected file parts. Omit revision for the current published revision; supply your revision ID to read a draft.",
    {
      slug: string,
      revision: string,
      parts: {
        type: "array",
        items: { enum: Object.keys(files) },
        maxItems: Object.keys(files).length,
      },
    },
    ["slug"],
  ),
  tool(
    "submit_recipe",
    "Submit one complete recipe snapshot for human review. Use base to create a new revision, or replace with the ID and editVersion of your unapproved revision to update it in place. Include all parts to retain. Any part can stand alone, including documentation or agent instructions.",
    {
      slug: string,
      title: string,
      summary: string,
      tags: { type: "array", items: string, maxItems: 8 },
      base: string,
      replace: string,
      editVersion: { type: "integer", minimum: 0 },
      allowDuplicates: {
        type: "boolean",
        description: "Acknowledge duplicate warnings. Cannot override an error.",
      },
      files: {
        type: "object",
        properties: files,
        minProperties: 1,
        additionalProperties: false,
      },
    },
    ["slug", "title", "summary", "files"],
  ),
  tool(
    "my_revisions",
    "List one page of your recipe revisions. Use nextCursor or previousCursor to continue.",
    listing,
  ),
  tool(
    "review_queue",
    "List one page of the maintainer review queue. Filter by keyword, tag, or status. Use nextCursor or previousCursor to continue.",
    { ...listing, state: { enum: ["pending", "approved", "quarantined", "removal"] } },
  ),
];
const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'",
};
/**
 * Return a JSON response with the Worker security headers.
 * @param data The data to serialize into the response body.
 * @param status The HTTP status sent with the response.
 */
function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers });
}

/**
 * Return a built application asset with its content type.
 * @param content The text of the generated browser asset.
 * @param type The MIME type the browser should use.
 */
function asset(content: string, type: string) {
  return new Response(content, {
    headers: { ...headers, "content-type": type + "; charset=utf-8" },
  });
}

/**
 * Require a plain JSON object before reading request fields.
 * @param input The decoded request value to validate.
 * @throws {RequestError} When the input is not an object.
 */
function object(input: unknown): Input {
  if (!isRecord(input)) {
    throw new RequestError("Expected a JSON object.");
  }
  return input;
}

/**
 * Read a request body under the API's byte limit.
 * @param request The incoming request carrying a JSON object.
 */
const body = (request: Request) => readJsonObject(request, 96_000);

/**
 * Extract a caller-facing message from a request failure.
 * @param error The thrown value received from the handler.
 */
function message(error: unknown) {
  if (error instanceof RequestError || error instanceof JsonBodyError) {
    return error.message;
  }
  console.error("Cookbook operation failed", error);
  return "The operation failed. Please retry.";
}

/**
 * Handle a JSON-RPC request against the MCP recipe tools.
 * @param request The incoming MCP HTTP request.
 * @param cookbook The recipe service for the caller, or null when signed out.
 */
async function mcp(request: Request, cookbook: Cookbook | null) {
  const rpc = await body(request);
  const { method, id = null } = rpc;
  /**
   * Return a JSON-RPC result with the request correlation ID.
   * @param value The successful tool response payload.
   */
  const result = (value: unknown) => json({ jsonrpc: "2.0", id, result: value });

  /**
   * Return a JSON-RPC error with the request correlation ID.
   * @param code The numeric JSON-RPC error code.
   * @param detail The human-readable failure message.
   */
  const fail = (code: number, detail: string) =>
    json({ jsonrpc: "2.0", id, error: { code, message: detail } });
  if (rpc.jsonrpc !== "2.0" || !isString(method)) {
    return fail(-32600, "Invalid request.");
  }
  if (method === "server/discover") {
    return result({
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      serverInfo: { name: "code-cookbook", version: "1.0.0" },
    });
  }
  if (method === "initialize") {
    const version = object(rpc.params ?? {}).protocolVersion;
    return result({
      protocolVersion: version === "2025-11-25" ? version : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "code-cookbook", version: "1.0.0" },
    });
  }
  if (method.startsWith("notifications/")) {
    return new Response(null, { status: 202, headers });
  }
  if (method === "ping") {
    return result({});
  }
  if (method === "tools/list") {
    return result({ tools });
  }
  if (method !== "tools/call") {
    return fail(-32601, "Unknown method.");
  }
  try {
    if (!cookbook) {
      throw new RequestError("Sign in to use the cookbook.");
    }
    const params = object(rpc.params);
    const input = object(params.arguments ?? {});
    let value: unknown;
    switch (params.name) {
      case "search_recipes":
        value = await cookbook.search(input);
        break;
      case "get_recipe":
        value = await cookbook.get(input);
        break;
      case "submit_recipe":
        value = await cookbook.submit(input);
        break;
      case "my_revisions":
        value = await cookbook.queue(input, true);
        break;
      case "review_queue":
        value = await cookbook.queue(input, false);
        break;
      default:
        return fail(-32602, "Unknown tool.");
    }
    return result({ content: [{ type: "text", text: JSON.stringify(value) }] });
  } catch (error) {
    const detail = message(error);
    if (error instanceof RequestError && error.code === "duplicate_warning") {
      return result({
        isError: true,
        content: [
          {
            type: "text",
            text: detail + " If appropriate, retry with allowDuplicates set to true.",
          },
        ],
        structuredContent: { code: error.code, error: detail },
      });
    }
    return result({ isError: true, content: [{ type: "text", text: detail }] });
  }
}

/**
 * Answer with published recipe content and return links for recipes actually read.
 * @param request Authenticated request containing a single question.
 * @param env Server-only deployment bindings.
 * @param cookbook Cookbook with the current viewer's access.
 * @throws {RequestError} When the integration is unconfigured or the question is invalid.
 */
async function askAssistant(request: Request, env: Env, cookbook: Cookbook) {
  const key = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim();
  if (!key || !isOpenAiModel(model)) {
    throw new RequestError("Configure OpenAI in the hosted runtime before asking a question.", 503);
  }
  const input = await readJsonObject(request, 16_000);
  const question = str(input.question, "a question", 4_000);
  const sources = new Map<string, { slug: string; id: string; title: string }>();
  const answer = await runOpenAiAssistant({ key, model }, question, async (name, value) => {
    if (name === "search_recipes") {
      const { items } = await cookbook.search({ query: value, limit: 6 });
      return { items: items.map(({ slug, title, summary }) => ({ slug, title, summary })) };
    }
    // The published pointer is the only revision selector the model may use.
    const { slug, id, title, files } = await cookbook.get({
      slug: value,
      parts: ["documentation", "source"],
    });
    sources.set(slug, { slug, id, title });
    return {
      slug,
      title,
      parts: Object.fromEntries(
        Object.entries(files).map(([part, text]) => [
          part,
          { text: text.slice(0, 3_000), truncated: text.length > 3_000 },
        ]),
      ),
    };
  });
  return json({ answer, sources: [...sources.values()] });
}

export default {
  /**
   * Route application, API, and MCP traffic in the Worker.
   * @param request The incoming HTTP request to handle.
   * @param env The runtime deployment bindings for this Worker.
   */
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET") {
        if (parsePagePath(url.pathname)) {
          return asset(html, "text/html");
        }
        if (url.pathname === "/styles.css") {
          return asset(css, "text/css");
        }
        if (url.pathname === "/browser.js") {
          return asset(browser, "text/javascript");
        }
      }
      const id = request.headers.get("oai-authenticated-user-id");
      const email = request.headers.get("oai-authenticated-user-email")?.toLowerCase();
      const maintainer =
        !!email &&
        (env.MAINTAINER_EMAILS ?? "")
          .toLowerCase()
          .split(",")
          .map((v) => v.trim())
          .includes(email);
      const cookbook = id ? new Cookbook(env.DB, { id, maintainer }) : null;
      if (url.pathname === "/mcp" && request.method === "POST") {
        return await mcp(request, cookbook);
      }
      if (!url.pathname.startsWith("/api/")) {
        return json({ error: "Page not found." }, 404);
      }
      if (!cookbook) {
        throw new RequestError("Sign in with ChatGPT to access the cookbook.", 401);
      }
      if (
        (url.pathname === "/api/assistant" || url.pathname === "/api/assistant/models") &&
        !maintainer
      ) {
        throw new RequestError("Maintainer access required.", 403);
      }
      if (request.method === "GET") {
        const input = Object.fromEntries(url.searchParams);
        switch (url.pathname) {
          case "/api/settings":
            return json(await cookbook.codeSettings());
          case "/api/session":
            return json({ maintainer });
          case "/api/assistant": {
            const model = env.OPENAI_MODEL?.trim();
            return json({
              configured: Boolean(env.OPENAI_API_KEY?.trim()) && isOpenAiModel(model),
              model: isOpenAiModel(model) ? model : null,
            });
          }
          case "/api/assistant/models": {
            const key = env.OPENAI_API_KEY?.trim();
            if (!key) {
              throw new RequestError("Configure OpenAI in the hosted runtime first.", 503);
            }
            return json(await fetchOpenAiModelCatalog(key));
          }
          case "/api/search":
            return json(await cookbook.search(input));
          case "/api/recipe":
            return json(await cookbook.get(input, input.reviewComments === "1"));
          case "/api/mine":
            return json(await cookbook.queue(input, true));
          case "/api/queue":
            return json(await cookbook.queue(input, false));
        }
      }
      if (request.method === "POST") {
        if (request.headers.get("origin") !== url.origin) {
          throw new RequestError("Same-origin browser request required.", 403);
        }
        if (url.pathname === "/api/settings") {
          return json(await cookbook.saveCodeSettings(await body(request)));
        }
        if (url.pathname === "/api/assistant") {
          return await askAssistant(request, env, cookbook);
        }
        if (url.pathname === "/api/submit") {
          const result = await cookbook.submit(await body(request));
          return json(result, result.editVersion > 0 ? 200 : 201);
        }
        if (url.pathname === "/api/comment") {
          return json(await cookbook.comment(await body(request)), 201);
        }
        if (url.pathname === "/api/action") {
          return json(await cookbook.action(await body(request)));
        }
      }
      return json({ error: "Route not found." }, 404);
    } catch (error) {
      return json(
        { error: message(error), code: error instanceof RequestError ? error.code : undefined },
        error instanceof RequestError ||
          error instanceof JsonBodyError ||
          error instanceof OpenAiError
          ? error.status
          : 500,
      );
    }
  },
};
