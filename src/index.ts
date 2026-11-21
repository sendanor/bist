import { isRecord, isString } from "./guards";
import { JsonBodyError, readJsonObject } from "./read-json-object";
import { Cookbook, RequestError, type Database, type Input } from "./store";
import html from "./page.html";
import css from "./styles.css";
import browser from "cookbook:browser";

interface Env {
  DB: Database;
  MAINTAINER_EMAILS?: string;
}
const string = { type: "string" };
const files = Object.fromEntries(
  ["source", "interface", "tests", "documentation", "instructions", "styles"].map((key) => [
    key,
    string,
  ]),
);
const tool = (name: string, description: string, properties: Input, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});
const tools = [
  tool(
    "search_recipes",
    "Find published recipes and guides by purpose or tag. Returns summaries without files.",
    { query: string, tag: string },
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
      files: {
        type: "object",
        properties: files,
        minProperties: 1,
        additionalProperties: false,
      },
    },
    ["slug", "title", "summary", "files"],
  ),
  tool("my_revisions", "List your recent recipe revisions and their review statuses.", {}),
];
const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'",
};
function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers });
}
function asset(content: string, type: string) {
  return new Response(content, {
    headers: { ...headers, "content-type": type + "; charset=utf-8" },
  });
}
function object(input: unknown): Input {
  if (!isRecord(input)) {
    throw new RequestError("Expected a JSON object.");
  }
  return input;
}
const body = (request: Request) => readJsonObject(request, 96_000);
function message(error: unknown) {
  if (error instanceof RequestError || error instanceof JsonBodyError) {
    return error.message;
  }
  console.error("Cookbook operation failed", error);
  return "The operation failed. Please retry.";
}

async function mcp(request: Request, cookbook: Cookbook | null) {
  const rpc = await body(request);
  const { method, id = null } = rpc;
  const result = (value: unknown) => json({ jsonrpc: "2.0", id, result: value });
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
        value = await cookbook.queue(true);
        break;
      default:
        return fail(-32602, "Unknown tool.");
    }
    return result({ content: [{ type: "text", text: JSON.stringify(value) }] });
  } catch (error) {
    return result({ isError: true, content: [{ type: "text", text: message(error) }] });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET") {
        if (url.pathname === "/") {
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
      if (request.method === "GET") {
        const input = Object.fromEntries(url.searchParams);
        switch (url.pathname) {
          case "/api/settings":
            return json(await cookbook.codeSettings());
          case "/api/session":
            return json({ maintainer });
          case "/api/search":
            return json(await cookbook.search(input));
          case "/api/recipe":
            return json(await cookbook.get(input));
          case "/api/mine":
            return json(await cookbook.queue(true));
          case "/api/queue":
            return json(await cookbook.queue(false));
        }
      }
      if (request.method === "POST") {
        if (request.headers.get("origin") !== url.origin) {
          throw new RequestError("Same-origin browser request required.", 403);
        }
        if (url.pathname === "/api/settings") {
          return json(await cookbook.saveCodeSettings(await body(request)));
        }
        if (url.pathname === "/api/submit") {
          const result = await cookbook.submit(await body(request));
          return json(result, result.editVersion > 0 ? 200 : 201);
        }
        if (url.pathname === "/api/action") {
          return json(await cookbook.action(await body(request)));
        }
      }
      return json({ error: "Route not found." }, 404);
    } catch (error) {
      return json(
        { error: message(error) },
        error instanceof RequestError || error instanceof JsonBodyError ? error.status : 500,
      );
    }
  },
};
