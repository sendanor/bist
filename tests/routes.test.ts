import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePagePath } from "../src/routes.ts";

const revision = "00000000-0000-4000-8000-000000000000";

describe("parsePagePath", () => {
  it("maps the root, top-level pages and settings paths", () => {
    assert.deepEqual(parsePagePath("/"), { page: "library", section: "library" });
    for (const page of ["library", "contribute", "mine", "review", "settings", "assistant"]) {
      assert.deepEqual(parsePagePath("/" + page), { page, section: page });
    }
    for (const page of ["openai", "code-policy", "mcp", "llm-review"]) {
      assert.deepEqual(parsePagePath("/settings/" + page), {
        page: "settings/" + page,
        section: "settings",
      });
    }
  });

  it("decodes a recipe slug and keeps its navigation context", () => {
    for (const section of ["library", "mine", "review"]) {
      assert.deepEqual(parsePagePath("/recipe/" + section + "/%61-b/" + revision), {
        page: "recipe",
        section,
        slug: "a-b",
        revision,
      });
    }
    for (const page of ["edit", "improve"]) {
      assert.deepEqual(parsePagePath("/" + page + "/a/" + revision), {
        page,
        section: "contribute",
        slug: "a",
        revision,
      });
    }
  });

  it("rejects malformed, unknown and unsafe paths", () => {
    for (const path of [
      "library",
      "/unknown",
      "/settings/unknown",
      "/settings/%xx",
      "/recipe/contribute/a/" + revision,
      "/recipe/library/a",
      "/recipe/library/A/" + revision,
      "/recipe/library/%2F/" + revision,
      "/edit/" + "a".repeat(65) + "/" + revision,
      "/edit/a/invalid",
      "/publish/a/" + revision,
    ]) {
      assert.equal(parsePagePath(path), null, path);
    }
  });
});
