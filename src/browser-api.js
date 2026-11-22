/**
 * Call the same-origin Cookbook API and surface any server validation error.
 * @param path API route relative to /api/.
 * @param data Optional JSON request body. Omit it for a GET.
 * @param signal Optional cancellation signal for an abandoned request.
 * @throws {Error} When the API rejects the request.
 */
export async function api(path, data, signal) {
  const response = await fetch(
    "/api/" + path,
    data
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
          signal,
        }
      : { signal },
  );
  const result = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(result.error), {
      code: result.code,
      reviewReceipt: result.reviewReceipt,
    });
  }
  return result;
}
