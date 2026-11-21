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
    throw new Error(result.error);
  }
  return result;
}
