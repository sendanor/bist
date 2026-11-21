import { t } from "./localization.js";
import { api } from "./browser-api.js";
import cssLanguage from "highlight.js/lib/languages/css";
import { diffLines } from "./line-diff.ts";
import { marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import highlighter from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";

highlighter.registerLanguage("typescript", typescript);
highlighter.registerLanguage("css", cssLanguage);

const outlet = document.querySelector("#view");
const notice = document.querySelector("#notice");
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
function banner(message = "", error = false) {
  notice.textContent = message;
  notice.classList.toggle("error", error);
}
function btn(text, fn, style = "") {
  return el("button", { type: "button", className: style, onclick: fn }, text);
}
function buttonLink(text, href, style = "") {
  return el("a", { href, className: "button " + style }, text);
}
function field(name, title, options = {}, value = "", textarea = false) {
  const control = el(textarea ? "textarea" : "input", { name, ...options });
  control.value = value;
  return el("label", {}, title, control);
}
function title(text, detail) {
  return el("div", {}, el("h1", {}, text), detail && el("p", { className: "muted" }, detail));
}
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
function chip(text, style = "") {
  return el("span", { className: "chip " + style }, text);
}
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
async function library() {
  const rows = await api("search?" + new URLSearchParams(filters));
  const form = el(
    "form",
    {
      className: "search",
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
      el("p", {}, t("find-small-adaptable-typescript-recipes-reviewed-by-your")),
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
    interface: "export declare function chunk<T>(items: readonly T[], size: number): T[][];",
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
function contribute(recipe, replace = false) {
  const isRevision = Boolean(recipe?.id);
  const form = el(
    "form",
    {
      className: "panel form",
      onsubmit: async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        const submit = form.querySelector("[type=submit]");
        submit.disabled = true;
        banner();
        try {
          const result = await api("submit", {
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
          name + (key === "source" ? "" : t("optional")),
          {
            required: key === "source" ? "" : undefined,
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
      t("submit-a-complete-recipe-snapshot-for-review-each"),
    ),
    form,
  ];
}
const markdownRenderer = new Renderer();
markdownRenderer.html = ({ text }) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
markdownRenderer.image = ({ text }) => markdownRenderer.html({ text });
markdownRenderer.heading = function ({ depth, tokens }) {
  const level = Math.min(6, Math.max(4, depth + 2));
  return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>`;
};
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
function fileSection(key, value, previous, hasBase) {
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
  let comparing = false;
  let wrap = true;
  let renderedLines;
  const compare =
    hasBase &&
    btn(t("show-changes"), () => {
      comparing = !comparing;
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
  copy.prepend(icon("copy"));
  wrapButton.prepend(icon("wrap"));
  function renderPart() {
    status.textContent = "";
    if (compare) {
      compare.replaceChildren(icon("diff"), comparing ? "Show file" : "Show changes");
      compare.setAttribute("aria-pressed", String(comparing));
    }
    wrapButton.hidden = !comparing && (prose || value === undefined);
    wrapButton.setAttribute("aria-pressed", String(wrap));
    copy.hidden = value === undefined || comparing;
    const content = comparing
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
  for (const control of [compare, wrapButton].filter(Boolean)) {
    control.setAttribute("aria-controls", area.id);
  }
  renderPart();
  return {
    heading,
    section: el(
      "section",
      { className: "panel recipe-part", "aria-labelledby": heading.id },
      heading,
      el("div", { className: "file-tools" }, compare, wrapButton, copy, status),
      area,
    ),
  };
}
function fileViewer(recipe, base) {
  const keys = Object.keys(parts).filter(
    (key) => key in recipe.files || (base && key in base.files),
  );
  const files = keys.map((key) =>
    fileSection(key, recipe.files[key], base?.files[key], Boolean(base)),
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
    el("h2", { id: "recipe-files-heading" }, t("recipe-files")),
    navigate,
    ...files.map(({ section }) => section),
  );
}
function controls(recipe, section) {
  const choices = [];
  const addAction = (action, label, style = "") => choices.push({ action, label, style });
  if (maintainer && recipe.state === "pending" && !recipe.removal_reason) {
    addAction("approve", t("approve-revision"), "primary");
    addAction("request_changes", t("request-changes"));
  }
  if (maintainer && recipe.state === "approved" && !recipe.removal_reason) {
    addAction("publish", t("publish-approved-revision"), "primary");
  }
  if (maintainer && recipe.state !== "quarantined") {
    addAction("quarantine", t("quarantine"), "danger");
  }
  if (recipe.canRemoveDraft) {
    addAction("remove_draft", t("remove-draft"), "danger");
  } else if (recipe.canRequestRemoval && !recipe.removal_reason) {
    addAction("request_removal", t("request-removal"), "danger");
  }
  if (maintainer && recipe.removal_reason) {
    addAction("approve_removal", t("approve-removal"), "danger");
  }
  if (!choices.length) {
    return null;
  }
  const reason = field(
    "reason",
    t("reason"),
    { maxlength: 1000, placeholder: t("required-for-changes-quarantine-and-removal-requests") },
    "",
    true,
  );
  const actions = el("div", { className: "actions" });
  for (const { action, label, style } of choices) {
    actions.append(
      btn(
        label,
        async () => {
          const buttons = [...actions.querySelectorAll("button")];
          buttons.forEach((button) => {
            button.disabled = true;
          });
          banner();
          try {
            await api("action", {
              slug: recipe.slug,
              revision: recipe.id,
              editVersion: recipe.editVersion,
              action,
              reason: reason.querySelector("textarea").value,
            });
            banner(action === "publish" ? t("recipe-published") : t("revision-updated"));
            if (["remove_draft", "approve_removal"].includes(action)) {
              location.hash = "#" + section;
            } else {
              render();
            }
          } catch (error) {
            banner(error.message, true);
          } finally {
            buttons.forEach((button) => {
              button.disabled = false;
            });
          }
        },
        style,
      ),
    );
  }
  return el(
    "section",
    { className: "panel section", id: "revision-actions", tabindex: "-1" },
    el("h2", {}, t("revision-actions")),
    reason,
    actions,
  );
}
async function recipePage(section, slug, revision) {
  const recipe = await api("recipe?" + new URLSearchParams({ slug, revision }));
  let base = null;
  if (recipe.base) {
    try {
      base = await api("recipe?" + new URLSearchParams({ slug, revision: recipe.base }));
    } catch {
      /* The base revision may have been removed. */
    }
  }
  recentRecipe = recipe;
  const reviewControls = controls(recipe, section);
  const jump =
    maintainer &&
    reviewControls &&
    ["pending", "approved"].includes(recipe.state) &&
    btn(
      t("review-actions"),
      () => {
        reviewControls.focus({ preventScroll: true });
        reviewControls.scrollIntoView({ block: "start" });
      },
      "review-jump",
    );
  return [
    el(
      "a",
      { className: "back", href: "#" + section },
      t("back-to") + (labels[section] ?? t("library")).toLowerCase(),
    ),
    title(recipe.title, recipe.summary),
    chip(stateLabels[recipe.state] ?? recipe.state, "state-" + recipe.state),
    ...recipe.tags.map((tag) => chip(tag)),
    el(
      "dl",
      { className: "revision-meta" },
      el("div", {}, el("dt", {}, t("recipe-slug")), el("dd", {}, el("code", {}, recipe.slug))),
      el("div", {}, el("dt", {}, t("revision-id")), el("dd", {}, el("code", {}, recipe.id))),
    ),
    recipe.review_note && el("p", { className: "panel" }, recipe.review_note),
    recipe.removal_reason &&
      el("p", { className: "panel" }, t("removal-requested") + recipe.removal_reason),
    jump,
    fileViewer(recipe, base),
    reviewControls,
    recipe.state !== "quarantined" &&
      el(
        "div",
        { className: "section" },
        buttonLink(
          recipe.canReplace ? t("edit-draft") : t("propose-an-improvement"),
          (recipe.canReplace ? "#edit/" : "#improve/") +
            encodeURIComponent(recipe.slug) +
            "/" +
            encodeURIComponent(recipe.id),
        ),
      ),
  ];
}
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
      el("h2", {}, t("type-and-stylesheet-checks")),
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
async function render() {
  const current = ++renderId;
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
  document.querySelector("#location").textContent = labels[section] ?? labels.library;
  for (const link of document.querySelectorAll(".rail nav a")) {
    if (link.hash === "#" + section) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
  try {
    let view;
    if (page === "recipe") {
      view = await recipePage(one, two, three);
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
