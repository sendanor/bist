import { isArray } from "./guards.ts";
import { RequestError, type Database, type Input } from "./store";

/** Instance-wide tool availability shared by MCP discovery and dispatch. */
interface McpSettings {
  readonly enabled: boolean;
  readonly enabledTools: readonly string[];
}

/**
 * Read MCP settings and default existing installations to their current tool catalog.
 * @param db The instance database binding.
 * @param toolNames The names supported by the current server.
 */
export async function readMcpSettings(
  db: Database,
  toolNames: readonly string[],
): Promise<McpSettings> {
  const row = await db
    .prepare("SELECT enabled, enabled_tools FROM mcp_settings WHERE id = 1")
    .first<{ enabled: number; enabled_tools: string }>();
  if (!row) {
    return { enabled: true, enabledTools: toolNames };
  }
  const stored = JSON.parse(row.enabled_tools);
  return {
    enabled: row.enabled === 1,
    enabledTools: isArray(stored) ? toolNames.filter((name) => stored.includes(name)) : [],
  };
}

/**
 * Replace the instance settings atomically after the HTTP route verifies maintainer access.
 * @param db The instance database binding.
 * @param input The untrusted settings object received from the form.
 * @param toolNames The complete list of tool names the worker accepts.
 * @throws {RequestError} When the switch or tool selection contains unsupported values.
 */
export async function saveMcpSettings(
  db: Database,
  input: Input,
  toolNames: readonly string[],
): Promise<McpSettings> {
  const { enabled, enabledTools } = input;
  if (
    typeof enabled !== "boolean" ||
    !isArray(enabledTools) ||
    enabledTools.length > toolNames.length ||
    !enabledTools.every((name) => toolNames.some((supported) => supported === name))
  ) {
    throw new RequestError("Choose supported MCP tools and an availability setting.");
  }
  const selected = toolNames.filter((name) => enabledTools.includes(name));
  await db
    .prepare(
      `INSERT INTO mcp_settings (id, enabled, enabled_tools) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, enabled_tools = excluded.enabled_tools`,
    )
    .bind(Number(enabled), JSON.stringify(selected))
    .run();
  return { enabled, enabledTools: selected };
}

/**
 * Read the assistant's independent, opt-in documentation search setting.
 * @param db The instance database binding.
 */
export async function docsMcpEnabled(db: Database) {
  const row = await db
    .prepare("SELECT enabled FROM assistant_docs_mcp WHERE id = 1")
    .first<{ enabled: number }>();
  return row?.enabled === 1;
}

/**
 * Change the documentation search setting after the route authorizes the maintainer.
 * @param db The instance database binding.
 * @param input The untrusted request containing the enabled switch.
 * @throws {RequestError} When the switch is missing or invalid.
 */
export async function saveDocsMcp(db: Database, input: Input) {
  if (typeof input.enabled !== "boolean") {
    throw new RequestError("Choose whether to enable the OpenAI Docs MCP tool.");
  }
  await db
    .prepare(
      `INSERT INTO assistant_docs_mcp (id, enabled) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`,
    )
    .bind(Number(input.enabled))
    .run();
  return { enabled: input.enabled };
}
