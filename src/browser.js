import { t } from "./localization.js";
import { api } from "./browser-api.js";
import cssLanguage from "highlight.js/lib/languages/css";
import { diffLines, sourceLines } from "./line-diff.ts";
import { marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import highlighter from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";

highlighter.registerLanguage("typescript", typescript);
highlighter.registerLanguage("css", cssLanguage);

const outlet = document.querySelector("#view");
const notice = document.querySelector("#notice");
const toolbar = document.querySelector("#revision-toolbar");
const topBar = toolbar.closest("header");
const locationLabel = document.querySelector("#location");
const revisionBack = document.querySelector("#revision-back");
const labels = {
  library: t("recipe-library"),
  contribute: t("contribute"),
  mine: t("my-revisions"),
  review: t("review-queue"),
  settings: t("settings"),
};
const parts = {
  documentation: t("documentation"),
  interface: t("public-interface"),
  source: t("source"),
  tests: t("tests"),
  styles: t("stylesheet"),
  instructions: t("agent-instructions"),
};
const stateLabels = {
  pending: t("pending-review"),
  changes: t("changes-requested"),
  approved: t("approved"),
  published: t("published"),
  quarantined: t("quarantined"),
};
let maintainer = false;
let renderId = 0;
let recentRecipe;
let filters = { query: "", tag: "" };

/**
 * Create a DOM element, apply properties, and append its children.
 * @param tag The HTML element name to create.
 * @param props The attributes and event listeners to apply.
 * @param children The ordered DOM nodes or text to append.
 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") {
      node.className = value;
    } else if (key.startsWith("on")) {
      node.addEventListener(key.slice(2), value);
    } else if (value !== undefined) {
      node.setAttribute(key, value);
    }
  }
  node.append(...children.filter((child) => child != null && child !== false));
  return node;
}
/**
 * Create the decorative icon for a named toolbar action.
 * @param name The key of the icon in the toolbar glyph set.
 */
function icon(name) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("class", "ui-icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(namespace, "use");
  use.setAttribute("href", "#icon-" + name);
  svg.append(use);
  return svg;
}
/**
 * Create a status banner with the appropriate feedback role.
 * @param message The status message shown to the reader.
 * @param error Whether the banner should announce an error.
 * @param revisionFeedback Whether to mark the banner as revision feedback.
 */
function banner(message = "", error = false, revisionFeedback = false) {
  notice.textContent = message;
  notice.classList.toggle("error", error);
  notice.classList.toggle("revision-feedback", revisionFeedback);
}
/**
 * Make a button that invokes a supplied click handler.
 * @param text The visible label on the button.
 * @param fn The click listener to register.
 * @param style The optional visual style class.
 */
function btn(text, fn, style = "") {
  return el("button", { type: "button", className: style, onclick: fn }, text);
}
/**
 * Make a link styled as an application button.
 * @param text The visible label on the link.
 * @param href The destination URL for the action.
 * @param style The optional visual style class.
 */
function buttonLink(text, href, style = "") {
  return el("a", { href, className: "button " + style }, text);
}
/**
 * Build a labelled control for a form field.
 * @param name The form key used for submission.
 * @param title The label shown above the control.
 * @param options The extra attributes to apply to the input.
 * @param value The initial control value.
 * @param textarea Whether the field accepts multiline content.
 */
function field(name, title, options = {}, value = "", textarea = false) {
  const control = el(textarea ? "textarea" : "input", { name, ...options });
  control.value = value;
  return el("label", {}, title, control);
}
/**
 * Create a page heading with optional help text.
 * @param text The main heading text.
 * @param detail The optional explanation below the heading.
 */
function title(text, detail) {
  return el("div", {}, el("h1", {}, text), detail && el("p", { className: "muted" }, detail));
}
/**
 * Build a link to a particular revision in its browsing context.
 * @param recipe The summary containing the recipe slug and revision ID.
 * @param section The navigation section to return to from the recipe.
 */
function routeRecipe(recipe, section) {
  return (
    "#recipe/" +
    section +
    "/" +
    encodeURIComponent(recipe.slug) +
    "/" +
    encodeURIComponent(recipe.id)
  );
}
/**
 * Create an empty-state message with an optional next action.
 * @param titleText The short heading shown in the empty state.
 * @param detail The explanatory text displayed below it.
 * @param action The optional action that helps the user proceed.
 */
function empty(titleText, detail, action) {
  return el(
    "div",
    { className: "panel empty" },
    el("div", { className: "empty-icon", "aria-hidden": true }, "{ }"),
    el("h3", {}, titleText),
    el("p", { className: "muted" }, detail),
    action,
  );
}
/**
 * Render a compact tag or status label.
 * @param text The text displayed inside the label.
 * @param style The optional style for a particular status.
 */
function chip(text, style = "") {
  return el("span", { className: "chip " + style }, text);
}
/**
 * Render links for a list of recipe revision summaries.
 * @param rows The ordered revision summaries to display.
 * @param section The navigation section providing the back-link context.
 */
function list(rows, section) {
  return el(
    "div",
    { className: "list" },
    ...rows.map((row) =>
      el(
        "article",
        { className: "panel recipe" },
        el("h3", {}, el("a", { href: routeRecipe(row, section) }, row.title)),
        el("p", { className: "muted" }, row.summary),
        chip(stateLabels[row.state] ?? row.state, "state-" + row.state),
        row.removal_reason && chip("Removal requested"),
        ...row.tags.map((tag) => chip(tag)),
      ),
    ),
  );
}
/** Load the published recipe list and build its search controls. */
async function library() {
  const rows = await api("search?" + new URLSearchParams(filters));
  const form = el(
    "form",
    {
      className: "search",
      /**
       * Apply the search query and reload the visible recipe list.
       * @param event The form submission event to intercept.
       */
      onsubmit: (event) => {
        event.preventDefault();
        filters = Object.fromEntries(new FormData(event.currentTarget));
        render();
      },
    },
    field(
      "query",
      t("search-recipes"),
      { placeholder: t("search-by-purpose-or-keyword"), maxlength: 160 },
      filters.query,
    ),
    field("tag", t("tag"), { placeholder: t("e-g-utilities"), maxlength: 32 }, filters.tag),
    el("button", { className: "primary" }, t("search")),
  );
  return [
    el(
      "section",
      { className: "hero" },
      el("h1", {}, t("recipe-library")),
      el("p", {}, t("find-recipes-and-guides")),
    ),
    form,
    el("h2", {}, filters.query || filters.tag ? t("search-results") : t("published-recipes")),
    rows.length
      ? list(rows, "library")
      : filters.query || filters.tag
        ? empty(
            t("no-matching-recipes"),
            t("try-a-broader-keyword-or-clear-the-tag"),
            btn(t("clear-filters"), () => {
              filters = { query: "", tag: "" };
              render();
            }),
          )
        : empty(
            t("no-published-recipes-yet"),
            t("submit-a-recipe-for-review-to-start-your"),
            buttonLink(t("contribute-a-recipe"), "#contribute"),
          ),
  ];
}
const example = {
  slug: "batch-items",
  title: t("batch-items-into-chunks"),
  summary: "Split a list into fixed-size batches, with a shorter final batch when needed.",
  tags: ["arrays", "utilities"],
  files: {
    source: `/**
 * Copy values into consecutive batches without mutating the input.
 * @param items Values to partition in their original order.
 * @param size Maximum number of values per batch.
 * @throws {RangeError} When size is not a positive safe integer.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError("size must be a positive integer");
  }
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
}
`,
    interface: `/**
 * Split the input into ordered batches without changing the original list.
 * @param items Values to partition in their original order.
 * @param size Maximum number of values per batch.
 */
export declare function chunk<T>(items: readonly T[], size: number): T[][];
`,
    tests: `import { chunk } from "./source.js";
const actual = JSON.stringify(chunk([1, 2, 3], 2));
if (actual !== "[[1,2],[3]]") {
  throw new Error("Expected a final batch with one item");
}
`,
    documentation:
      "Use chunk(items, size) when a caller needs fixed-size slices, for example before processing a list in batches. The input array is preserved.",
    instructions: "Save the implementation as source.ts and adapt the test import to your project.",
  },
};
/**
 * Ask whether to save a submission that matched an existing recipe's content.
 * @param message Duplicate findings returned by the server.
 */
function confirmDuplicate(message) {
  return new Promise((resolve) => {
    const cancel = btn(t("cancel"), () => dialog.close());
    const proceed = btn(t("submit-anyway"), () => dialog.close("continue"), "primary");
    const dialog = el(
      "dialog",
      { className: "revision-dialog", "aria-labelledby": "duplicate-heading" },
      el("h2", { id: "duplicate-heading" }, t("duplicate-content")),
      el("p", { className: "duplicate-message" }, message),
      el("div", { className: "revision-dialog-buttons" }, cancel, proceed),
    );
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        resolve(dialog.returnValue === "continue");
      },
      { once: true },
    );
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

/**
 * Submit a recipe and retry only if the author accepts any duplicate warning.
 * @param payload Complete recipe snapshot read from the submission form.
 */
async function submitWithDuplicateCheck(payload) {
  try {
    return await api("submit", payload);
  } catch (error) {
    if (error.code !== "duplicate_warning") {
      throw error;
    }
    if (await confirmDuplicate(error.message)) {
      return api("submit", { ...payload, allowDuplicates: true });
    }
    return null;
  }
}

/**
 * Build the form for creating, editing, or proposing a recipe revision.
 * @param recipe The optional revision used to prefill the form.
 * @param replace Whether to update the existing draft in place.
 */
function contribute(recipe, replace = false) {
  const isRevision = Boolean(recipe?.id);
  const form = el(
    "form",
    {
      className: "panel form",
      /**
       * Collect the contribution fields and submit the selected revision operation.
       * @param event The browser submit event to handle without navigation.
       */
      onsubmit: async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        const submit = form.querySelector("[type=submit]");
        submit.disabled = true;
        banner();
        try {
          const result = await submitWithDuplicateCheck({
            slug: data.slug,
            title: data.title,
            summary: data.summary,
            ...(replace
              ? { replace: recipe.id, editVersion: recipe.editVersion }
              : { base: recipe?.id }),
            tags: data.tags
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
            files: Object.fromEntries(
              Object.keys(parts)
                .filter((part) => data[part].trim())
                .map((part) => [part, data[part]]),
            ),
          });
          if (!result) {
            submit.disabled = false;
            submit.focus();
            return;
          }
          banner(
            [
              replace ? t("draft-resubmitted-for-review") : t("revision-submitted-for-review"),
              ...(result.warnings ?? []),
            ].join("\n"),
          );
          location.hash = routeRecipe(result, "mine");
        } catch (error) {
          banner(error.message, true);
        } finally {
          submit.disabled = false;
        }
      },
    },
    el(
      "div",
      { className: "pair" },
      field("title", t("title"), { required: "", maxlength: 100 }, recipe?.title),
      field(
        "slug",
        t("recipe-slug"),
        {
          required: "",
          maxlength: 64,
          pattern: "[a-z0-9]+(-[a-z0-9]+)*",
          readonly: isRevision ? "" : undefined,
          placeholder: t("batch-items"),
        },
        recipe?.slug,
      ),
    ),
    field(
      "summary",
      t("what-does-this-recipe-do"),
      { required: "", maxlength: 300 },
      recipe?.summary,
    ),
    field(
      "tags",
      t("tags-separated-by-commas"),
      { placeholder: t("arrays-utilities"), maxlength: 280 },
      recipe?.tags?.join(", "),
    ),
    ...["source", "interface", "tests", "styles", "documentation", "instructions"]
      .map((key) => [key, parts[key]])
      .map(([key, name]) =>
        field(
          key,
          name,
          {
            maxlength: 12000,
            class: key === "source" || key === "interface" || key === "tests" ? "code-input" : "",
            spellcheck: "false",
          },
          recipe?.files?.[key],
          true,
        ),
      ),
    el(
      "div",
      { className: "actions" },
      el("button", { type: "submit", className: "primary" }, t("submit-for-review")),
      !isRevision &&
        btn(t("fill-with-example"), () => {
          for (const key of ["slug", "title", "summary"]) {
            form.elements[key].value = example[key];
          }
          form.elements.tags.value = example.tags.join(", ");
          for (const [key, value] of Object.entries(example.files)) {
            form.elements[key].value = value;
          }
        }),
    ),
  );
  return [
    title(
      replace ? t("edit-draft") : isRevision ? t("improve-recipe") : t("contribute-a-recipe"),
      t("recipe-at-least-one-part"),
    ),
    form,
  ];
}
const markdownRenderer = new Renderer();
/**
 * Escape raw Markdown HTML before passing it to the sanitizer.
 * @param token The Markdown token holding raw HTML text.
 */
markdownRenderer.html = ({ text }) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/**
 * Render a Markdown image as text without loading an external URL.
 * @param token The Markdown image token holding its alternate text.
 */
markdownRenderer.image = ({ text }) => markdownRenderer.html({ text });
/**
 * Render a Markdown heading while preserving the page's heading hierarchy.
 * @param token The Markdown heading token with its depth and inline content.
 */
markdownRenderer.heading = function ({ depth, tokens }) {
  const level = Math.min(6, Math.max(4, depth + 2));
  return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>`;
};
/**
 * Render sanitized Markdown for display in a recipe.
 * @param value The authored Markdown source for this part.
 */
function readableMarkdown(value) {
  const prose = el("div", { className: "recipe-prose" });
  const content = DOMPurify.sanitize(marked.parse(value, { renderer: markdownRenderer }), {
    ALLOWED_TAGS: [
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "del",
      "s",
      "a",
      "ul",
      "ol",
      "li",
      "code",
      "pre",
      "blockquote",
      "hr",
      "br",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    ALLOWED_ATTR: ["href", "title", "start"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const link of content.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href");
    if (!/^https?:\/\//i.test(href)) {
      link.removeAttribute("href");
    } else {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
  for (const table of content.querySelectorAll("table")) {
    const scroller = el("div", {
      className: "table-scroll",
      tabindex: "0",
      role: "region",
      "aria-label": t("documentation-table"),
    });
    table.replaceWith(scroller);
    scroller.append(table);
  }
  prose.append(content);
  return prose;
}
/**
 * Render a code listing with its line numbers and empty state.
 * @param lines The lines to display in source order.
 * @param wrap Whether line wrapping is enabled in the viewer.
 * @param label The viewer's accessible label.
 */
function codeBox(lines, wrap, label) {
  return el(
    "pre",
    { className: "code-box" + (wrap ? " wrap" : ""), tabindex: "0", "aria-label": label },
    el(
      "code",
      {},
      ...lines.map(({ value, marker, style }) =>
        el(
          "span",
          { className: "code-line " + (style ?? "") },
          el("span", { className: "line-marker", "aria-hidden": "true" }, marker),
          el(
            "span",
            { className: "line-value" },
            style &&
              el(
                "span",
                { className: "visually-hidden" },
                style === "diff-added" ? t("added") : t("removed"),
              ),
            value?.nodeType ? value : value || " ",
          ),
        ),
      ),
    ),
  );
}
/**
 * Render the previous and current contents as aligned columns.
 * @param before The previous text used as the diff baseline.
 * @param after The current text to compare with the baseline.
 * @param wrap Whether source lines wrap in the viewer.
 */
function diff(before, after, wrap) {
  if (before === after) {
    return el("p", { className: "file-empty" }, t("this-file-is-unchanged"));
  }
  const rows = diffLines(before ?? "", after ?? "").flatMap(({ before: left, after: right }) => {
    if (before === undefined && right !== null) {
      return [{ value: right, marker: "+", style: "diff-added" }];
    }
    if (after === undefined && left !== null) {
      return [{ value: left, marker: "−", style: "diff-removed" }];
    }
    if (left !== null && left === right) {
      return [{ value: left, marker: " " }];
    }
    return [
      ...(left === null ? [] : [{ value: left, marker: "−", style: "diff-removed" }]),
      ...(right === null ? [] : [{ value: right, marker: "+", style: "diff-added" }]),
    ];
  });
  const counts = rows.reduce(
    (total, row) => {
      if (row.style === "diff-added") {
        total.added++;
      }
      if (row.style === "diff-removed") {
        total.removed++;
      }
      return total;
    },
    { added: 0, removed: 0 },
  );
  return el(
    "div",
    {},
    el(
      "p",
      { className: "diff-summary" },
      t("compared-with-base-revision"),
      chip(`+${counts.added} added`, "state-published"),
      chip(`−${counts.removed} removed`, "state-changes"),
    ),
    codeBox(rows, wrap, "Changes from base revision"),
  );
}
/**
 * Tokenize and highlight source lines for the recipe viewer.
 * @param source The plain source text to highlight.
 * @param language The syntax highlighting language for this part.
 */
function highlightedLines(source, language) {
  const highlighted = highlighter.highlight(source.replace(/\n$/, ""), {
    language,
    ignoreIllegals: true,
  }).value;
  const fragment = DOMPurify.sanitize(highlighted, {
    ALLOWED_TAGS: ["span"],
    ALLOWED_ATTR: ["class"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  const lines = [document.createDocumentFragment()];
  /**
   * Collect one token subtree into lines while preserving its formatting classes.
   * @param node The current token tree node to traverse.
   * @param classes The highlighting classes inherited from parent tokens.
   */
  function collect(node, classes = []) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const [index, text] of node.textContent.split("\n").entries()) {
        if (index) {
          lines.push(document.createDocumentFragment());
        }
        if (text) {
          lines
            .at(-1)
            .append(classes.length ? el("span", { className: classes.join(" ") }, text) : text);
        }
      }
    } else {
      const scopes = node.classList?.length ? [...classes, ...node.classList] : classes;
      for (const child of node.childNodes) {
        collect(child, scopes);
      }
    }
  }
  collect(fragment);
  return lines.map((value, index) => ({
    value: value.hasChildNodes() ? value : " ",
    marker: String(index + 1),
  }));
}
/**
 * Give a file tool a visible label on wide screens and a name at every width.
 * @param button Tool button to label.
 * @param symbol Existing icon identifier.
 * @param label Localized name of the action.
 */
function labelFileTool(button, symbol, label) {
  button.setAttribute("aria-label", label);
  button.title = label;
  button.replaceChildren(icon(symbol), el("span", { className: "file-tool-label" }, label));
}
/**
 * Open an inline composer anchored to the selected source line.
 * @param comments Container that holds this line's feedback and composer.
 * @param trigger Line number button used to open the composer.
 * @param submit Callback that saves the comment and returns the stored row.
 */
function openLineComposer(comments, trigger, submit) {
  const existing = comments.querySelector("form");
  if (existing) {
    existing.elements.body.focus();
    return;
  }
  const input = el("textarea", {
    name: "body",
    maxlength: 2000,
    rows: 3,
    required: "",
    "aria-label": t("review-comment"),
  });
  const notice = el("p", { className: "revision-action-error", role: "alert", hidden: "" });
  const cancel = btn(t("cancel"), () => {
    form.remove();
    trigger.focus({ preventScroll: true });
  });
  const save = el("button", { type: "submit", className: "primary" }, t("add-comment"));
  const form = el(
    "form",
    {
      className: "line-comment-form",
      /**
       * Send the note and update the line-comment composer.
       * @param event The browser event from submitting the comment form.
       */
      onsubmit: async (event) => {
        event.preventDefault();
        const body = input.value.trim();
        if (!body) {
          input.value = "";
          input.reportValidity();
          return;
        }
        notice.hidden = true;
        save.disabled = true;
        cancel.disabled = true;
        input.readOnly = true;
        try {
          const saved = await submit(body);
          comments.insertBefore(lineCommentText(saved), form);
          form.remove();
          trigger.focus({ preventScroll: true });
        } catch (error) {
          notice.textContent = error.message;
          notice.hidden = false;
        } finally {
          save.disabled = false;
          cancel.disabled = false;
          input.readOnly = false;
        }
      },
    },
    input,
    notice,
    el("div", { className: "line-comment-actions" }, cancel, save),
  );
  comments.append(form);
  input.focus({ preventScroll: true });
}

/**
 * Build a numbered source view for review, including raw Markdown and blank lines.
 * @param recipe Revision being reviewed, including its current snapshot version.
 * @param part File part whose source and comments will be displayed.
 * @param value Stored file content for the selected part.
 */
function reviewLines(recipe, part, value) {
  const current = new Map();
  const earlier = [];
  for (const comment of recipe.review.comments.filter((item) => item.part === part)) {
    if (comment.editVersion === recipe.editVersion) {
      const line = current.get(comment.line) ?? [];
      line.push(comment);
      current.set(comment.line, line);
    } else {
      earlier.push(comment);
    }
  }
  const lines = value === undefined ? [] : sourceLines(value);
  const rows = el("div", { className: "review-source", role: "group", "aria-label": parts[part] });
  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    const feedback = el(
      "div",
      { className: "line-comment-thread" },
      ...(current.get(line) ?? []).map(lineCommentText),
    );
    const marker = recipe.review.canComment
      ? btn(
          String(line),
          () =>
            openLineComposer(feedback, marker, async (body) => {
              const saved = await api("comment", {
                slug: recipe.slug,
                revision: recipe.id,
                editVersion: recipe.editVersion,
                part,
                line,
                body,
              });
              recipe.review.comments.push(saved);
              return saved;
            }),
          "review-line-button",
        )
      : el("span", { className: "review-line-number" }, String(line));
    if (recipe.review.canComment) {
      const label = t("comment-on-line") + " " + line;
      marker.setAttribute("aria-label", label);
      marker.title = label;
    }
    rows.append(
      el("div", { className: "review-line" }, marker, el("code", {}, text || " "), feedback),
    );
  }
  return el(
    "div",
    {},
    lines.length > 0 && rows,
    earlier.length > 0 &&
      el(
        "section",
        { className: "earlier-line-comments" },
        el("h4", {}, t("comments-on-earlier-edits")),
        ...earlier.map((comment) =>
          el(
            "div",
            { className: "historical-line-comment" },
            el("code", {}, t("line") + " " + comment.line + " · " + comment.excerpt),
            lineCommentText(comment),
          ),
        ),
      ),
  );
}

/**
 * Build the visible metadata and body for one review comment.
 * @param comment The saved review comment and its anchor.
 */
function lineCommentText(comment) {
  return el(
    "div",
    { className: "line-comment" },
    el("strong", {}, t("reviewer")),
    el("p", {}, comment.body),
  );
}

/**
 * Build a recipe part with reading, copying, and review controls.
 * @param recipe The revision containing the current part.
 * @param key The key of the file part to display.
 * @param value The current text of the part.
 * @param previous The text of the same part in the base revision.
 * @param hasBase Whether a base revision is available for comparison.
 */
function fileSection(recipe, key, value, previous, hasBase) {
  const name = parts[key];
  const prose = key === "documentation" || key === "instructions";
  const partIcon = {
    documentation: "doc",
    interface: "interface",
    source: "code",
    tests: "tests",
    styles: "code",
    instructions: "instructions",
  };
  const heading = el(
    "h3",
    { id: "recipe-part-title-" + key, tabindex: "-1" },
    icon(partIcon[key]),
    name,
  );
  const area = el("div", { id: "recipe-part-content-" + key });
  const status = el("span", { className: "copy-status", role: "status" });
  let reviewing = false;
  let comparing = false;
  let wrap = true;
  let renderedLines;
  const compare =
    hasBase &&
    btn(t("show-changes"), () => {
      comparing = !comparing;
      reviewing = false;
      renderPart();
    });
  const hasFeedback = recipe.review?.comments.some((comment) => comment.part === key);
  const reviewButton =
    (hasFeedback || (recipe.review?.canComment && value !== undefined)) &&
    btn(t("line-comments"), () => {
      reviewing = !reviewing;
      comparing = false;
      renderPart();
    });
  const wrapButton = btn(t("wrap-lines"), () => {
    wrap = !wrap;
    renderPart();
  });
  const copy = btn(prose ? t("copy-markdown") : t("copy-code"), async () => {
    try {
      await navigator.clipboard.writeText(value);
      status.textContent = t("copied");
    } catch {
      status.textContent = t("copy-unavailable-select-the-file-text-to-copy");
    }
  });
  labelFileTool(copy, "copy", prose ? t("copy-markdown") : t("copy-code"));
  labelFileTool(wrapButton, "wrap", t("wrap-lines"));
  /** Redraw the open part using the selected display and wrapping mode. */
  function renderPart() {
    status.textContent = "";
    if (compare) {
      labelFileTool(compare, "diff", comparing ? t("show-file") : t("show-changes"));
      compare.setAttribute("aria-pressed", String(comparing));
    }
    if (reviewButton) {
      labelFileTool(reviewButton, "comment", reviewing ? t("show-file") : t("line-comments"));
      reviewButton.setAttribute("aria-pressed", String(reviewing));
    }
    wrapButton.hidden = reviewing || (!comparing && (prose || value === undefined));
    wrapButton.setAttribute("aria-pressed", String(wrap));
    copy.hidden = value === undefined || comparing || reviewing;
    const content = reviewing
      ? reviewLines(recipe, key, value)
      : comparing
        ? diff(previous, value, wrap)
        : value === undefined
          ? el("p", { className: "file-empty" }, t("this-revision-omits-this-file"))
          : prose
            ? readableMarkdown(value)
            : codeBox(
                (renderedLines ??= highlightedLines(
                  value,
                  key === "styles" ? "css" : "typescript",
                )).map(({ value: line, marker }) => ({
                  value: line.nodeType ? line.cloneNode(true) : line,
                  marker,
                })),
                wrap,
                name,
              );
    area.replaceChildren(content);
  }
  for (const control of [compare, reviewButton, wrapButton].filter(Boolean)) {
    control.setAttribute("aria-controls", area.id);
  }
  renderPart();
  return {
    heading,
    section: el(
      "section",
      { className: "panel recipe-part", "aria-labelledby": heading.id },
      heading,
      el("div", { className: "file-tools" }, compare, reviewButton, wrapButton, copy, status),
      area,
    ),
  };
}
/**
 * Assemble the available recipe parts into the revision viewer.
 * @param recipe The current recipe revision to display.
 * @param base The optional prior revision used for comparisons.
 */
function fileViewer(recipe, base) {
  const keys = Object.keys(parts).filter(
    (key) =>
      key in recipe.files ||
      (base && key in base.files) ||
      recipe.review?.comments.some((comment) => comment.part === key),
  );
  const files = keys.map((key) =>
    fileSection(recipe, key, recipe.files[key], base?.files[key], Boolean(base)),
  );
  const navigate = el(
    "nav",
    { className: "recipe-contents", "aria-label": t("recipe-sections") },
    ...files.map(({ heading }) =>
      btn(heading.textContent, () => {
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: "start" });
      }),
    ),
  );
  return el(
    "section",
    { className: "section file-viewer", "aria-labelledby": "recipe-files-heading" },
    el("h2", { id: "recipe-files-heading", className: "visually-hidden" }, t("recipe-files")),
    navigate,
    ...files.map(({ section }) => section),
  );
}
const actionReasons = {
  approve: { label: t("optional-review-note"), required: false },
  request_changes: { label: t("what-should-change"), required: true },
  quarantine: { label: t("why-quarantine-revision"), required: true },
  request_removal: { label: t("why-remove-revision"), required: true },
};
const actionDescriptions = {
  publish: t("publish-current-revision-description"),
  remove_draft: t("remove-draft-description"),
  approve_removal: t("approve-removal-description"),
};

/**
 * List the actions available for the current revision and viewer.
 * @param recipe Loaded revision with the author's permissions and review status.
 */
function revisionChoices(recipe) {
  const choices = [];
  /**
   * Add an available review action to the revision menu.
   * @param action The operation sent to the review endpoint.
   * @param label The visible label in the action menu.
   * @param destructive Whether to style the action as destructive.
   */
  const addAction = (action, label, destructive = false) =>
    choices.push({ action, label, destructive });
  if (maintainer && recipe.state === "pending" && !recipe.removal_reason) {
    addAction("approve", t("approve-revision"));
    addAction("request_changes", t("request-changes"));
  }
  if (maintainer && recipe.state === "approved" && !recipe.removal_reason) {
    addAction("publish", t("publish-approved-revision"));
  }
  if (recipe.state !== "quarantined") {
    choices.push({
      label: recipe.canReplace ? t("edit-draft") : t("propose-an-improvement"),
      href:
        (recipe.canReplace ? "#edit/" : "#improve/") +
        encodeURIComponent(recipe.slug) +
        "/" +
        encodeURIComponent(recipe.id),
    });
    if (maintainer) {
      addAction("quarantine", t("quarantine"), true);
    }
  }
  if (recipe.canRemoveDraft) {
    addAction("remove_draft", t("remove-draft"), true);
  } else if (recipe.canRequestRemoval && !recipe.removal_reason) {
    addAction("request_removal", t("request-removal"), true);
  }
  if (maintainer && recipe.removal_reason) {
    addAction("approve_removal", t("approve-removal"), true);
  }
  return choices;
}

/**
 * Open the selected action's form with only the fields relevant to that action.
 * @param choice Selected action with its label and destructive styling.
 * @param submit Callback that saves the action and may reject with an API error.
 * @param trigger Toolbar button to refocus after cancellation.
 */
function showRevisionAction(choice, submit, trigger) {
  const reason = actionReasons[choice.action];
  const errorStatus = el("p", { className: "revision-action-error", role: "alert", hidden: "" });
  const textarea =
    reason &&
    el("textarea", {
      name: "reason",
      maxlength: 1000,
      required: reason.required ? "" : undefined,
      rows: 4,
    });
  const cancel = btn(t("cancel"), () => dialog.close());
  const confirm = el(
    "button",
    { type: "submit", className: choice.destructive ? "danger" : "primary" },
    choice.label,
  );
  const form = el(
    "form",
    {},
    el("h2", { id: "revision-action-heading" }, choice.label),
    actionDescriptions[choice.action] && el("p", {}, actionDescriptions[choice.action]),
    textarea && el("label", { className: "revision-action-reason" }, reason.label, textarea),
    errorStatus,
    el("div", { className: "revision-dialog-buttons" }, cancel, confirm),
  );
  const dialog = el(
    "dialog",
    { className: "revision-dialog", "aria-labelledby": "revision-action-heading" },
    form,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = textarea?.value.trim() ?? "";
    if (reason?.required && !note) {
      textarea.value = "";
      textarea.reportValidity();
      return;
    }
    errorStatus.hidden = true;
    confirm.disabled = true;
    cancel.disabled = true;
    if (textarea) {
      textarea.readOnly = true;
    }
    try {
      await submit(choice.action, note, dialog);
    } catch (error) {
      errorStatus.textContent = error.message;
      errorStatus.hidden = false;
      confirm.focus();
    } finally {
      confirm.disabled = false;
      cancel.disabled = false;
      if (textarea) {
        textarea.readOnly = false;
      }
    }
  });
  dialog.addEventListener("cancel", (event) => {
    if (confirm.disabled) {
      event.preventDefault();
    }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (trigger.isConnected) {
      trigger.focus({ preventScroll: true });
    }
  });
  trigger.closest(".revision-controls").append(dialog);
  dialog.showModal();
  (choice.destructive || !textarea ? cancel : textarea).focus();
}

/**
 * Build the toolbar disclosure for a revision.
 * @param recipe Loaded revision and its current snapshot version.
 * @param section Section to return to if the revision is removed.
 */
function revisionControls(recipe, section) {
  const choices = revisionChoices(recipe);
  if (!choices.length) {
    return null;
  }
  const trigger = el(
    "button",
    {
      type: "button",
      className: "revision-trigger",
      "aria-label": t("revision-actions"),
      title: t("revision-actions"),
      "aria-controls": "revision-options",
      "aria-expanded": "false",
    },
    icon("more"),
  );
  const menu = el("div", { className: "revision-menu", id: "revision-options", hidden: "" });
  const wrapper = el("div", { className: "revision-controls" }, trigger, menu);
  /**
   * Set the action menu state and its accessibility attributes.
   * @param open Whether the action menu should be visible.
   */
  function toggle(open) {
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  }
  const page = location.hash;
  /**
   * Send a revision action and report its result to the reader.
   * @param action The review operation to run.
   * @param reason The optional reason supplied for the operation.
   * @param dialog The confirmation dialog to update on completion.
   */
  async function submit(action, reason, dialog) {
    await api("action", {
      slug: recipe.slug,
      revision: recipe.id,
      editVersion: recipe.editVersion,
      action,
      reason,
    });
    dialog.close();
    if (location.hash !== page) {
      return;
    }
    banner(action === "publish" ? t("recipe-published") : t("revision-updated"), false, true);
    if (["remove_draft", "approve_removal"].includes(action)) {
      location.hash = "#" + section;
    } else {
      await render();
      toolbar.querySelector("button")?.focus({ preventScroll: true });
    }
  }
  for (const choice of choices) {
    const item = choice.href
      ? el("a", { href: choice.href }, choice.label)
      : btn(
          choice.label,
          () => {
            toggle(false);
            showRevisionAction(choice, submit, trigger);
          },
          choice.destructive ? "is-destructive" : "",
        );
    menu.append(item);
  }
  trigger.addEventListener("click", () => {
    toggle(menu.hidden);
    if (!menu.hidden) {
      menu.firstElementChild.focus();
    }
  });
  wrapper.addEventListener("focusout", (event) => {
    if (!wrapper.contains(event.relatedTarget)) {
      toggle(false);
    }
  });
  wrapper.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      toggle(false);
      trigger.focus();
    }
  });
  return wrapper;
}
/**
 * Load a revision and build the recipe page with its toolbar.
 * @param section The section used for back navigation.
 * @param slug The slug of the recipe to retrieve.
 * @param revision The requested revision ID, when present.
 */
async function recipePage(section, slug, revision) {
  const recipe = await api(
    "recipe?" + new URLSearchParams({ slug, revision, reviewComments: "1" }),
  );
  let base = null;
  if (recipe.base) {
    try {
      base = await api("recipe?" + new URLSearchParams({ slug, revision: recipe.base }));
    } catch {
      /* The base revision may have been removed. */
    }
  }
  recentRecipe = recipe;
  return {
    actions: revisionControls(recipe, section),
    toolbarTitle: recipe.title,
    view: [
      el(
        "header",
        { className: "recipe-heading" },
        title(recipe.title, recipe.summary),
        el(
          "div",
          { className: "recipe-byline" },
          chip(stateLabels[recipe.state] ?? recipe.state, "state-" + recipe.state),
          recipe.tags.length > 0 && el("span", { className: "muted" }, recipe.tags.join(" · ")),
        ),
      ),
      recipe.review_note && el("p", { className: "panel" }, recipe.review_note),
      recipe.removal_reason &&
        el("p", { className: "panel" }, t("removal-requested") + recipe.removal_reason),
      fileViewer(recipe, base),
      el(
        "dl",
        { className: "revision-meta" },
        el("div", {}, el("dt", {}, t("recipe-slug")), el("dd", {}, el("code", {}, recipe.slug))),
        el("div", {}, el("dt", {}, t("revision-id")), el("dd", {}, el("code", {}, recipe.id))),
      ),
    ],
  };
}
/** Build the maintainer form for editing the recipe quality policy. */
async function settingsPage() {
  const { policy, prettierOptions, eslintRules, qualityOptions } = await api("settings");
  const form = el("form", { className: "form code-settings" });
  const controls = {};
  const formatOptions = prettierOptions.map((option) => {
    const current = policy.prettier[option.key];
    let control;
    if (option.choices) {
      control = el(
        "select",
        { name: option.key },
        ...option.choices.map((choice) => el("option", { value: choice }, choice)),
      );
      control.value = current;
    } else if (typeof current === "boolean") {
      control = el("input", { type: "checkbox", name: option.key });
      control.checked = current;
    } else {
      control = el("input", {
        type: "number",
        name: option.key,
        min: option.min,
        max: option.max,
        required: "",
      });
      control.value = current;
    }
    controls[option.key] = control;
    return el(
      "label",
      { className: control.type === "checkbox" ? "setting-toggle" : "setting-field" },
      option.label,
      control,
    );
  });
  const qualityControls = {};
  const qualityFields = qualityOptions.map(({ key, label }) => {
    const control = el(
      "select",
      { name: key },
      ...["off", "warn", "error"].map((severity) => el("option", { value: severity }, severity)),
    );
    control.value = policy.quality[key];
    qualityControls[key] = control;
    return el("label", { className: "setting-field" }, label, control);
  });
  const warningsAsErrors = el("input", { type: "checkbox", name: "warningsAsErrors" });
  warningsAsErrors.checked = policy.quality.warningsAsErrors;
  const lintConfig = el("textarea", {
    className: "code-input eslint-config",
    name: "eslint",
    spellcheck: "false",
    required: "",
  });
  lintConfig.value = JSON.stringify(
    {
      rules: policy.eslint,
      globals: policy.globals,
      settings: policy.settings,
      overrides: policy.overrides,
    },
    null,
    2,
  );
  const ruleFilter = el("input", { type: "search", placeholder: t("try-eqeqeq-or-no-console") });
  const matches = el("ul", { className: "rule-matches" });
  /** Replace the rule suggestions with matches for the search query. */
  const updateMatches = () => {
    const query = ruleFilter.value.trim().toLowerCase();
    matches.replaceChildren(
      ...eslintRules
        .filter((name) => name.includes(query))
        .slice(0, 12)
        .map((name) => el("li", {}, el("code", {}, name))),
    );
  };
  ruleFilter.addEventListener("input", updateMatches);
  updateMatches();
  const save = el("button", { type: "submit", className: "primary" }, t("save-code-policy"));
  const status = el("p", { role: "status", className: "muted" });
  form.append(
    el(
      "section",
      { className: "panel" },
      el("h2", {}, t("prettier")),
      el("p", { className: "muted" }, t("code-is-formatted-before-a-revision-is-stored")),
      el("div", { className: "policy-fields" }, ...formatOptions),
    ),
    el(
      "section",
      { className: "panel" },
      el("h2", {}, t("quality-checks")),
      el("p", { className: "muted" }, t("duplicate-setting-help")),
      el(
        "div",
        { className: "policy-fields" },
        ...qualityFields,
        el(
          "label",
          { className: "setting-toggle" },
          t("block-submissions-with-warnings"),
          warningsAsErrors,
        ),
      ),
    ),
    el(
      "section",
      { className: "panel" },
      el("h2", {}, t("eslint")),
      el("p", { className: "muted" }, t("use-off-warn-or-error-for-options-use")),
      el("p", { className: "muted" }, t("jsdoc-required")),
      el("label", {}, t("eslint-configuration-json"), lintConfig),
      el("label", { className: "section" }, t("find-a-bundled-rule"), ruleFilter),
      matches,
    ),
    el("div", { className: "actions" }, save, status),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "";
    save.disabled = true;
    try {
      const prettier = Object.fromEntries(
        Object.entries(controls).map(([key, control]) => [
          key,
          control.type === "checkbox"
            ? control.checked
            : control.type === "number"
              ? control.valueAsNumber
              : control.value,
        ]),
      );
      const config = JSON.parse(lintConfig.value);
      for (const key of Object.keys(config)) {
        if (!["rules", "globals", "settings", "overrides"].includes(key)) {
          throw new Error(`Unsupported ESLint configuration field ${key}.`);
        }
      }
      const { rules, globals, settings, overrides } = config;
      const quality = Object.fromEntries(
        Object.entries(qualityControls).map(([key, control]) => [key, control.value]),
      );
      quality.warningsAsErrors = warningsAsErrors.checked;
      await api("settings", { prettier, eslint: rules, globals, settings, overrides, quality });
      status.textContent = t("code-policy-saved");
    } catch (error) {
      status.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });
  return [title(t("code-policy"), t("set-the-rules-for-new-recipe-revisions-submitted")), form];
}
/** Render the current hash route and discard stale asynchronous results. */
async function render() {
  const current = ++renderId;
  toolbar.replaceChildren();
  const [page, one, two, three] = location.hash
    .slice(1)
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    });
  const section =
    page === "recipe" ? one : ["improve", "edit"].includes(page) ? "contribute" : page || "library";
  const reading = page === "recipe";
  topBar.classList.toggle("recipe-top", reading);
  outlet.classList.toggle("recipe-view", reading);
  revisionBack.hidden = !reading;
  if (reading) {
    revisionBack.href = "#" + (Object.hasOwn(labels, section) ? section : "library");
    const backLabel = t("back-to") + (labels[section] ?? t("library")).toLowerCase();
    revisionBack.setAttribute("aria-label", backLabel);
    revisionBack.title = backLabel;
  }
  locationLabel.textContent = labels[section] ?? labels.library;
  for (const link of document.querySelectorAll(".rail nav a")) {
    if (link.hash === "#" + section) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
  try {
    let view;
    let actions;
    let toolbarTitle;
    if (page === "recipe") {
      ({ view, actions, toolbarTitle } = await recipePage(one, two, three));
    } else if (page === "improve" || page === "edit") {
      const recipe =
        page === "improve" && recentRecipe?.id === two && recentRecipe.slug === one
          ? recentRecipe
          : await api("recipe?" + new URLSearchParams({ slug: one, revision: two }));
      if (page === "edit" && !recipe.canReplace) {
        throw new Error(t("draft-no-longer-editable"));
      }
      view = contribute(recipe, page === "edit");
    } else if (section === "contribute") {
      view = contribute();
    } else if (section === "settings") {
      view = await settingsPage();
    } else if (section === "mine" || section === "review") {
      const rows = await api(section === "mine" ? "mine" : "queue");
      view = [
        title(
          labels[section],
          section === "mine"
            ? t("track-your-submissions-and-review-feedback")
            : t("inspect-changes-record-a-decision-and-publish-approved"),
        ),
        rows.length
          ? list(rows, section)
          : empty(
              section === "mine" ? t("no-revisions-yet") : t("review-queue-is-empty"),
              section === "mine"
                ? t("your-submitted-snapshots-will-appear-here")
                : t("pending-reviews-and-approved-revisions-waiting-to-publish"),
            ),
      ];
    } else {
      view = await library();
    }
    if (current === renderId) {
      outlet.replaceChildren(...view.filter((item) => item && item.nodeType));
      if (toolbarTitle) {
        locationLabel.textContent = toolbarTitle;
      }
      if (actions) {
        toolbar.append(actions);
      }
    }
  } catch (error) {
    if (current === renderId) {
      outlet.replaceChildren(
        empty(t("cookbook-unavailable"), error.message, btn(t("retry"), render)),
      );
    }
  }
}
document.querySelector(".skip").addEventListener("click", (event) => {
  event.preventDefault();
  document.querySelector("#content").focus();
});
window.addEventListener("hashchange", async () => {
  const target = location.hash;
  await render();
  if (location.hash === target) {
    document.querySelector("#content").focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
});
try {
  ({ maintainer } = await api("session"));
  for (const route of ["review", "settings"]) {
    document.querySelector(`.rail nav a[href="#${route}"]`).hidden = !maintainer;
  }
  await render();
} catch (error) {
  outlet.replaceChildren(
    empty(
      t("sign-in-to-the-cookbook"),
      error.message,
      el(
        "a",
        { className: "button primary", href: "/signin-with-chatgpt?returnTo=%2F", target: "_top" },
        t("sign-in-with-chatgpt"),
      ),
    ),
  );
}
