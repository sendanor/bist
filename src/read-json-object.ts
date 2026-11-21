import { isRecord } from "./guards.ts";

export class JsonBodyError extends Error {
  readonly status: 400 | 413 | 415;
  /**
   * Construct a request body error with its HTTP response status.
   * @param message The explanation safe to show to a client.
   * @param status The client error status matching the failure.
   */
  constructor(message: string, status: 400 | 413 | 415) {
    super(message);
    this.name = "JsonBodyError";
    this.status = status;
  }
}

/** Fetch headers and body shared by incoming requests and upstream responses. */
type JsonBody = Pick<Request, "headers" | "body">;

/**
 * Read a UTF-8 JSON body within a byte limit and require an object.
 * @param request The Fetch message whose body will be consumed.
 * @param maxBytes The maximum number of encoded bytes to read.
 * @throws {RangeError} When the byte limit is not a positive safe integer.
 * @throws {JsonBodyError} When the body is missing, unreadable, oversized, invalid JSON, or has an unsupported content type.
 */
export async function readJsonObject(
  request: JsonBody,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive integer.");
  }
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new JsonBodyError("JSON content type required.", 415);
  }
  const text = await readUtf8(request.body, maxBytes);
  try {
    const result: unknown = JSON.parse(text);
    if (!isRecord(result)) {
      throw new JsonBodyError("Expected a JSON object.", 400);
    }
    return result;
  } catch (error) {
    if (error instanceof JsonBodyError) {
      throw error;
    }
    throw new JsonBodyError("Invalid JSON body.", 400);
  }
}

/**
 * Read a UTF-8 stream without accepting bytes beyond the configured limit.
 * @param body Fetch body stream, which may be absent.
 * @param maxBytes A positive byte limit chosen by the caller.
 * @throws {JsonBodyError} If the body is absent, locked, oversized, or invalid UTF-8.
 */
export async function readUtf8(body: JsonBody["body"], maxBytes: number) {
  if (!body) {
    throw new JsonBodyError("Request body required.", 400);
  }
  if (body.locked) {
    throw new JsonBodyError("Request body is unavailable.", 400);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new JsonBodyError(`Request exceeds ${maxBytes} bytes.`, 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    // Return the response even if the underlying stream takes time to cancel.
    void cancelReader(reader);
    if (error instanceof JsonBodyError) {
      throw error;
    }
    throw new JsonBodyError("Invalid JSON body.", 400);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Request best-effort cancellation without replacing the original parse failure.
 * @param reader The stream reader whose pending work should stop.
 */
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    await reader.cancel();
  } catch {
    // The original parse error remains the useful result.
  }
}
