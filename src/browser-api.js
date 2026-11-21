/**
 * Call the same-origin Cookbook API and surface any server validation error.
 * @param path API route relative to /api/.
 * @param data Optional JSON request body. Omit it for a GET.
 * @throws {Error} When the API rejects the request.
 */
export async function api(path, data) {
  const response = await fetch(
    "/api/" + path,
    data
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        }
      : {},
  );
  const result = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(result.error), { code: result.code });
  }
  return result;
}

/** Read the tool list from Bist's same-origin MCP endpoint without invoking a tool. */
export async function listMcpTools() {
  const response = await fetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const { result } = await response.json();
  return response.ok && Array.isArray(result?.tools) ? result.tools : null;
}
