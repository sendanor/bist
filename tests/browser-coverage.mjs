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
  /**
   * Close the dialog and notify the same listeners as the browser.
   * @param value Optional result recorded by an explicit dialog action.
   */
  dialogs.close = function (value) {
    if (value !== undefined) {
      this.returnValue = value;
    }
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
 * Return one controlled reply to exercise a browser error without altering the fixture database.
 * @param window Browser window making the API call.
 * @param resource Exact same-origin API resource to replace once.
 * @param response Synthetic response for the chosen request.
 */
function replyOnce(window, resource, response) {
  const fetch = window.fetch;
  /**
   * Intercept the selected request and immediately restore regular transport.
   * @param path Resource requested by the UI.
   * @param options Original request method, body and signal.
   */
  window.fetch = (path, options) => {
    if (path === resource) {
      window.fetch = fetch;
      return Promise.resolve(response);
    }
    return fetch(path, options);
  };
}

/**
 * Verify the Assistant reports startup errors and offers configuration after retrying.
 * @param window Maintainer's existing settings window.
 */
async function verifyAssistantStartup(window) {
  const { document } = window;
  const panel = document.querySelector("#assistant-panel");
  replyOnce(
    window,
    "/api/assistant",
    Response.json({ error: "Fixture assistant startup failed." }, { status: 503 }),
  );
  document.querySelector("#assistant-toggle").click();
  await eventually(
    () => panel.textContent.includes("Fixture assistant startup failed."),
    "assistant startup failed gracefully",
  );
  replyOnce(window, "/api/assistant", Response.json({ configured: false }));
  clickText(panel, "button", "Retry");
  await eventually(
    () => panel.querySelector("#assistant-view a")?.getAttribute("href") === "/settings/openai",
    "assistant offered OpenAI configuration",
  );
  document.querySelector("#assistant-close").click();
}

/**
 * Check Assistant exchanges, reference fields, failure recovery and retained panel state.
 * @param window Maintainer's application window.
 */
async function verifyAssistant(window) {
  const { document } = window;
  const fetch = window.fetch;
  const sent = [];
  /**
   * Supply repeatable Assistant replies while forwarding other application traffic.
   * @param path API resource requested by the browser.
   * @param options Request method and serialized draft fields.
   */
  window.fetch = (path, options) => {
    if (path !== "/api/assistant") {
      return fetch(path, options);
    }
    if (!options?.method) {
      return Promise.resolve(
        Response.json({ configured: true, docsSearch: true, context7Search: true }),
      );
    }
    const request = JSON.parse(options.body);
    sent.push(request);
    if (sent.length === 2) {
      return Promise.resolve(
        Response.json({ error: "Assistant is temporarily unavailable." }, { status: 503 }),
      );
    }
    return Promise.resolve(
      Response.json({
        answer: sent.length === 1 ? "This is the first reply." : "This is the follow-up.",
        sources:
          sent.length === 1
            ? [
                {
                  slug: "assistant-reference-fixture",
                  id: "00000000-0000-4000-8000-000000000031",
                  title: "Fixture recipe reference",
                },
              ]
            : [],
        docsSources:
          sent.length === 1
            ? [{ url: "https://example.test/reference", title: "Fixture documentation" }]
            : [],
      }),
    );
  };
  try {
    const panel = document.querySelector("#assistant-panel");
    const toggle = document.querySelector("#assistant-toggle");
    toggle.click();
    await eventually(() => Boolean(panel.querySelector("form")), "Assistant composer opened");
    const form = panel.querySelector("form");
    form.elements.question.value = "  ";
    form.requestSubmit();
    assert.equal(sent.length, 0);
    clickText(form, "button", "Search documentation");
    form.elements.docsQuery.value = "Article structure";
    form.elements.libraryId.value = "/fixture/library";
    form.elements.question.value = "Give one example.";
    form.requestSubmit();
    await eventually(
      () => Boolean(panel.querySelector('a[href="https://example.test/reference"]')),
      "rendered reference link",
    );
    const recipeLink = panel.querySelector(
      'a[href^="/recipe/library/assistant-reference-fixture/"]',
    );
    assert.equal(recipeLink.textContent, "Fixture recipe reference");
    assert.equal(sent[0].docsQuery, "Article structure");
    assert.equal(sent[0].libraryId, "/fixture/library");
    assert.deepEqual(sent[0].history, []);
    clickText(form, "button", "Search documentation");
    form.elements.question.value = "Give another example.";
    form.requestSubmit();
    await eventually(
      () => form.textContent.includes("Assistant is temporarily unavailable."),
      "Assistant error shown",
    );
    assert.equal(form.elements.question.value, "Give another example.");
    assert.equal(sent[1].docsQuery, undefined);
    assert.deepEqual(sent[1].history, [
      { role: "user", content: "Give one example." },
      { role: "assistant", content: "This is the first reply." },
    ]);
    form.requestSubmit();
    await eventually(
      () => panel.textContent.includes("This is the follow-up."),
      "successful retry",
    );
    const handle = document.querySelector("#assistant-resize");
    const workspace = panel.parentElement;
    Object.defineProperty(workspace, "clientWidth", { value: 1_000 });
    /** Supply the right edge of the layout-free workspace for pointer resizing. */
    workspace.getBoundingClientRect = () => ({ right: 1_000 });
    let captured;
    /**
     * Record pointer capture requested by the resize handle in the synthetic DOM.
     * @param pointerId Active pointer identifier provided by the browser.
     */
    handle.setPointerCapture = (pointerId) => {
      captured = pointerId;
    };
    /**
     * Simulate the browser checking ownership before acting on a pointer move.
     * @param pointerId Identifier of the pointer trying to change the width.
     */
    handle.hasPointerCapture = (pointerId) => captured === pointerId;
    const drag = new window.MouseEvent("pointermove", { clientX: 525 });
    Object.defineProperty(drag, "pointerId", { value: 1 });
    handle.dispatchEvent(drag);
    assert.equal(workspace.style.getPropertyValue("--assistant-width"), "");
    const start = new window.MouseEvent("pointerdown", { button: 0, cancelable: true });
    Object.defineProperty(start, "pointerId", { value: 1 });
    handle.dispatchEvent(start);
    assert.equal(start.defaultPrevented, true);
    handle.dispatchEvent(drag);
    assert.equal(workspace.style.getPropertyValue("--assistant-width"), "475px");
    assert.equal(handle.getAttribute("aria-valuenow"), "475");
    /** Supply the rendered width before keyboard resizing. */
    panel.getBoundingClientRect = () => ({ width: 475 });
    handle.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    assert.equal(workspace.style.getPropertyValue("--assistant-width"), "451px");
    handle.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
    );
    assert.equal(workspace.style.getPropertyValue("--assistant-width"), "499px");
    form.elements.question.value = "A draft that survives closing.";
    panel.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(panel.hidden, true);
    toggle.click();
    assert.equal(form.elements.question.value, "A draft that survives closing.");
    assert.match(panel.textContent, /This is the follow-up/u);
    document.querySelector("#assistant-close").click();
  } finally {
    window.fetch = fetch;
  }
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
  replyOnce(
    window,
    "/api/tags?scope=review",
    Response.json({ error: "Tag suggestions unavailable." }, { status: 503 }),
  );
  document.querySelector('nav a[href="/review"]').click();
  await eventually(
    () => document.querySelector("#view h1")?.textContent === "Review queue",
    "review queue loaded without tag suggestions",
  );
  assert.ok(document.querySelector(".recipe"));
  assert.ok(document.querySelector('input[name="query"]'));
  document.querySelector('nav a[href="/library"]').click();
  await eventually(
    () => document.querySelector("#view h1")?.textContent === "Recipe library",
    "returned to library after a failed suggestion request",
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
  const entry = form.elements.tagEntry;
  const suggestions = form.querySelector(".recipe-tags select");
  assert.ok(suggestions.querySelector('option[value="paging"]'));
  suggestions.value = "paging";
  suggestions.dispatchEvent(new window.Event("change", { bubbles: true }));
  const paging = form.querySelector('button[aria-label="Remove tag paging"]');
  assert.ok(paging);
  assert.equal(suggestions.value, "");
  assert.equal(suggestions.querySelector('option[value="paging"]').disabled, true);
  paging.click();
  assert.equal(suggestions.querySelector('option[value="paging"]').disabled, false);
  entry.value = "one,two,three,four,five,six,seven,eight,nine";
  clickText(form, "button", "Add tags");
  assert.match(entry.validationMessage, /eight tags/u);
  assert.equal(form.querySelector('[aria-label="Remove tag nine"]'), null);
  entry.value = "a".repeat(33);
  entry.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(entry.validity.valid, true);
  clickText(form, "button", "Add tags");
  assert.equal(entry.validity.valid, false);
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
  const markdown =
    "# Browser draft\n\nKeep the original sentence.\n\n<b>Literal HTML</b>\n\n" +
    "![Diagram](https://example.test/diagram.png)\n\n" +
    "[Public reference](https://example.test/guide) and [local reference](./guide.md).\n\n" +
    "| Action | Result |\n| --- | --- |\n| Save | Pending |";
  form.elements.documentation.value = markdown;
  form.elements["filename-documentation"].value = "guide.exe";
  form.requestSubmit();
  await eventually(
    () => document.querySelector("#notice").textContent.includes("supported extension"),
    "invalid custom filename feedback",
  );
  assert.equal(window.location.pathname, "/contribute");
  assert.equal(form.elements.documentation.value, markdown);
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
 * Reopen an existing draft in the full form and replace the same revision.
 * @param window Contributor's current draft page.
 */
async function verifyDraftReplacement(window) {
  const { document } = window;
  const draftPath = window.location.pathname;
  document.querySelector(".revision-trigger").click();
  clickText(document.querySelector(".revision-menu"), "a", "Edit draft");
  await eventually(
    () => document.querySelector("#view h1")?.textContent === "Edit draft",
    "opened full draft editor",
  );
  const form = document.querySelector("form.form");
  assert.equal(form.elements.slug.readOnly, true);
  assert.equal(form.elements["filename-documentation"].value, "GUIDE.md");
  form.elements.title.value = "Verify a renamed draft";
  form.requestSubmit();
  await eventually(
    () => document.querySelector("#view h1")?.textContent === "Verify a renamed draft",
    "updated in place",
  );
  assert.equal(window.location.pathname, draftPath);
  assert.match(
    document.querySelector("#notice").textContent,
    /Draft updated and submitted for review/u,
  );
}

/**
 * Verify the document viewer preserves raw text and reports clipboard failures accurately.
 * @param window Author's loaded draft page.
 */
async function verifyDocumentDisplay(window) {
  const section = window.document.querySelector(
    'section[aria-labelledby="recipe-part-title-documentation"]',
  );
  const copy = section.querySelector('button[aria-label="Copy Markdown"]');
  copy.click();
  const status = section.querySelector(".copy-status");
  await eventually(() => status.textContent.includes("Copy unavailable"), "clipboard fallback");
  let written;
  Object.defineProperty(window.navigator, "clipboard", {
    value: {
      /**
       * Read clipboard text without accessing the host clipboard.
       * @param value Markdown selected for copying.
       */
      async writeText(value) {
        written = value;
      },
    },
  });
  copy.click();
  await eventually(() => status.textContent === "Copied", "successful clipboard feedback");
  assert.match(written, /^# Browser draft\n\n/u);
  section.querySelector('button[aria-label="Markdown source"]').click();
  const wrap = section.querySelector('button[aria-label="Wrap lines"]');
  assert.equal(wrap.hidden, false);
  wrap.click();
  assert.equal(wrap.getAttribute("aria-pressed"), "false");
  section.querySelector('button[aria-label="Rendered Markdown"]').click();
  assert.equal(wrap.hidden, true);
  assert.equal(
    section.querySelector("#recipe-part-content-documentation h4").textContent,
    "Browser draft",
  );
  const prose = section.querySelector(".recipe-prose");
  assert.match(prose.textContent, /<b>Literal HTML<\/b>/u);
  assert.match(prose.textContent, /Diagram/u);
  assert.equal(prose.querySelector("img, b"), null);
  const [external, local] = prose.querySelectorAll("a");
  assert.equal(external.href, "https://example.test/guide");
  assert.equal(external.target, "_blank");
  assert.equal(external.rel, "noopener noreferrer");
  assert.equal(local.textContent, "local reference");
  assert.equal(local.hasAttribute("href"), false);
  const table = prose.querySelector('[role="region"]');
  assert.ok(table.getAttribute("aria-label"));
  assert.equal(table.tabIndex, 0);
  assert.equal(table.querySelector("tbody td:last-child").textContent, "Pending");
}

/**
 * Save both whole-file and line-specific feedback via the maintainer recipe viewer.
 * @param window Maintainer's initialized recipe page.
 */
async function verifyReviewerComments(window) {
  const section = window.document.querySelector(
    'section[aria-labelledby="recipe-part-title-documentation"]',
  );
  const open = section.querySelector('button[aria-label="Comment on file"]');
  open.click();
  const wholeFile = section.querySelector(".review-comment-form");
  open.click();
  assert.equal(section.querySelectorAll(".review-comment-form").length, 1);
  assert.equal(window.document.activeElement, wholeFile.elements.body);
  wholeFile.elements.body.value = "  ";
  wholeFile.requestSubmit();
  assert.equal(wholeFile.elements.body.value, "");
  clickText(wholeFile, "button", "Cancel");
  assert.equal(wholeFile.isConnected, false);
  open.click();
  const replacement = section.querySelector(".review-comment-form");
  const fetch = window.fetch;
  /**
   * Exercise the comment composer after one temporary save failure.
   * @param path API resource requested by the reviewer.
   * @param options Original comment request.
   */
  window.fetch = (path, options) =>
    path === "/api/comment"
      ? Promise.resolve(Response.json({ error: "Fixture comment save delayed." }, { status: 503 }))
      : fetch(path, options);
  try {
    replacement.elements.body.value = "Browser fixture whole-file feedback.";
    replacement.requestSubmit();
    await eventually(
      () =>
        replacement.querySelector('[role="alert"]').textContent === "Fixture comment save delayed.",
      "failed comment preserved",
    );
    assert.equal(replacement.elements.body.value, "Browser fixture whole-file feedback.");
  } finally {
    window.fetch = fetch;
  }
  replacement.requestSubmit();
  await eventually(() => !replacement.isConnected, "whole-file comment saved");
  assert.match(section.textContent, /Browser fixture whole-file feedback/u);
  section.querySelector('button[aria-label="Markdown source"]').click();
  const line = section.querySelector('button[aria-label="Comment on line 1"]');
  const lineText = line.closest(".code-line").querySelector("code");
  const selection = window.getSelection();
  const text = lineText.firstChild;
  selection.setBaseAndExtent(text, 0, text, text.length);
  assert.equal(selection.isCollapsed, false);
  lineText.click();
  assert.equal(section.querySelector(".review-comment-form"), null);
  selection.removeAllRanges();
  lineText.click();
  const comment = section.querySelector(".review-comment-form");
  comment.elements.body.value = "Browser fixture feedback for the first line.";
  comment.requestSubmit();
  await eventually(() => !comment.isConnected, "line comment saved");
  assert.match(section.textContent, /Browser fixture feedback for the first line/u);
  assert.match(section.textContent, /Maija Mäkinen/u);
}

/**
 * Apply an advisory result in the open recipe without losing the current browser view.
 * @param window Maintainer's current review page.
 */
async function verifyRecheckFeedback(window) {
  const { document } = window;
  const fetch = window.fetch;
  const reports = [
    {
      checkedParts: ["documentation"],
      warnings: [{ part: "documentation", reason: "Describe the input." }],
    },
    { checkedParts: [], warnings: [] },
  ];
  const pending = Promise.withResolvers();
  /**
   * Replay recheck responses while forwarding ordinary API calls unchanged.
   * @param path API resource requested by the browser.
   * @param options Request method and body.
   */
  window.fetch = (path, options) => {
    if (path !== "/api/review/recheck") {
      return fetch(path, options);
    }
    const report = reports.shift();
    if (reports.length === 1) {
      return pending.promise;
    }
    return Promise.resolve(Response.json({ ...report, savedWarnings: report.warnings }));
  };
  try {
    const recheck = document.querySelector(".revision-recheck");
    const docs = document.querySelector(
      'section[aria-labelledby="recipe-part-title-documentation"]',
    );
    for (const pattern of [/Review warnings appear/u, /None of this revision/u]) {
      document.querySelector(".revision-trigger").click();
      clickText(document.querySelector(".revision-menu"), "button", "Re-run LLM review");
      if (reports.length === 1) {
        document.querySelector(".revision-trigger").click();
        clickText(document.querySelector(".revision-menu"), "button", "Re-run LLM review");
        assert.equal(reports.length, 1, "second click must not start another check");
        const findings = [{ part: "documentation", reason: "Describe the input." }];
        pending.resolve(
          Response.json({
            checkedParts: ["documentation"],
            warnings: findings,
            savedWarnings: findings,
          }),
        );
      }
      await eventually(() => pattern.test(recheck.textContent), "recheck summary updated");
      const warning = docs.querySelector(".file-warnings");
      assert.equal(warning.hidden, reports.length === 0);
      if (!warning.hidden) {
        assert.equal(warning.textContent, "Describe the input.");
      }
      clickText(recheck, "button", "Dismiss recheck summary");
    }
  } finally {
    window.fetch = fetch;
  }
}

/**
 * Propose a revision from the published recipe, acknowledge its expected duplicate warning,
 * and inspect the comparison before returning to the published page.
 * @param window Maintainer's published recipe page.
 */
async function verifyProposalComparison(window) {
  const { document } = window;
  const published = window.location.pathname;
  document.querySelector(".revision-trigger").click();
  clickText(document.querySelector(".revision-menu"), "a", "Propose an improvement");
  await eventually(
    () => document.querySelector("#view h1")?.textContent === "Improve recipe",
    "prefilled improvement form",
  );
  const form = document.querySelector("form.form");
  assert.ok(form.elements.documentation.value);
  form.elements.documentation.value =
    "# Comparison guide\n\nA new usage example for the proposed revision.";
  form.elements.instructions.value = "";
  const submit = form.querySelector("[type=submit]");
  form.requestSubmit();
  await eventually(
    () => Boolean(document.querySelector('dialog[aria-labelledby="submission-warning-heading"]')),
    "duplicate code acknowledgement required",
  );
  clickText(document.querySelector("dialog"), "button", "Cancel");
  await eventually(
    () => document.activeElement === submit && !submit.disabled,
    "cancelled acknowledgement restores the form",
  );
  assert.match(window.location.pathname, /^\/improve\//u);
  assert.match(form.elements.documentation.value, /A new usage example/u);
  form.requestSubmit();
  await eventually(() => document.querySelector("dialog")?.open, "duplicate warning reopened");
  clickText(document.querySelector("dialog"), "button", "Submit anyway");
  await eventually(
    () =>
      window.location.pathname.startsWith("/recipe/mine/") &&
      document
        .querySelector("#recipe-part-content-documentation")
        ?.textContent.includes("A new usage example"),
    "proposed draft saved",
  );
  const docs = document.querySelector('section[aria-labelledby="recipe-part-title-documentation"]');
  const navigation = document.querySelector(".recipe-contents");
  const documentation = [...navigation.querySelectorAll("button")].find(
    (button) => button.firstChild.textContent === "Documentation",
  );
  assert.ok(documentation);
  documentation.click();
  assert.equal(document.activeElement.id, "recipe-part-title-documentation");
  docs.querySelector('button[aria-label="Show changes"]').click();
  assert.match(docs.textContent, /Compared with base revision/u);
  assert.match(docs.textContent, /A new usage example/u);
  docs.querySelector('button[aria-label="Show file"]').click();
  assert.equal(docs.querySelector("h4").textContent, "Comparison guide");
  const oldInstructions = document.querySelector("#recipe-part-content-instructions");
  assert.match(oldInstructions.textContent, /omits this file/u);
  const instructions = oldInstructions.closest(".recipe-part");
  instructions.querySelector('button[aria-label="Show changes"]').click();
  assert.ok(oldInstructions.querySelector(".diff-removed"));
  const source = document.querySelector('section[aria-labelledby="recipe-part-title-source"]');
  source.querySelector('button[aria-label="Show changes"]').click();
  assert.match(source.textContent, /unchanged/u);
  window.history.go(-2);
  await eventually(
    () =>
      window.location.pathname === published &&
      document.querySelector(".recipe-byline .state-published"),
    "back to published recipe",
  );
}

/**
 * Exercise review actions and verify publication and quarantine against the fixture database.
 * @param window Maintainer's window showing a pending test revision.
 * @param dispatch Authenticated test transport to verify visibility after a review decision.
 * @param draft Revision whose state is changed.
 */
async function verifyReviewDecisions(window, dispatch, draft) {
  const { document } = window;
  /** Read the current revision status after each rerender. */
  const byline = () => document.querySelector(".recipe-byline");

  /**
   * Select an action from the real revision toolbar.
   * @param label Visible action label.
   */
  function choose(label) {
    document.querySelector(".revision-trigger").click();
    clickText(document.querySelector(".revision-menu"), "button", label);
  }
  choose("Re-run LLM review");
  const recheck = document.querySelector(".revision-recheck");
  await eventually(
    () => recheck.querySelector(".revision-action-error")?.textContent.includes("off"),
    "recheck explains disabled policy",
  );
  clickText(recheck, "button", "Dismiss recheck summary");
  assert.equal(recheck.hidden, true);
  await verifyRecheckFeedback(window);
  choose("Request changes");
  const reconsider = document.querySelector('dialog[aria-labelledby="revision-action-heading"]');
  assert.equal(reconsider.querySelector("textarea").required, true);
  clickText(reconsider, "button", "Cancel");
  assert.ok(!reconsider.isConnected);
  choose("Approve revision");
  const approval = document.querySelector("dialog form");
  const reason = approval.elements.reason;
  reason.value = "Verified in the browser fixture.";
  replyOnce(
    window,
    "/api/action",
    Response.json({ error: "Approval temporarily unavailable." }, { status: 503 }),
  );
  approval.requestSubmit();
  const cancelDuringSave = new window.Event("cancel", { cancelable: true });
  approval.closest("dialog").dispatchEvent(cancelDuringSave);
  assert.equal(cancelDuringSave.defaultPrevented, true);
  await eventually(
    () =>
      approval.querySelector('[role="alert"]').textContent === "Approval temporarily unavailable.",
    "approval failure shown in the open dialog",
  );
  assert.equal(reason.readOnly, false);
  assert.equal(reason.value, "Verified in the browser fixture.");
  approval.requestSubmit();
  await eventually(() => byline()?.querySelector(".state-approved"), "approval shown");
  choose("Publish approved revision");
  document.querySelector("dialog form").requestSubmit();
  await eventually(() => byline()?.querySelector(".state-published"), "publication shown");
  const query = new URLSearchParams({ slug: draft.slug });
  assert.equal((await dispatch("/api/recipe?" + query, "reader")).status, 200);
  await verifyProposalComparison(window);
  choose("Quarantine");
  const form = document.querySelector("dialog form");
  form.elements.reason.value = "  ";
  form.requestSubmit();
  assert.equal(form.elements.reason.value, "");
  form.elements.reason.value = "Quarantine the disposable browser fixture.";
  form.requestSubmit();
  await eventually(() => byline()?.querySelector(".state-quarantined"), "quarantine shown");
  assert.equal((await dispatch("/api/recipe?" + query, "reader")).status, 404);
}

/**
 * Save valid formatting preferences and recover from an invalid ESLint edit.
 * @param window Maintainer's code policy page.
 * @param dispatch Authenticated transport to verify the saved policy.
 */
async function verifyCodePolicy(window, dispatch) {
  const form = window.document.querySelector(".code-settings");
  const search = form.querySelector('input[type="search"]');
  search.value = "eqeqeq";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(form.querySelector(".rule-matches").textContent, "eqeqeq");
  const original = form.elements.eslint.value;
  form.elements.eslint.value = '{"unexpected":true}';
  form.requestSubmit();
  const status = form.querySelector('[role="status"]');
  assert.match(status.textContent, /Unsupported ESLint configuration field unexpected/u);
  form.elements.eslint.value = original;
  form.elements.printWidth.value = "92";
  form.elements.tabWidth.value = "4";
  form.elements.duplicateCode.value = "warn";
  form.requestSubmit();
  await eventually(() => status.textContent === "Code policy saved.", "saved code policy");
  const { policy } = await (await dispatch("/api/settings", "maintainer")).json();
  assert.equal(policy.prettier.printWidth, 92);
  assert.equal(policy.prettier.tabWidth, 4);
  assert.equal(policy.quality.duplicateCode, "warn");
}

/**
 * Save a restricted tool list and toggle Assistant add-ons using the live Worker routes.
 * @param window Maintainer's MCP settings page.
 * @param dispatch Authenticated transport to verify tool discovery and persisted switches.
 */
async function verifyMcpSettings(window, dispatch) {
  const { document } = window;
  const form = document.querySelector("#view form");
  const status = form.querySelector('[role="status"]');
  const enabled = form.elements.enabled;
  replyOnce(
    window,
    "/api/settings/mcp/check",
    Response.json({ error: "Fixture tool discovery interrupted." }, { status: 503 }),
  );
  clickText(form, "button", "Check tool list");
  await eventually(
    () => status.textContent === "Could not check the MCP tool list.",
    "tool discovery failed gracefully",
  );
  enabled.checked = false;
  replyOnce(
    window,
    "/api/settings/mcp",
    Response.json({ error: "Fixture MCP save interrupted." }, { status: 503 }),
  );
  form.requestSubmit();
  await eventually(
    () => status.textContent === "Fixture MCP save interrupted.",
    "tool configuration failure shown",
  );
  assert.equal(enabled.checked, false);
  form.requestSubmit();
  await eventually(() => status.textContent === "MCP settings saved.", "saved paused MCP instance");
  clickText(form, "button", "Check tool list");
  await eventually(
    () => status.textContent === "No MCP tools are available.",
    "paused tool discovery",
  );
  enabled.checked = true;
  for (const tool of form.querySelectorAll('input[name="enabledTool"]')) {
    tool.checked = tool.value === "search_recipes";
  }
  form.requestSubmit();
  await eventually(() => status.textContent === "MCP settings saved.", "saved limited tool list");
  clickText(form, "button", "Check tool list");
  await eventually(
    () => status.textContent === "The MCP tool list is available.",
    "enabled tool discovery",
  );
  const tools = await (await dispatch("/api/settings/mcp/check", "maintainer")).json();
  assert.deepEqual(tools.tools, ["search_recipes"]);
  const fields = document.querySelector(".assistant-add-ons");
  for (const [name, path] of [
    ["Context7", "context7"],
    ["OpenAI Docs", "openai-docs"],
  ]) {
    const addOn = [...fields.querySelectorAll("label")].find(
      (row) => row.querySelector("strong").textContent === name,
    );
    const checkbox = addOn.querySelector("input");
    const saved = checkbox.checked;
    replyOnce(
      window,
      "/api/settings/mcp/" + path,
      Response.json({ error: "Fixture add-on was unavailable." }, { status: 503 }),
    );
    checkbox.click();
    await eventually(
      () => !fields.disabled && checkbox.checked === saved,
      "failed add-on switch restored",
    );
    for (const expected of [!checkbox.checked, checkbox.checked]) {
      checkbox.click();
      await eventually(() => !fields.disabled, "saved " + name);
      const state = await (await dispatch("/api/settings/mcp/" + path, "maintainer")).json();
      assert.equal(state.enabled, expected);
    }
  }
  const skills = await (await dispatch("/api/settings/mcp/skills", "maintainer")).json();
  const skill = fields.querySelector("input");
  assert.equal(skill.checked, skills.enabled.includes(skills.skills[0]));
  skill.click();
  await eventually(() => !fields.disabled, "updated a built-in skill");
  const updated = await (await dispatch("/api/settings/mcp/skills", "maintainer")).json();
  assert.equal(updated.enabled.includes(skills.skills[0]), skill.checked);
  skill.click();
  await eventually(() => !fields.disabled, "restored the built-in skill");
  const restored = await (await dispatch("/api/settings/mcp/skills", "maintainer")).json();
  assert.equal(
    restored.enabled.includes(skills.skills[0]),
    skills.enabled.includes(skills.skills[0]),
  );
}

/**
 * Switch model and reasoning effort, then remove and restore the disposable test credential.
 * @param window Maintainer's OpenAI settings page.
 * @param dispatch Authenticated transport to verify the saved connection metadata.
 * @param key Synthetic lookup credential accepted by the provider fixture.
 */
async function verifyOpenAiSettings(window, dispatch, key) {
  const { document } = window;
  const credential = document.querySelector('input[name="apiKey"]');
  const keyForm = credential.form;
  const keyStatus = keyForm.querySelector('[role="status"]');
  const model = document.querySelector('select[name="model"]');
  const modelStatus = model.form.querySelector('[role="status"]');
  const reasoning = model.form.elements.reasoningEffort;
  assert.equal(credential.value, "");
  await eventually(() => !model.disabled, "catalog populated");
  for (const [reply, explanation] of [
    [Response.json({ status: "unauthorized", models: [] }), "This API key cannot list models."],
    [Response.json({ status: "unavailable", models: [] }), "Could not load the model catalog."],
    [
      Response.json({ error: "Fixture catalog gateway unavailable." }, { status: 503 }),
      "Fixture catalog gateway unavailable.",
    ],
    [
      Response.json({ status: "ready", models: ["other-fixture-model"] }),
      "The configured model is missing",
    ],
  ]) {
    replyOnce(window, "/api/assistant/models", reply);
    clickText(model.form, "button", "Refresh models");
    await eventually(() => modelStatus.textContent.includes(explanation), explanation);
    assert.equal(model.value, "");
  }
  clickText(model.form, "button", "Refresh models");
  await eventually(() => !model.disabled, "catalog refreshed");
  model.form.requestSubmit();
  assert.equal(modelStatus.textContent, "");
  model.value = "gpt-6-luna";
  model.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.ok([...reasoning.options].some((option) => option.value === "none"));
  reasoning.value = "none";
  reasoning.dispatchEvent(new window.Event("change", { bubbles: true }));
  replyOnce(
    window,
    "/api/settings/openai",
    Response.json({ error: "Fixture model save interrupted." }, { status: 503 }),
  );
  model.form.requestSubmit();
  await eventually(
    () => modelStatus.textContent === "Fixture model save interrupted.",
    "model save failure shown",
  );
  assert.equal(model.value, "gpt-6-luna");
  assert.equal(reasoning.value, "none");
  model.form.requestSubmit();
  await eventually(
    () => modelStatus.textContent === "OpenAI model saved.",
    "saved conversation model",
  );
  const settings = await (await dispatch("/api/settings/openai", "maintainer")).json();
  assert.equal(settings.model, "gpt-6-luna");
  assert.equal(settings.reasoningEffort, "none");
  credential.value = "!";
  keyForm.requestSubmit();
  await eventually(
    () => keyStatus.textContent.includes("valid OpenAI API key"),
    "invalid key response",
  );
  assert.equal(credential.value, "");
  clickText(keyForm, "button", "Remove API key");
  clickText(keyForm, "button", "Cancel");
  assert.match(keyStatus.textContent, /valid OpenAI API key/u);
  clickText(keyForm, "button", "Remove API key");
  replyOnce(
    window,
    "/api/settings/openai/remove-key",
    Response.json({ error: "Fixture key removal interrupted." }, { status: 503 }),
  );
  clickText(keyForm, "button", "Confirm removal");
  await eventually(
    () => keyStatus.textContent === "Fixture key removal interrupted.",
    "credential removal failure shown",
  );
  assert.equal(
    (await (await dispatch("/api/settings/openai", "maintainer")).json()).hasCredential,
    true,
  );
  clickText(keyForm, "button", "Confirm removal");
  await eventually(() => keyStatus.textContent === "OpenAI API key removed.", "cleared credential");
  assert.equal(model.disabled, true);
  assert.equal(modelStatus.textContent, "Save an API key to load the model list.");
  credential.value = key;
  keyForm.requestSubmit();
  await eventually(
    () => keyStatus.textContent === "OpenAI settings saved." && !model.disabled,
    "restored synthetic credential",
  );
  assert.equal(credential.value, "");
  assert.equal(model.value, "gpt-6-luna");
  assert.equal(reasoning.value, "none");
}

/**
 * Configure a review rule and verify the saved model, reasoning and file criteria.
 * @param window Maintainer's LLM review settings page.
 * @param dispatch Authenticated transport for the stored policy.
 */
async function verifyReviewSettings(window, dispatch) {
  const { document } = window;
  const model = document.querySelector('input[name="model"]');
  const form = model.form;
  model.value = "gpt-6.2-sol";
  model.dispatchEvent(new window.Event("input", { bubbles: true }));
  form.querySelector("select").value = "high";
  const docs = [...form.querySelectorAll("fieldset")].find(
    (group) => group.querySelector("legend").textContent === "Documentation",
  );
  docs.querySelector("select").value = "warn";
  docs.querySelector("textarea").value = " Check whether examples identify their input. ";
  form.elements.referenceLibraryId.value = "/fixture/ui";
  form.requestSubmit();
  await eventually(
    () => form.querySelector('[role="status"]').textContent.includes("exact Context7 library ID"),
    "invalid reference configuration explained",
  );
  assert.equal(
    docs.querySelector("textarea").value.trim(),
    "Check whether examples identify their input.",
  );
  form.elements.referenceLibraryId.value = "";
  form.requestSubmit();
  await eventually(
    () => form.querySelector('[role="status"]').textContent === "Review settings saved.",
    "saved review rules",
  );
  const policy = await (await dispatch("/api/settings/llm-review", "maintainer")).json();
  assert.equal(policy.model, "gpt-6.2-sol");
  assert.equal(policy.reasoningEffort, "high");
  assert.deepEqual(policy.rules.documentation, {
    mode: "warn",
    instruction: "Check whether examples identify their input.",
  });
}

/**
 * Navigate to the queue and exercise the maintainer's individual settings pages.
 * @param window Maintainer's initialized test window.
 * @param dispatch Authenticated transport to verify persisted settings.
 * @param key Synthetic provider credential from the integration environment.
 */
async function verifyMaintainerNavigation(window, dispatch, key) {
  const { document } = window;
  assert.equal(document.querySelector("#view h1")?.textContent, "Recipe library");
  const pages = [
    ["/review", "Review queue"],
    ["/settings", "Settings"],
    ["/settings/llm-review", "LLM review", verifyReviewSettings],
    ["/settings/openai", "OpenAI", verifyOpenAiSettings],
    ["/settings/code-policy", "Code policy", verifyCodePolicy],
    ["/settings/mcp", "MCP", verifyMcpSettings],
  ];
  for (const [path, heading, verify] of pages) {
    document.querySelector('nav a[href="' + path + '"]').click();
    assert.equal(window.location.pathname, path);
    await eventually(() => document.querySelector("#view h1")?.textContent === heading, heading);
    await verify?.(window, dispatch, key);
  }
  document.querySelector('nav a[href="/settings/openai"]').click();
  await eventually(
    () => document.querySelector('select[name="model"]')?.value === "gpt-6-luna",
    "restored saved model on returning to OpenAI settings",
  );
  assert.equal(document.querySelector('select[name="reasoningEffort"]').value, "none");
  assert.equal(document.querySelector('input[name="apiKey"]').value, "");
  document.querySelector('nav a[href="/settings/mcp"]').click();
  await eventually(
    () => document.querySelector("#view h1")?.textContent === "MCP",
    "reopened MCP settings",
  );
  const checked = [...document.querySelectorAll('input[name="enabledTool"]:checked')];
  assert.deepEqual(
    checked.map((tool) => tool.value),
    ["search_recipes"],
  );
}

/**
 * Keep legacy links readable and redirect anonymous visitors back to their intended page.
 * @param dispatch Test transport to the disposable Worker.
 * @param directory Run directory containing browser coverage results.
 */
async function verifySignedOutNavigation(dispatch, directory) {
  const window = await openPage(dispatch, "/?query=fixture#library", null);
  try {
    const { document, location } = window;
    assert.equal(location.pathname, "/library");
    assert.equal(location.hash, "");
    assert.equal(location.search, "?query=fixture");
    const signin = document.querySelector('#view a[href^="/signin-with-chatgpt?"]');
    assert.equal(signin.textContent, "Sign in with ChatGPT");
    assert.equal(new URL(signin.href).searchParams.get("returnTo"), "/library?query=fixture");
    document.querySelector(".skip").click();
    assert.equal(document.activeElement.id, "content");
    await writeFile(join(directory, "browser-anonymous.json"), JSON.stringify(window.__coverage__));
  } finally {
    window.close();
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
 * Keep the working copy when a save fails or the author supersedes a model request.
 * @param window Author's opened recipe window after a successful file edit.
 */
async function verifyEditorRecovery(window) {
  const { document } = window;
  const fetch = window.fetch;
  const failedSuggestion = Promise.withResolvers();
  const staleSuggestion = Promise.withResolvers();
  const failedSave = Promise.withResolvers();
  const signals = [];
  let saves = 0;
  const receipt = "00000000-0000-4000-8000-000000000010";
  /**
   * Delay responses so intermediate editor states and concurrency can be asserted.
   * @param path API resource being requested.
   * @param options Request options, including the model request cancellation signal.
   */
  window.fetch = (path, options) => {
    if (path === "/api/recipe/file/suggest") {
      signals.push(options.signal);
      if (signals.length === 3) {
        return Promise.resolve(Response.json({ content: JSON.parse(options.body).content }));
      }
      return (signals.length === 1 ? failedSuggestion : staleSuggestion).promise;
    }
    if (path === "/api/recipe/file") {
      saves++;
      if (saves === 1) {
        return failedSave.promise;
      }
      if (saves === 2) {
        return Promise.resolve(
          Response.json(
            { error: "Duplicate recipe fixture.", code: "duplicate_warning" },
            { status: 409 },
          ),
        );
      }
      const submitted = JSON.parse(options.body);
      if (!submitted.reviewReceipt) {
        return Promise.resolve(
          Response.json(
            {
              error: "Fixture: explain the expected output.",
              code: "llm_warning",
              reviewReceipt: receipt,
            },
            { status: 409 },
          ),
        );
      }
      assert.equal(submitted.reviewReceipt, receipt);
    }
    return fetch(path, options);
  };
  try {
    const section = document.querySelector(
      'section[aria-labelledby="recipe-part-title-documentation"]',
    );
    section.querySelector('button[aria-label="Edit file"]').click();
    const dialog = document.querySelector("dialog.file-editor");
    const input = dialog.querySelector("textarea.code-input");
    const instruction = dialog.querySelector(".file-edit-assist textarea");
    const status = dialog.querySelector('[role="status"]');
    instruction.value = "Improve the draft.";
    instruction.dispatchEvent(new window.Event("input", { bubbles: true }));
    clickText(dialog, "button", "Suggest edit");
    assert.equal(signals[0].aborted, false);
    failedSuggestion.resolve(
      Response.json({ error: "Provider temporarily unavailable." }, { status: 503 }),
    );
    await eventually(
      () => status.textContent === "Provider temporarily unavailable.",
      "suggestion error shown",
    );

    clickText(dialog, "button", "Suggest edit");
    const manual = input.value + "\nPreserve this newer working copy.";
    input.value = manual;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(signals[1].aborted, true);
    staleSuggestion.resolve(
      Response.json({ content: "Outdated proposal that must not replace the manual edit." }),
    );
    await setTimeout(0);
    assert.equal(input.value, manual);

    clickText(dialog, "button", "Suggest edit");
    await eventually(
      () => status.textContent.includes("unchanged"),
      "identical model output shown as unchanged",
    );
    assert.equal(input.value, manual);
    const save = dialog.querySelector("button.primary");
    save.click();
    const escape = new window.Event("cancel", { cancelable: true });
    dialog.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(input.readOnly, true);
    failedSave.resolve(Response.json({ error: "Draft version changed." }, { status: 409 }));
    await eventually(
      () => status.textContent === "Draft version changed." && !save.disabled,
      "reload conflict shown",
    );
    assert.equal(input.value, manual);
    assert.equal(input.readOnly, false);
    save.click();
    await eventually(
      () => Boolean(document.querySelector('dialog[aria-labelledby="submission-warning-heading"]')),
      "duplicate submission warning opened",
    );
    const warning = document.querySelector('dialog[aria-labelledby="submission-warning-heading"]');
    assert.match(warning.textContent, /Duplicate recipe fixture/u);
    clickText(warning, "button", "Cancel");
    await eventually(() => !save.disabled, "cancelled submission returns to the editor");
    assert.equal(input.value, manual);
    assert.equal(dialog.dispatchEvent(new window.Event("cancel", { cancelable: true })), true);
    const warningSelector = 'dialog[aria-labelledby="submission-warning-heading"]';
    save.click();
    await eventually(
      () => document.querySelector(warningSelector)?.textContent.includes("expected output"),
      "received LLM review warning",
    );
    clickText(document.querySelector(warningSelector), "button", "Cancel");
    await eventually(() => !save.disabled, "declined LLM warning and kept text");
    assert.equal(input.value, manual);
    save.click();
    await eventually(
      () => Boolean(document.querySelector(warningSelector)),
      "warning presented again",
    );
    clickText(document.querySelector(warningSelector), "button", "Submit anyway");
    await eventually(
      () =>
        !dialog.isConnected &&
        document
          .querySelector("#recipe-part-content-documentation")
          ?.textContent.includes("Preserve this newer working copy."),
      "approved warning carried on successful retry",
    );
  } finally {
    window.fetch = fetch;
  }
}

/**
 * Remove a disposable draft from the author view and verify the server no longer exposes it.
 * @param window Browser with the test draft open.
 * @param dispatch Integration transport for checking the removed revision.
 */
async function verifyAuthorRemoval(window, dispatch) {
  const { document } = window;
  const [, , , slug, revision] = window.location.pathname.split("/");
  document.querySelector(".revision-trigger").click();
  document
    .querySelector(".revision-controls")
    .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(document.querySelector(".revision-menu").hidden, true);
  document.querySelector(".revision-trigger").click();
  clickText(document.querySelector(".revision-menu"), "button", "Remove draft");
  document.querySelector("dialog form").requestSubmit();
  await eventually(
    () =>
      window.location.pathname === "/mine" &&
      document.querySelector("#view h1")?.textContent === "My revisions",
    "returned to the author's list",
  );
  const params = new URLSearchParams({ slug, revision });
  assert.equal((await dispatch("/api/recipe?" + params, "browser-author")).status, 404);
}

/**
 * Exercise the real bundled UI and retain coverage from both roles.
 * @param dispatch Authenticated test transport.
 * @param directory Run-specific directory where counters are stored.
 * @param draft Selected author's draft with a documentation file.
 * @param key Synthetic provider credential already configured in the test Worker.
 */
export async function exerciseBrowser(dispatch, directory, draft, key) {
  await verifySignedOutNavigation(dispatch, directory);
  const maintainer = await openPage(dispatch, "/library", "maintainer");
  try {
    await verifyLibrarySearch(maintainer);
    await verifyMaintainerNavigation(maintainer, dispatch, key);
    await verifyAssistantStartup(maintainer);
    await verifyAssistant(maintainer);
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
    await verifyDraftReplacement(author);
    await verifyDocumentDisplay(author);
    await verifyDraftEditor(author);
    await verifyEditorRecovery(author);
    await verifyAuthorRemoval(author, dispatch);
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
    await verifyReviewDecisions(reviewer, dispatch, draft);
    await writeFile(
      join(directory, "browser-reviewer.json"),
      JSON.stringify(reviewer.__coverage__),
    );
  } finally {
    reviewer.close();
  }
}
