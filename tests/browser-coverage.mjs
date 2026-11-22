import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { JSDOM } from "jsdom";

/**
 * Wait for an asynchronous route transition or a closed dialog.
 * @param predicate The expected condition in the test DOM.
 * @param label Diagnostic label for the assertion.
 */
async function eventually(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) {
    await setTimeout(20);
  }
  assert.ok(predicate(), label);
}

/**
 * Open the built application against the same authenticated Worker as the API integration tests.
 * @param dispatch HTTP transport using synthetic Site identities.
 * @param path Application route to serve.
 * @param user Fixture identity used for the page and subsequent requests.
 */
async function openPage(dispatch, path, user) {
  const page = await dispatch(path, user);
  assert.equal(page.status, 200);
  const script = await dispatch("/browser.js", user);
  assert.equal(script.status, 200);
  const { window } = new JSDOM(await page.text(), {
    url: "https://cookbook.local" + path,
    runScripts: "outside-only",
  });
  window.TextEncoder = TextEncoder;
  /**
   * Forward app requests to the fixture Worker.
   * @param path Request URL provided by the browser bundle.
   * @param options Optional method and JSON request body.
   */
  window.fetch = (path, options) => dispatch(path, user, options?.body && JSON.parse(options.body));
  /** Simulate scroll restoration in the layout-free DOM. */
  window.scrollTo = () => {};
  /** Simulate a section navigation scroll without layout. */
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const dialogs = window.HTMLDialogElement.prototype;
  /** Open the dialog in jsdom, which lacks native modal management. */
  dialogs.showModal = function () {
    this.open = true;
  };
  /** Close the dialog and notify the same listeners as the browser. */
  dialogs.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event("close"));
  };
  await window.eval("(async () => {\n" + (await script.text()) + "\n})()");
  return window;
}

/**
 * Click an action with its exact displayed text.
 * @param parent Document or region that contains the action.
 * @param selector Selectable action elements.
 * @param label The visible action text.
 */
function clickText(parent, selector, label) {
  const action = [...parent.querySelectorAll(selector)].find(
    (element) => !element.hidden && element.textContent.trim() === label,
  );
  assert.ok(action, label);
  action.click();
}

/**
 * Check review queue pagination and exact tag filtering in the library.
 * @param window Maintainer's library page with published paging fixtures.
 */
async function verifyLibrarySearch(window) {
  const { document } = window;
  document.querySelector('nav a[href="/review"]').click();
  await eventually(
    () => document.querySelector("#view h1")?.textContent === "Review queue",
    "opened review queue",
  );
  const status = document.querySelector('select[name="state"]');
  status.value = "pending";
  status.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(new URLSearchParams(window.location.search).get("state"), "pending");
  await eventually(
    () => document.querySelector('select[name="state"]') !== status,
    "pending queue loaded",
  );
  clickText(document, ".list-pagination a", "Next page");
  await eventually(
    () => document.querySelector(".list-pagination a")?.textContent === "Previous page",
    "second library page",
  );
  clickText(document, ".list-pagination a", "Previous page");
  await eventually(
    () => document.querySelector(".list-pagination a")?.textContent === "Next page",
    "first library page",
  );
  document.querySelector('nav a[href="/library"]').click();
  await eventually(
    () => document.querySelector("#view h1")?.textContent === "Recipe library",
    "opened recipe library",
  );
  const query = document.querySelector('input[name="query"]');
  query.value = 'paging keyword tag:paging tag:"public-only"';
  query.dispatchEvent(new window.Event("input", { bubbles: true }));
  query.form.requestSubmit();
  assert.deepEqual(new URLSearchParams(window.location.search).getAll("tag"), [
    "paging",
    "public-only",
  ]);
  await eventually(
    () => document.querySelectorAll(".recipe").length === 1,
    "only the published fixture matches",
  );
  document.querySelector('input[name="query"]').value = "intentionally absent cookbook phrase";
  document.querySelector("form.search").requestSubmit();
  await eventually(
    () =>
      !document.querySelector(".recipe") &&
      Boolean(document.querySelector(".list-filter-actions a")),
    "no results with active filters",
  );
  clickText(document, ".list-filter-actions a", "Show all recipes");
  await eventually(
    () =>
      Boolean(document.querySelector(".recipe")) &&
      !document.querySelector(".list-filter-actions a"),
    "unfiltered results",
  );
}

/**
 * Submit Markdown-only content with a custom filename and normalized tags.
 * @param window Contributor's initialized page.
 */
async function verifyContribution(window) {
  const { document } = window;
  const form = document.querySelector("form.form");
  clickText(form, "button", "Fill with example");
  assert.equal(form.elements.slug.value, "batch-items");
  form.elements.tagEntry.value = "a".repeat(33);
  clickText(form, "button", "Add tags");
  assert.equal(form.elements.tagEntry.validity.valid, false);
  form.querySelector('button[aria-label="Remove tag arrays"]').click();
  form.elements.tagEntry.value = " VALIDATION, validation, ";
  form.elements.tagEntry.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  assert.equal(form.querySelectorAll('button[aria-label="Remove tag validation"]').length, 1);
  for (const part of ["source", "interface", "tests", "styles", "instructions"]) {
    form.elements[part].value = "";
  }
  form.elements.slug.value = "browser-verify-draft";
  form.elements.title.value = "Verify a draft in the browser";
  form.elements.summary.value = "Check the complete read and write workflow.";
  form.elements.documentation.value = "# Browser draft\n\nKeep the original sentence.";
  form.elements["filename-documentation"].value = "GUIDE.md";
  form.requestSubmit();
  await eventually(
    () =>
      document.querySelector("#recipe-part-title-documentation")?.textContent.includes("GUIDE.md"),
    "saved contribution",
  );
  assert.match(window.location.pathname, /^\/recipe\/mine\/browser-verify-draft\//u);
  assert.match(
    document.querySelector("#recipe-part-content-documentation").textContent,
    /Keep the original sentence/u,
  );
}

/**
 * Save both whole-file and line-specific feedback via the maintainer recipe viewer.
 * @param window Maintainer's initialized recipe page.
 */
async function verifyReviewerComments(window) {
  const section = window.document.querySelector(
    'section[aria-labelledby="recipe-part-title-documentation"]',
  );
  section.querySelector('button[aria-label="Comment on file"]').click();
  const wholeFile = section.querySelector(".review-comment-form");
  wholeFile.elements.body.value = "Browser fixture whole-file feedback.";
  wholeFile.requestSubmit();
  await eventually(() => !wholeFile.isConnected, "whole-file comment saved");
  assert.match(section.textContent, /Browser fixture whole-file feedback/u);
  section.querySelector('button[aria-label="Markdown source"]').click();
  const line = section.querySelector('button[aria-label="Comment on line 1"]');
  line.closest(".code-line").querySelector("code").click();
  const comment = section.querySelector(".review-comment-form");
  comment.elements.body.value = "Browser fixture feedback for the first line.";
  comment.requestSubmit();
  await eventually(() => !comment.isConnected, "line comment saved");
  assert.match(section.textContent, /Browser fixture feedback for the first line/u);
  assert.match(section.textContent, /Maija Mäkinen/u);
}

/**
 * Navigate to the queue and the maintainer's separate settings pages.
 * @param window Maintainer's initialized test window.
 */
async function verifyMaintainerNavigation(window) {
  const { document } = window;
  assert.equal(document.querySelector("#view h1")?.textContent, "Recipe library");
  const pages = [
    ["/review", "Review queue"],
    ["/settings", "Settings"],
    ["/settings/openai", "OpenAI"],
    ["/settings/code-policy", "Code policy"],
    ["/settings/mcp", "MCP"],
    ["/settings/llm-review", "LLM review"],
  ];
  for (const [path, heading] of pages) {
    document.querySelector('nav a[href="' + path + '"]').click();
    assert.equal(window.location.pathname, path);
    await eventually(() => document.querySelector("#view h1")?.textContent === heading, heading);
  }
}

/**
 * Edit the README in a draft, inspect its diff and discard that working copy.
 * @param window Author's initialized recipe test window.
 */
async function verifyDraftEditor(window) {
  const { document } = window;
  assert.equal(document.querySelector('nav a[href="/review"]').hidden, true);
  const section = document.querySelector(
    'section[aria-labelledby="recipe-part-title-documentation"]',
  );
  assert.ok(section);
  const edit = section.querySelector('button[aria-label="Edit file"]');
  assert.ok(edit);
  edit.click();
  const dialog = document.querySelector("dialog.file-editor");
  assert.ok(dialog.open);
  const content = dialog.querySelector("textarea.code-input");
  const original = content.value;
  const amended = original + "\nA change that remains local until saved.\n";
  content.value = amended;
  content.dispatchEvent(new window.Event("input", { bubbles: true }));
  const save = dialog.querySelector("button.primary");
  assert.equal(save.disabled, false);
  const compare = dialog.querySelector('button[aria-pressed="false"]');
  compare.click();
  assert.match(dialog.textContent, /Compared with saved file/u);
  assert.match(dialog.textContent, /A change that remains local until saved/u);
  [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Cancel").click();
  await eventually(() => !dialog.isConnected, "file editor closes");
  edit.click();
  const reopened = document.querySelector("dialog.file-editor");
  const input = reopened.querySelector("textarea.code-input");
  assert.equal(input.value, original);
  input.value = "ä".repeat(6_001);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(reopened.querySelector("button.primary").disabled, true);
  assert.match(reopened.textContent, /at most 12 KB/u);
  input.value = original;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  const instruction = reopened.querySelector(".file-edit-assist textarea");
  instruction.value = "Append a reminder to run the checks.";
  instruction.dispatchEvent(new window.Event("input", { bubbles: true }));
  clickText(reopened, "button", "Suggest edit");
  await eventually(
    () => input.value.includes("Run the checks."),
    "provider proposal applied to the editor",
  );
  clickText(reopened, "button", "Show changes");
  assert.match(reopened.textContent, /Run the checks/u);
  clickText(reopened, "button", "Edit text");
  reopened.querySelector("button.primary").click();
  await eventually(
    () =>
      !reopened.isConnected &&
      document
        .querySelector("#recipe-part-content-documentation")
        ?.textContent.includes("Run the checks."),
    "proposal saved on the same revision",
  );
}

/**
 * Exercise the real bundled UI and retain coverage from both roles.
 * @param dispatch Authenticated test transport.
 * @param directory Run-specific directory where counters are stored.
 * @param draft Selected author's draft with a documentation file.
 */
export async function exerciseBrowser(dispatch, directory, draft) {
  const maintainer = await openPage(dispatch, "/library", "maintainer");
  try {
    await verifyLibrarySearch(maintainer);
    await verifyMaintainerNavigation(maintainer);
    assert.ok(maintainer.__coverage__["src/browser.js"]);
    await writeFile(
      join(directory, "browser-maintainer.json"),
      JSON.stringify(maintainer.__coverage__),
    );
  } finally {
    maintainer.close();
  }
  const author = await openPage(dispatch, "/contribute", "browser-author");
  try {
    await verifyContribution(author);
    await verifyDraftEditor(author);
    assert.ok(author.__coverage__["src/file-editor.js"]);
    await writeFile(join(directory, "browser-author.json"), JSON.stringify(author.__coverage__));
  } finally {
    author.close();
  }
  const reviewer = await openPage(
    dispatch,
    "/recipe/review/" + draft.slug + "/" + draft.revision,
    "maintainer",
  );
  try {
    await verifyReviewerComments(reviewer);
    await writeFile(
      join(directory, "browser-reviewer.json"),
      JSON.stringify(reviewer.__coverage__),
    );
  } finally {
    reviewer.close();
  }
}
