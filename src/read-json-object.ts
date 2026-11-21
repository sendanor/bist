import { isRecord } from "./guards.ts";

export class JsonBodyError extends Error {
  readonly status: 400 | 413 | 415;
  constructor(message: string, status: 400 | 413 | 415) {
    super(message);
    this.name = "JsonBodyError";
    this.status = status;
  }
}

export async function readJsonObject(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive integer.");
  }
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new JsonBodyError("JSON content type required.", 415);
  }
  if (!request.body) {
    throw new JsonBodyError("JSON body required.", 400);
  }
  if (request.body.locked) {
    throw new JsonBodyError("Request body is unavailable.", 400);
  }

  const reader = request.body.getReader();
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
    const result: unknown = JSON.parse(text + decoder.decode());
    if (!isRecord(result)) {
      throw new JsonBodyError("Expected a JSON object.", 400);
    }
    return result;
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

/** Request best-effort cancellation without replacing the original parse failure. */
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    await reader.cancel();
  } catch {
    // The original parse error remains the useful result.
  }
}
