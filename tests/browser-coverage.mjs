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
  assert.equal(document.querySelector("dialog.file-editor textarea.code-input").value, original);
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
    await verifyMaintainerNavigation(maintainer);
    assert.ok(maintainer.__coverage__["src/browser.js"]);
    await writeFile(
      join(directory, "browser-maintainer.json"),
      JSON.stringify(maintainer.__coverage__),
    );
  } finally {
    maintainer.close();
  }
  const author = await openPage(
    dispatch,
    "/recipe/mine/" + draft.slug + "/" + draft.revision,
    "author",
  );
  try {
    await verifyDraftEditor(author);
    assert.ok(author.__coverage__["src/file-editor.js"]);
    await writeFile(join(directory, "browser-author.json"), JSON.stringify(author.__coverage__));
  } finally {
    author.close();
  }
}
