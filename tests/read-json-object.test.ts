import assert from "node:assert/strict";
import { it } from "node:test";
import { JsonBodyError, readJsonObject } from "../src/read-json-object.ts";

/**
 * Build a synthetic POST request for the JSON parser.
 * @param body The body content used by the current test case.
 * @param type The content type advertised by the request.
 */
const request = (body: BodyInit, type = "Application/JSON; charset=utf-8") =>
  new Request("https://example.test/", { method: "POST", headers: { "content-type": type }, body });
const input = '{"city":"Tampere","word":"yö"}';
const bytes = new TextEncoder().encode(input);
assert.deepEqual(await readJsonObject(request(input), bytes.length), {
  city: "Tampere",
  word: "yö",
});
await assert.rejects(readJsonObject(request(input), bytes.length - 1), { status: 413 });
await assert.rejects(readJsonObject(request("[]"), 100), { status: 400 });
await assert.rejects(readJsonObject(request(new Uint8Array([0xff])), 100), { status: 400 });
await assert.rejects(readJsonObject(request("{}", "text/plain"), 100), { status: 415 });

const chunks = new ReadableStream<Uint8Array>({
  /**
   * Split a UTF-8 character between chunks to exercise streamed decoding.
   * @param controller The stream controller used to push and close the chunks.
   */
  start(controller) {
    const split = bytes.indexOf(0xc3) + 1;
    controller.enqueue(bytes.slice(0, split));
    controller.enqueue(bytes.slice(split));
    controller.close();
  },
});
const streamed = new Request("https://example.test/", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: chunks,
  duplex: "half",
} as RequestInit);
assert.deepEqual(await readJsonObject(streamed, bytes.length), { city: "Tampere", word: "yö" });

it("validates byte limits before consuming the body", async () => {
  for (const limit of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const input = request("{}");
    await assert.rejects(readJsonObject(input, limit), RangeError);
    assert.equal(input.bodyUsed, false);
  }
});

it("rejects a missing media type or request body", async () => {
  const input = new Request("https://example.test/");
  await assert.rejects(readJsonObject(input, 10), { status: 415 });
  const { headers } = request("{}");
  await assert.rejects(readJsonObject({ headers, body: null }, 10), {
    name: "JsonBodyError",
    message: "Request body required.",
    status: 400,
  });
});

it("does not consume a stream already locked by another reader", async () => {
  const input = request("{}");
  assert.ok(input.body);
  const reader = input.body.getReader();
  try {
    await assert.rejects(readJsonObject(input, 10), { message: "Request body is unavailable." });
    assert.equal(new TextDecoder().decode((await reader.read()).value), "{}");
  } finally {
    reader.releaseLock();
  }
});

it("releases the reader and preserves the byte limit error when cancellation fails", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    /**
     * Supply an oversized body and keep the stream open for cancellation.
     * @param controller Stream controller that enqueues the input.
     */
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },

    /**
     * Emulate a transport that fails during cancellation.
     * @throws {Error} Always, to verify the parser preserves its original failure.
     */
    cancel() {
      cancelled = true;
      throw new Error("Transport cancellation failed.");
    },
  });
  const { headers } = request("{}");
  await assert.rejects(
    readJsonObject({ headers, body }, 1),
    new JsonBodyError("Request exceeds 1 bytes.", 413),
  );
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

it("rejects malformed JSON and an incomplete UTF-8 sequence", async () => {
  for (const value of ["{", new Uint8Array([0xc3])]) {
    const input = request(value);
    await assert.rejects(readJsonObject(input, 10), { message: "Invalid JSON body." });
    assert.equal(input.body?.locked, false);
  }
});
