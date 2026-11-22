import assert from "node:assert/strict";

const path = "/api/recipe/file";
const suggest = path + "/suggest";
const actor = "file-author";
let beforeReplacement;
let toolCalls = 0;

/**
 * Emulate the two editing tools, using the actual working copy passed by the Worker.
 * @param body Responses request from the authorized file editor.
 */
export async function editToolFixture(body) {
  toolCalls++;
  const name = body.tool_choice.name;
  let args = {};
  if (name === "replace_selected_file") {
    const read = JSON.parse(body.input.at(-1).output);
    assert.deepEqual(Object.keys(read).sort(), ["content", "filename"]);
    const suffix = /\.(md|txt)$/u.test(read.filename)
      ? "Run the checks."
      : "/* File edit verified. */";
    args = { content: read.content + "\n" + suffix + "\n" };
    await beforeReplacement?.();
  } else {
    assert.equal(name, "read_selected_file");
  }
  return Response.json({
    status: "completed",
    output: [{ type: "function_call", name, call_id: name, arguments: JSON.stringify(args) }],
  });
}

/**
 * Create an editable documentation-only recipe with a second file and custom names.
 * @param dispatch Local Worker request transport using fixture identities.
 * @param slug Unique slug for this scenario.
 */
async function draftTarget(dispatch, slug) {
  const saved = await dispatch("/api/submit", actor, {
    slug,
    title: "Editing a recipe file",
    tags: ["editing"],
    summary: "Exercise scoped file edits.",
    files: {
      documentation: "Initial text for " + slug + ".",
      instructions: "Keep the " + slug + " agent instructions.",
    },
    fileNames: { documentation: "GUIDE.md", instructions: "AGENT.md" },
  });
  assert.equal(saved.status, 201);
  const { id: revision, editVersion } = await saved.json();
  return {
    slug,
    revision,
    editVersion,
    part: "documentation",
    content: "Unsaved work for " + slug + ".",
    instruction: "Add the next step.",
  };
}

/**
 * Verify ownership, scoped suggestions, warning-aware saves and optimistic concurrency via HTTP.
 * @param dispatch Authenticated Worker request transport.
 * @param rule Existing synthetic submission policy for the review provider.
 */
export async function verifyFileEditor(dispatch, rule) {
  const target = await draftTarget(dispatch, "edit-one-file");
  const detail =
    "/api/recipe?" + new URLSearchParams({ slug: target.slug, revision: target.revision });
  const original = await (await dispatch(detail, actor)).json();
  for (const route of [path, suggest]) {
    for (const [user, status] of [
      [null, 401],
      ["reader", 404],
      ["maintainer", 403],
    ]) {
      assert.equal((await dispatch(route, user, target)).status, status);
    }
    for (const [overrides, status] of [
      [{ part: "source" }, 400],
      [{ editVersion: 9 }, 409],
      [{ revision: "" }, 400],
      [{ content: "ä".repeat(6001) }, 400],
    ]) {
      assert.equal((await dispatch(route, actor, { ...target, ...overrides })).status, status);
    }
  }
  assert.equal(toolCalls, 0);
  const preview = await dispatch(suggest, actor, target);
  assert.equal(preview.status, 200);
  const { content } = await preview.json();
  assert.equal(content, target.content + "\nRun the checks.\n");
  assert.equal(toolCalls, 2);
  assert.deepEqual(await (await dispatch(detail, actor)).json(), original);
  const settings = "/api/settings/llm-review";
  assert.equal((await dispatch(settings, "maintainer", rule)).status, 200);
  const save = {
    ...target,
    content,
    title: "Ignored",
    fileNames: {},
    files: { instructions: "Ignored" },
  };
  const warned = await dispatch(path, actor, save);
  assert.equal(warned.status, 409);
  const { code, reviewReceipt } = await warned.json();
  assert.equal(code, "llm_warning");
  const foreignReplace = await dispatch("/api/submit", "maintainer", {
    slug: target.slug,
    title: original.title,
    summary: original.summary,
    replace: target.revision,
    editVersion: target.editVersion,
    files: { documentation: "Unapproved change." },
  });
  assert.equal(foreignReplace.status, 409);
  assert.equal((await foreignReplace.json()).reviewReceipt, undefined);
  assert.equal((await (await dispatch(detail, actor)).json()).editVersion, target.editVersion);
  const accepted = await dispatch(path, actor, { ...save, reviewReceipt });
  assert.equal(accepted.status, 200);
  const current = await (await dispatch(detail, actor)).json();
  assert.equal(current.id, original.id);
  assert.equal(current.editVersion, target.editVersion + 1);
  assert.equal(current.files.instructions, original.files.instructions);
  assert.equal(current.files.documentation.trim(), content.trim());
  assert.equal(current.llmWarnings[0].part, target.part);
  for (const key of ["tags", "title", "fileNames", "summary"]) {
    assert.deepEqual(current[key], original[key]);
  }
  assert.equal((await dispatch(path, actor, save)).status, 409);
  assert.equal((await dispatch(settings, "maintainer", { ...rule, enabled: false })).status, 200);
  const working = { ...target, editVersion: current.editVersion };
  /** Save the author's manual change while the provider is still preparing its proposal. */
  beforeReplacement = async () => {
    assert.equal(
      (await dispatch(path, actor, { ...working, content: "Simultaneous manual edit." })).status,
      200,
    );
  };
  try {
    assert.equal((await dispatch(suggest, actor, working)).status, 409);
  } finally {
    beforeReplacement = undefined;
  }
  const latest = await (await dispatch(detail, actor)).json();
  assert.equal(latest.files.documentation.trim(), "Simultaneous manual edit.");
  const readOnly = { ...target, editVersion: latest.editVersion };
  assert.equal(
    (await dispatch("/api/action", "maintainer", { ...readOnly, action: "approve" })).status,
    200,
  );
  for (const route of [path, suggest]) {
    assert.equal((await dispatch(route, actor, readOnly)).status, 403);
  }
  assert.equal(toolCalls, 4);
}

/**
 * Exercise the editor's read, stage and save paths for all six custom-named file categories.
 * @param dispatch Authenticated transport to the Worker.
 * @param tool Access the stored revision through the installed MCP protocol fixture.
 * @param target Existing six-file draft owned by the fixture author.
 */
export async function verifyFileKinds(dispatch, tool, target) {
  let recipe = await tool("get_recipe", target);
  const parts = Object.keys(recipe.files);
  assert.equal(parts.length, 6);
  for (const part of parts) {
    const edit = {
      ...target,
      part,
      editVersion: recipe.editVersion,
      content: recipe.files[part],
      instruction: "Append a check reminder.",
    };
    const response = await dispatch(suggest, "author", edit);
    assert.equal(response.status, 200);
    const proposal = await response.json();
    assert.equal(proposal.part, part);
    assert.ok(proposal.content.startsWith(edit.content));
    assert.equal(
      (await dispatch(path, "author", { ...edit, content: proposal.content })).status,
      200,
    );
    const updated = await tool("get_recipe", target);
    assert.equal(updated.editVersion, edit.editVersion + 1);
    assert.notEqual(updated.files[part], recipe.files[part]);
    assert.deepEqual(updated.fileNames, recipe.fileNames);
    for (const other of parts.filter((name) => name !== part)) {
      assert.equal(updated.files[other], recipe.files[other]);
    }
    recipe = updated;
  }
}

/**
 * Check manual editing without a provider and prevent writes while removal is pending.
 * @param dispatch Worker transport after removing the fixture provider key.
 */
export async function verifyOfflineFileEditor(dispatch) {
  const target = await draftTarget(dispatch, "edit-without-provider");
  assert.equal((await dispatch(suggest, actor, target)).status, 503);
  assert.equal((await dispatch(path, actor, target)).status, 200);
  const blocked = { ...target, editVersion: target.editVersion + 1 };
  assert.equal(
    (
      await dispatch("/api/action", actor, {
        ...blocked,
        action: "request_removal",
        reason: "Retire this test draft.",
      })
    ).status,
    200,
  );
  assert.equal((await dispatch(path, actor, blocked)).status, 403);
  assert.equal((await dispatch(suggest, actor, blocked)).status, 403);
}
