import { isArray, isRecord, isString } from "./guards";
import { JsonBodyError, readJsonObject } from "./read-json-object";
import { parsePagePath } from "./routes.ts";
import { effectiveReasoning, reasoningOptions } from "./reasoning.ts";
import {
  llmReviewPolicy,
  readLlmReviewPolicy,
  saveLlmReviewPolicy,
} from "./llm-review-settings.ts";
import { reviewSavedFiles, reviewSubmission } from "./submission-review.ts";
import {
  docsMcpEnabled,
  enabledSkills,
  readMcpSettings,
  saveDocsMcp,
  saveEnabledSkills,
  saveMcpSettings,
} from "./mcp-settings.ts";
import { searchContext7, searchOpenAiDocs } from "./openai-docs-mcp.ts";
import { runOpenAiFileEdit } from "./openai-file-edit.ts";
import {
  Cookbook,
  RequestError,
  str,
  type Database,
  type Input,
  type SubmissionReview,
} from "./store";
import {
  fetchOpenAiModelCatalog,
  isOpenAiModel,
  OpenAiError,
  runOpenAiAssistant,
  type AssistantTurn,
} from "./openai.ts";
import {
  isSettingsKey,
  openOpenAiKey,
  sealOpenAiKey,
  SettingsCryptoError,
} from "./settings-crypto.ts";
import html from "./page.html";
import css from "./styles.css";
import browser from "cookbook:browser";
import caveman from "./skills/caveman/SKILL.md";
import suomenkieli from "./skills/suomenkieli/SKILL.md";
import seo from "./skills/seo/SKILL.md";
import design from "./skills/design/SKILL.md";
import importSkill from "./skills/import/SKILL.md";
import publication from "./skills/publication/SKILL.md";

interface Env {
  DB: Database;
  MAINTAINER_EMAILS?: string;
  SETTINGS_ENCRYPTION_KEY?: string;
}
const revisionRecheckPath = "/api/review/recheck";
const fileEditPath = "/api/recipe/file";
const fileSuggestionPath = fileEditPath + "/suggest";
const openAiPaths = new Set([
  revisionRecheckPath,
  "/api/assistant",
  "/api/assistant/models",
  "/api/settings/openai",
  "/api/settings/openai/remove-key",
  "/api/settings/llm-review",
]);
const mcpSettingsPath = "/api/settings/mcp";
const mcpCheckPath = mcpSettingsPath + "/check";
const docsMcpPath = mcpSettingsPath + "/openai-docs";
const context7Path = mcpSettingsPath + "/context7";
const skillsSettingsPath = mcpSettingsPath + "/skills";
const skills = new Map([
  ["caveman", caveman],
  ["suomenkieli", suomenkieli],
  ["seo", seo],
  ["design", design],
  ["import", importSkill],
  ["publication", publication],
]);
const skillNames = [...skills.keys()];
const defaultSkills = ["caveman", "suomenkieli"];
const string = { type: "string" };
const listing = {
  query: { type: "string", maxLength: 160 },
  tag: { type: "string", maxLength: 32 },
  tags: {
    type: "array",
    maxItems: 8,
    items: { type: "string", maxLength: 32 },
    description: "Require every listed tag. Combine with query to also match keywords.",
  },
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
    "Submit one complete recipe snapshot for human review. Use base for a new revision, or replace and editVersion to update your draft. Include all parts to keep. Any part can stand alone. On llm_warning, show the user every finding and ask whether to fix the files or submit with the warnings. Wait for their choice before retrying.",
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
      reviewReceipt: {
        type: "string",
        maxLength: 36,
        description:
          "Only after the user explicitly accepts the displayed LLM warnings, return this receipt with the same submission. Omit it when sending corrections.",
      },
      files: {
        type: "object",
        properties: files,
        minProperties: 1,
        additionalProperties: false,
      },
      fileNames: {
        type: "object",
        description:
          "Optional filenames keyed by file part. An empty string restores a default name.",
        properties: files,
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
    "List one page of the maintainer review queue. Filter by keywords, tags, or status. Use nextCursor or previousCursor to continue.",
    { ...listing, state: { enum: ["pending", "approved", "quarantined", "removal"] } },
  ),
];
const toolNames = tools.map(({ name }) => name);
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
 * Download a built-in skill or package the prose of a visible published recipe.
 * @param input Requested built-in name or the exact recipe slug and revision.
 * @param cookbook Recipe service scoped to the current viewer.
 * @throws {RequestError} When the requested skill or published prose is unavailable.
 */
async function downloadSkill(input: Input, cookbook: Cookbook) {
  const name = str(input.name, "skill name", 64, true);
  let markdown = skills.get(name);
  if (!name) {
    const recipe = await cookbook.get({
      slug: input.slug,
      revision: input.revision,
      parts: ["instructions", "documentation"],
    });
    const prose = recipe.files.instructions || recipe.files.documentation;
    if (recipe.state === "published" && prose) {
      const content = prose.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "").trim();
      markdown = `---\nname: ${recipe.slug}\ndescription: ${JSON.stringify(recipe.summary)}\n---\n\n${content}\n`;
    }
  }
  if (!markdown) {
    throw new RequestError("Skill not found.", 404);
  }
  return new Response(markdown, {
    headers: {
      ...headers,
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": 'attachment; filename="SKILL.md"',
    },
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
  if (
    error instanceof RequestError ||
    error instanceof JsonBodyError ||
    error instanceof OpenAiError ||
    error instanceof SettingsCryptoError
  ) {
    return error.message;
  }
  console.error("Cookbook operation failed", error);
  return "The operation failed. Please retry.";
}

/**
 * Return the tool definitions currently advertised by the server.
 * @param db The instance database holding MCP settings.
 */
async function currentMcpTools(db: Database) {
  const settings = await readMcpSettings(db, toolNames);
  return settings.enabled ? tools.filter(({ name }) => settings.enabledTools.includes(name)) : [];
}

/**
 * Handle a JSON-RPC request against the MCP recipe tools.
 * @param request The incoming MCP HTTP request.
 * @param cookbook The recipe service for the caller, or null when signed out.
 * @param env Deployment bindings for MCP settings and submission checks.
 */
async function mcp(request: Request, cookbook: Cookbook | null, env: Env) {
  const db = env.DB;
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
    return result({ tools: await currentMcpTools(db) });
  }
  if (method !== "tools/call") {
    return fail(-32601, "Unknown method.");
  }
  try {
    if (!cookbook) {
      throw new RequestError("Sign in to use the cookbook.");
    }
    const params = object(rpc.params);
    if (!isString(params.name) || !toolNames.includes(params.name)) {
      return fail(-32602, "Unknown tool.");
    }
    const settings = await readMcpSettings(db, toolNames);
    if (!settings.enabled || !settings.enabledTools.includes(params.name)) {
      throw new RequestError("This MCP tool is disabled.");
    }
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
        value = await cookbook.submit(input, (candidate) =>
          reviewSubmission(db, env.SETTINGS_ENCRYPTION_KEY, candidate),
        );
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
    if (error instanceof RequestError && error.code === "llm_warning") {
      return result({
        isError: true,
        content: [
          {
            type: "text",
            text:
              detail +
              "\nShow these warnings to the user. Ask them to correct the files or explicitly approve submitting with all warnings. Wait for their decision. For corrections, omit the receipt. Only with approval, retry the same submit_recipe call with " +
              JSON.stringify({ reviewReceipt: error.receipt }) +
              ".",
          },
        ],
        structuredContent: {
          code: error.code,
          error: detail,
          warnings: error.warnings,
          reviewReceipt: error.receipt,
        },
      });
    }
    return result({ isError: true, content: [{ type: "text", text: detail }] });
  }
}

/**
 * Return connection metadata for Settings without reading or exposing ciphertext.
 * @param env Server-only deployment bindings.
 * @param cookbook Cookbook with the verified maintainer identity.
 */
async function openAiStatus(env: Env, cookbook: Cookbook) {
  const { model, hasCredential, reasoningEffort } = await cookbook.openAiSettings();
  const encryptionAvailable = isSettingsKey(env.SETTINGS_ENCRYPTION_KEY);
  return {
    model,
    reasoningEffort,
    hasCredential,
    encryptionAvailable,
    configured: hasCredential && isOpenAiModel(model) && encryptionAvailable,
  };
}

/**
 * Validate the submitted configuration and save only the encrypted credential.
 * @param request Same-origin request from the authorized maintainer.
 * @param env Server-only deployment bindings for encryption.
 * @param cookbook Cookbook with the verified maintainer identity.
 * @throws {RequestError} When the model or replacement credential is invalid.
 */
async function saveOpenAi(request: Request, env: Env, cookbook: Cookbook) {
  const input = await readJsonObject(request, 4_096);
  const model = typeof input.model === "string" ? input.model.trim() : input.model;
  if (model !== undefined && !isOpenAiModel(model)) {
    throw new RequestError("Enter a valid OpenAI model identifier.");
  }
  const key = input.apiKey;
  const effort = str(input.reasoningEffort, "reasoning effort", 12, true);
  if (
    effort &&
    !reasoningOptions(model ?? (await cookbook.openAiSettings()).model ?? "").some(
      (level) => level === effort,
    )
  ) {
    throw new RequestError("Choose a reasoning effort supported by this model.");
  }
  if (key === undefined && model === undefined && input.reasoningEffort === undefined) {
    throw new RequestError("Enter an OpenAI API key or choose a model.");
  }
  if (
    key !== undefined &&
    (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{9,511}$/u.test(key))
  ) {
    throw new RequestError("Enter a valid OpenAI API key.");
  }
  await cookbook.reserveOpenAiRequest("settings");
  const credential =
    key === undefined ? null : await sealOpenAiKey(env.SETTINGS_ENCRYPTION_KEY, key);
  await cookbook.saveOpenAiSettings(
    model ?? null,
    credential,
    input.reasoningEffort === undefined ? null : effort,
  );
  return json(await openAiStatus(env, cookbook));
}

/**
 * Open a stored credential only for a trusted, rate-limited provider operation.
 * @param env Server-only deployment bindings for decryption.
 * @param cookbook Cookbook with the verified maintainer identity.
 * @param action Authorized type of OpenAI request to reserve.
 * @throws {RequestError} When the integration has no saved credential or valid model.
 */
async function openAiConnection(env: Env, cookbook: Cookbook, action: "ask" | "catalog") {
  const stored = await cookbook.readOpenAiConnection();
  if (!stored?.credential || (action === "ask" && !isOpenAiModel(stored.model))) {
    throw new RequestError("Configure OpenAI in Bist Settings first.", 503);
  }
  await cookbook.reserveOpenAiRequest(action);
  return {
    model: stored.model,
    reasoningEffort: effectiveReasoning(stored.model, stored.reasoning_effort),
    key: await openOpenAiKey(env.SETTINGS_ENCRYPTION_KEY, stored.credential),
  };
}

/**
 * Read recent conversational context as plain user and assistant messages.
 * @param value Untrusted browser history sent with the next question.
 * @throws {RequestError} When the history has unsupported roles or exceeds its limits.
 */
function assistantHistory(value: unknown): readonly AssistantTurn[] {
  if (value === undefined) {
    return [];
  }
  if (!isArray(value) || value.length > 8) {
    throw new RequestError("Provide at most eight previous messages.");
  }
  const turns = value.map((turn): AssistantTurn => {
    if (!isRecord(turn) || (turn.role !== "user" && turn.role !== "assistant")) {
      throw new RequestError("History must contain user and assistant messages.");
    }
    return { role: turn.role, content: str(turn.content, "previous message", 1_200) };
  });
  if (new TextEncoder().encode(JSON.stringify(turns)).byteLength > 12_000) {
    throw new RequestError("Conversation history is too large.");
  }
  return turns;
}

/**
 * Answer with published recipe content and return links for recipes actually read.
 * @param request Authenticated request containing a single question.
 * @param env Server-only deployment bindings.
 * @param cookbook Cookbook with the current viewer's access.
 * @throws {RequestError} When the integration is unconfigured or the question is invalid.
 */
async function askAssistant(request: Request, env: Env, cookbook: Cookbook) {
  const input = await readJsonObject(request, 40_000);
  const history = assistantHistory(input.history);
  const question = str(input.question, "a question", 4_000);
  const docsQuery = str(input.docsQuery, "public documentation search terms", 160, true);
  const libraryId = str(input.libraryId, "Context7 library ID", 160, true);
  const context7 = Boolean(libraryId);
  if (context7 && (!docsQuery || !/^\/[\w.-]+\/[\w.-]+(?:\/[\w.+-]+)?$/u.test(libraryId))) {
    throw new RequestError(
      "Enter public search terms and a Context7 library ID such as /react/react.",
    );
  }
  if (docsQuery && !(await docsMcpEnabled(env.DB, context7))) {
    throw new RequestError(
      context7 ? "Context7 search is disabled." : "OpenAI Docs search is disabled.",
      403,
    );
  }
  const config = await openAiConnection(env, cookbook, "ask");
  const activeSkills = await enabledSkills(env.DB, skillNames, defaultSkills);
  const skillCatalog = activeSkills.flatMap((id) => {
    const manifest = skills.get(id);
    const encoded = manifest?.match(/^description: (.+)$/mu)?.[1];
    const description: unknown = encoded ? JSON.parse(encoded) : null;
    return isString(description) ? [{ id, description }] : [];
  });
  /**
   * Load a skill only while it is still enabled in the instance configuration.
   * @param id The model-selected identifier already validated against the request catalog.
   */
  async function loadSkill(id: string) {
    if (!(await enabledSkills(env.DB, skillNames, defaultSkills)).includes(id)) {
      return null;
    }
    const manifest = skills.get(id);
    return manifest?.slice(manifest.indexOf("\n---\n\n") + 6) ?? null;
  }
  const sources = new Map<string, { slug: string; id: string; title: string }>();
  const docsSources: { url: string; title: string }[] = [];
  let searchedDocs = false;
  /**
   * Look up the separately entered public terms once, checking the saved policy during the call.
   */
  async function searchDocs() {
    const unavailable = { error: "Documentation search is unavailable." };
    if (searchedDocs) {
      return unavailable;
    }
    searchedDocs = true;
    if (context7) {
      const excerpt = await searchContext7(docsQuery, libraryId, () =>
        docsMcpEnabled(env.DB, true),
      );
      return excerpt ? { excerpt } : unavailable;
    }
    const hits = await searchOpenAiDocs(docsQuery, () => docsMcpEnabled(env.DB));
    if (!hits) {
      return unavailable;
    }
    docsSources.push(...hits.map(({ url, title }) => ({ url, title })));
    return { hits };
  }
  const answer = await runOpenAiAssistant(
    {
      ...config,
      history,
      context7,
      skills: skillCatalog,
      loadSkill,
      searchDocs: docsQuery ? searchDocs : undefined,
    },
    question,
    async (name, value) => {
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
    },
  );
  return json({ answer, sources: [...sources.values()], docsSources });
}

/**
 * Read a display name from the hosting platform's verified identity headers.
 * @param headers Authenticated identity headers from the Sites gateway.
 * @param email Verified account email, used only for its local part as a display fallback.
 */
function authenticatedDisplayName(headers: Headers, email?: string) {
  let name = headers.get("oai-authenticated-user-full-name") ?? "";
  if (headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
    try {
      name = decodeURIComponent(name);
    } catch {
      name = "";
    }
  }
  const fallback = email?.split("@")[0] ?? "";
  return (
    (name || fallback)
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .trim()
      .slice(0, 100) || undefined
  );
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
      const cookbook = id
        ? new Cookbook(env.DB, {
            id,
            maintainer,
            displayName: authenticatedDisplayName(request.headers, email),
          })
        : null;
      if (url.pathname === "/mcp" && request.method === "POST") {
        return await mcp(request, cookbook, env);
      }
      if (!url.pathname.startsWith("/api/")) {
        return json({ error: "Page not found." }, 404);
      }
      if (!cookbook) {
        throw new RequestError("Sign in with ChatGPT to access the cookbook.", 401);
      }
      if (
        !maintainer &&
        (openAiPaths.has(url.pathname) ||
          [mcpSettingsPath, mcpCheckPath, docsMcpPath, context7Path, skillsSettingsPath].includes(
            url.pathname,
          ))
      ) {
        throw new RequestError("Maintainer access required.", 403);
      }
      if (request.method === "GET") {
        const input = Object.fromEntries(url.searchParams);
        const filters = { ...input, tag: undefined, tags: url.searchParams.getAll("tag") };
        switch (url.pathname) {
          case "/api/settings":
            return json(await cookbook.codeSettings());
          case "/api/session":
            return json({ maintainer });
          case "/api/assistant": {
            const { configured } = await openAiStatus(env, cookbook);
            return json({
              configured,
              docsSearch: await docsMcpEnabled(env.DB),
              context7Search: await docsMcpEnabled(env.DB, true),
            });
          }
          case "/api/settings/openai":
            return json(await openAiStatus(env, cookbook));
          case "/api/settings/llm-review":
            return json(await readLlmReviewPolicy(env.DB));
          case mcpSettingsPath:
            return json({ ...(await readMcpSettings(env.DB, toolNames)), tools });
          case mcpCheckPath:
            return json({ tools: (await currentMcpTools(env.DB)).map(({ name }) => name) });
          case docsMcpPath:
            return json({ enabled: await docsMcpEnabled(env.DB) });
          case context7Path:
            return json({ enabled: await docsMcpEnabled(env.DB, true) });
          case skillsSettingsPath:
            return json({
              enabled: await enabledSkills(env.DB, skillNames, defaultSkills),
              skills: skillNames,
            });
          case "/api/skill":
            return await downloadSkill(input, cookbook);
          case "/api/assistant/models": {
            const { key } = await openAiConnection(env, cookbook, "catalog");
            return json(await fetchOpenAiModelCatalog(key));
          }
          case "/api/search":
            return json(await cookbook.search(filters));
          case "/api/tags":
            return json(await cookbook.tags(input.scope));
          case "/api/recipe":
            return json(await cookbook.get(input, input.reviewComments === "1"));
          case "/api/mine":
            return json(await cookbook.queue(filters, true));
          case "/api/queue":
            return json(await cookbook.queue(filters, false));
        }
      }
      if (request.method === "POST") {
        if (request.headers.get("origin") !== url.origin) {
          throw new RequestError("Same-origin browser request required.", 403);
        }
        if (url.pathname === "/api/settings") {
          return json(await cookbook.saveCodeSettings(await body(request)));
        }
        if (url.pathname === "/api/settings/openai") {
          return await saveOpenAi(request, env, cookbook);
        }
        if (url.pathname === "/api/settings/llm-review") {
          const policy = llmReviewPolicy(await body(request));
          const model = policy.model || (await cookbook.openAiSettings()).model || "";
          if (
            (policy.model && !isOpenAiModel(policy.model)) ||
            (policy.reasoningEffort &&
              !reasoningOptions(model).some((effort) => effort === policy.reasoningEffort))
          ) {
            throw new RequestError("Choose a valid review model and a supported reasoning effort.");
          }
          return json(await saveLlmReviewPolicy(env.DB, policy));
        }
        if (url.pathname === mcpSettingsPath) {
          return json(await saveMcpSettings(env.DB, await body(request), toolNames));
        }
        if (url.pathname === docsMcpPath) {
          return json(await saveDocsMcp(env.DB, await body(request)));
        }
        if (url.pathname === context7Path) {
          return json(await saveDocsMcp(env.DB, await body(request), true));
        }
        if (url.pathname === skillsSettingsPath) {
          return json(await saveEnabledSkills(env.DB, await body(request), skillNames));
        }
        if (url.pathname === "/api/settings/openai/remove-key") {
          await cookbook.reserveOpenAiRequest("settings");
          await cookbook.removeOpenAiKey();
          return json(await openAiStatus(env, cookbook));
        }
        if (url.pathname === "/api/assistant") {
          return await askAssistant(request, env, cookbook);
        }
        if (url.pathname === fileSuggestionPath) {
          return json(
            await cookbook.suggestFileEdit(await body(request), async (file, stored) => {
              if (!stored.credential || !isOpenAiModel(stored.model)) {
                throw new RequestError("Configure a valid OpenAI connection in Settings.", 503);
              }
              const key = await openOpenAiKey(env.SETTINGS_ENCRYPTION_KEY, stored.credential);
              return runOpenAiFileEdit(
                {
                  key,
                  model: stored.model,
                  reasoningEffort: effectiveReasoning(stored.model, stored.reasoning_effort),
                },
                file,
              );
            }),
          );
        }
        if (url.pathname === "/api/submit" || url.pathname === fileEditPath) {
          const input = await body(request);
          /** Apply current review policy to the normalized files for either submission path.
           * @param candidate The draft snapshot and any warning receipt supplied by its author.
           */
          const review: SubmissionReview = (candidate) =>
            reviewSubmission(env.DB, env.SETTINGS_ENCRYPTION_KEY, candidate);
          const result =
            url.pathname === fileEditPath
              ? await cookbook.saveFile(input, review)
              : await cookbook.submit(input, review);
          return json(result, result.editVersion > 0 ? 200 : 201);
        }
        if (url.pathname === revisionRecheckPath) {
          return json(
            await cookbook.recheckRevision(await body(request), (actor, files) =>
              reviewSavedFiles(env.DB, env.SETTINGS_ENCRYPTION_KEY, actor, files),
            ),
          );
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
      if (
        (openAiPaths.has(url.pathname) || url.pathname === fileSuggestionPath) &&
        !(
          error instanceof RequestError ||
          error instanceof JsonBodyError ||
          error instanceof OpenAiError ||
          error instanceof SettingsCryptoError
        )
      ) {
        console.error("OpenAI operation failed.");
        return json({ error: "The OpenAI operation failed. Please retry." }, 500);
      }
      return json(
        {
          error: message(error),
          code: error instanceof RequestError ? error.code : undefined,
          reviewReceipt: error instanceof RequestError ? error.receipt : undefined,
        },
        error instanceof SettingsCryptoError
          ? 503
          : error instanceof RequestError ||
              error instanceof JsonBodyError ||
              error instanceof OpenAiError
            ? error.status
            : 500,
      );
    }
  },
};
