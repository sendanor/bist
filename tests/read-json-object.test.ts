import assert from "node:assert/strict";
import { readJsonObject } from "../src/read-json-object.ts";

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
