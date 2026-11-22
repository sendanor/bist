import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runOpenAiFileEdit } from "../src/openai-file-edit.ts";

const config = { key: "fixture-credential", model: "fixture-model" };
const file = {
  filename: "example.md",
  content: "Unsaved prose.\n",
  instruction: "Add a work step.",
};
const initial = {
  type: "function_call",
  name: "read_selected_file",
  call_id: "read",
  arguments: "{}",
};
const replacement = {
  ...initial,
  name: "replace_selected_file",
  call_id: "edit",
  arguments: '{"content":"Edited."}',
};

describe("selected-file editing tools", () => {
  it("reads the author's unsaved text and returns only a replacement from the named tool", async () => {
    let calls = 0;
    const edited = await runOpenAiFileEdit(config, file, async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      assert.equal(body.store, false);
      assert.equal(body.parallel_tool_calls, false);
      assert.deepEqual(
        body.tools.map((item: typeof initial) => item.name),
        [initial.name, replacement.name],
      );
      assert.deepEqual(body.tool_choice, {
        type: "function",
        name: calls ? replacement.name : initial.name,
      });
      if (calls++) {
        assert.equal(body.input.at(-1).call_id, initial.call_id);
        assert.deepEqual(JSON.parse(body.input.at(-1).output), {
          filename: file.filename,
          content: file.content,
        });
        assert.equal(body.input[1].encrypted_content, "opaque");
        return Response.json({ status: "completed", output: [replacement] });
      }
      assert.deepEqual(body.input, [{ role: "user", content: file.instruction }]);
      return Response.json({
        status: "completed",
        output: [{ type: "reasoning", encrypted_content: "opaque" }, initial],
      });
    });
    assert.equal(calls, 2);
    assert.equal(edited, "Edited.");
  });

  for (const [name, invalid] of Object.entries({
    "a plain-text answer": [
      { type: "message", content: [{ type: "output_text", text: "Edited." }] },
    ],
    "a different target": [{ ...replacement, arguments: '{"part":"source","content":"Other."}' }],
    "another tool": [{ ...replacement, name: "save_recipe" }],
    "parallel writes": [replacement, replacement],
    "malformed JSON": [{ ...replacement, arguments: "[" }],
    "a partial write": [{ ...replacement, status: "incomplete" }],
    "a blank replacement": [{ ...replacement, arguments: '{"content":" "}' }],
    "a multibyte file above the byte limit": [
      { ...replacement, arguments: JSON.stringify({ content: "ä".repeat(6001) }) },
    ],
  })) {
    it("rejects " + name, async () => {
      let sentRead = false;
      await assert.rejects(
        runOpenAiFileEdit(config, file, async () => {
          const output = sentRead ? invalid : [initial];
          sentRead = true;
          return Response.json({ status: "completed", output });
        }),
        { status: 502 },
      );
    });
  }

  it("withholds the working copy from a read call that targets another file", async () => {
    let calls = 0;
    await assert.rejects(
      runOpenAiFileEdit(config, file, async () => {
        calls++;
        return Response.json({
          status: "completed",
          output: [{ ...initial, arguments: '{"filename":"other.ts"}' }],
        });
      }),
      { status: 502 },
    );
    assert.equal(calls, 1);
  });
});
