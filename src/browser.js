import { t } from "./localization.js";
import { api } from "./browser-api.js";
import { btn, el } from "./browser-dom.js";
import { editRecipeFile } from "./file-editor.js";
import cssLanguage from "highlight.js/lib/languages/css";
import { diffLines, sourceLines } from "./line-diff.ts";
import { parsePagePath } from "./routes.ts";
import { effectiveReasoning, reasoningOptions } from "./reasoning.ts";
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
const assistantToggle = document.querySelector("#assistant-toggle");
const assistantPanel = document.querySelector("#assistant-panel");
const assistantView = document.querySelector("#assistant-view");
const assistantClose = document.querySelector("#assistant-close");
const assistantResize = document.querySelector("#assistant-resize");
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
const responseSkillLabels = {
  caveman: t("assistant-skill-caveman"),
  suomenkieli: t("assistant-skill-finnish"),
  seo: t("assistant-skill-seo"),
  design: t("assistant-skill-design"),
  import: t("assistant-skill-import"),
  publication: t("assistant-skill-publication"),
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
let assistantLoading = false;
const listingPaths = new Map();

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
    "/recipe/" +
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
 * Toggle this exact tag while keeping the other filters in the current list.
 * @param tag The exact tag used by the listing filter.
 * @param section The library, personal revisions, or review queue.
 * @param filters The current text, tags, and review status.
 */
function tagLink(tag, section, filters) {
  const selected = filters.getAll("tag").includes(tag);
  const next = new URLSearchParams(filters);
  if (selected) {
    next.delete("tag", tag);
  } else {
    next.append("tag", tag);
  }
  return el(
    "a",
    {
      className: selected ? "chip tag-link tag-selected" : "chip tag-link",
      href: listingPath(section, next),
      ...(selected ? { "aria-label": t("remove-tag") + " " + tag } : {}),
    },
    tag,
  );
}

/**
 * Render links for a list of recipe revision summaries.
 * @param rows The ordered revision summaries to display.
 * @param section The navigation section providing the back-link context.
 * @param filters The currently applied listing filters.
 */
function list(rows, section, filters) {
  return el(
    "div",
    { className: section === "review" ? "list review-list" : "list" },
    ...rows.map((row) =>
      el(
        "article",
        { className: "panel recipe" },
        el("h3", {}, el("a", { href: routeRecipe(row, section) }, row.title)),
        el("p", { className: "muted" }, row.summary),
        chip(stateLabels[row.state] ?? row.state, "state-" + row.state),
        row.removal_reason && chip(t("removal-requested-label")),
        ...row.tags.map((tag) => tagLink(tag, section, filters)),
      ),
    ),
  );
}

/**
 * Build a link to a filtered list page without carrying filters across sections.
 * @param section The library, personal revisions, or review queue.
 * @param filters The values for the submitted filters.
 * @param cursor The optional boundary of the requested page.
 */
function listingPath(section, filters, cursor) {
  const params = new URLSearchParams();
  for (const name of ["query", "tag", "state"]) {
    for (const value of new Set(
      filters
        .getAll(name)
        .map((entry) => entry.trim())
        .filter(Boolean),
    )) {
      params.append(name, value);
    }
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  return "/" + section + (params.size ? "?" + params : "");
}

/**
 * Format an exact tag for the shared search field, quoting spaces or punctuation as needed.
 * @param tag The stored tag name.
 */
function tagTerm(tag) {
  return "tag:" + (/[\s"\\]/u.test(tag) ? JSON.stringify(tag) : tag);
}

/**
 * Split typed tag terms from keywords and keep other submitted listing filters.
 * @param form The search form fields or intermediate search parameters.
 */
function searchFilters(form) {
  const filters = new URLSearchParams(form);
  const input = filters.get("query") ?? "";
  const query = input.replace(
    /(?<!\S)tag:("(?:[^"\\]|\\(?:["\\/bfnrt]|u[\da-f]{4}))*"(?=\s|$)|[^\s"]+)/giu,
    (term, value) => {
      try {
        const tag = value.startsWith('"') ? JSON.parse(value) : value;
        filters.append("tag", tag.trim().toLowerCase());
        return "";
      } catch {
        return term;
      }
    },
  );
  filters.set("query", query.trim().replace(/\s+/gu, " "));
  return filters;
}

/**
 * Build the shared keyword and tag input with suggestions for the tag currently being typed.
 * @param label The accessible search field label.
 * @param filters The active keyword and tag filters.
 * @param tags The available tag suggestions in this section.
 */
function listingSearchField(label, filters, tags) {
  const suggestions = el("datalist", { id: "filter-tags" });
  const input = el("input", {
    name: "query",
    type: "search",
    placeholder: t("search-keywords-and-tags"),
    maxlength: 720,
    list: suggestions.id,
  });
  input.value = [filters.get("query"), ...filters.getAll("tag").map(tagTerm)]
    .filter(Boolean)
    .join(" ");
  /**
   * Suggest full queries so selecting a tag preserves all earlier keywords and tags.
   */
  function updateSuggestions() {
    const partial = input.value.match(/(?:^|\s)(tag:[^\s"]*)$/iu)?.[1];
    const prefix = partial ? input.value.slice(0, -partial.length) : input.value.trimEnd() + " ";
    const selected = searchFilters(new URLSearchParams({ query: prefix })).getAll("tag");
    suggestions.replaceChildren(
      ...tags
        .filter((tag) => !selected.includes(tag))
        .map(tagTerm)
        .filter((term) => term.toLowerCase().startsWith(partial?.toLowerCase() ?? ""))
        .map((term) => el("option", { value: (prefix.trim() ? prefix : "") + term })),
    );
  }
  input.addEventListener("input", updateSuggestions);
  updateSuggestions();
  return el("label", {}, label, input, suggestions);
}

/**
 * Build a filter form that starts again at the first page when submitted.
 * @param section The active list section.
 * @param filters The values shown in the active filter controls.
 * @param tags Tag suggestions visible in this section.
 */
function listingForm(section, filters, tags) {
  const review = section === "review";
  const status = el(
    "select",
    {
      name: "state",
      /**
       * Apply the chosen status with the other search terms from the current form.
       * @param event Change made in the review status selector.
       */
      onchange: (event) => event.currentTarget.form.requestSubmit(),
    },
    el("option", { value: "" }, t("all-statuses")),
    el("option", { value: "pending" }, t("pending-review")),
    el("option", { value: "approved" }, t("approved")),
    el("option", { value: "quarantined" }, t("quarantined")),
    el("option", { value: "removal" }, t("removal-requested-label")),
  );
  status.value = filters.get("state") ?? "";
  const active =
    filters.get("query") || filters.get("tag") || filters.get("state") || filters.get("cursor");
  return el(
    "form",
    {
      className: review ? "search review-search" : "search",
      /**
       * Apply the form's filters and start at the first page.
       * @param event Form submission from the filter controls.
       */
      onsubmit: (event) => {
        event.preventDefault();
        navigate(listingPath(section, searchFilters(new FormData(event.currentTarget))));
      },
    },
    listingSearchField(
      section === "library" ? t("search-recipes") : t("search-revisions"),
      filters,
      tags,
    ),
    review && el("label", {}, t("status"), status),
    el(
      "div",
      { className: "list-filter-actions" },
      el("button", { className: "primary" }, t("search")),
      active &&
        buttonLink(
          section === "library" ? t("show-all-recipes") : t("show-all-revisions"),
          "/" + section,
        ),
    ),
  );
}

/**
 * Fetch tag suggestions without making tag entry depend on the network request.
 * @param section The browser section whose visible recipe tags are requested.
 */
async function tagOptions(section) {
  try {
    return await api("tags?" + new URLSearchParams({ scope: section }));
  } catch {
    return [];
  }
}

/**
 * Load one page and show the filters, matching revisions, and navigation.
 * @param section The active list section in the browser.
 */
async function listingPage(section) {
  const filters = new URLSearchParams(location.search);
  const cursor = filters.get("cursor");
  const endpoint = { library: "search", mine: "mine", review: "queue" }[section];
  const path = listingPath(section, filters, cursor);
  const params = new URL(path, location.origin).search;
  const suggestions = tagOptions(section);
  const { items, previousCursor, nextCursor } = await api(endpoint + params);
  const tags = await suggestions;
  const active = filters.get("query") || filters.get("tag") || filters.get("state");
  const descriptions = {
    library: t("browse-published-recipes"),
    mine: t("track-your-submissions-and-review-feedback"),
    review: t("inspect-changes-record-a-decision-and-publish-approved"),
  };
  const emptyLabels = {
    library: t("no-published-recipes-yet"),
    mine: t("no-revisions-yet"),
    review: t("review-queue-is-empty"),
  };
  const emptyDetails = {
    library: t("submit-a-recipe-for-review-to-start-your"),
    mine: t("your-submitted-snapshots-will-appear-here"),
    review: t("pending-reviews-and-approved-revisions-waiting-to-publish"),
  };
  return [
    title(labels[section], descriptions[section]),
    section === "library" &&
      el(
        "div",
        { className: "actions" },
        buttonLink(t("download-finnish-skill"), "/api/skill?name=suomenkieli"),
        buttonLink(t("download-caveman-skill"), "/api/skill?name=caveman"),
      ),
    listingForm(section, filters, tags),
    items.length
      ? list(items, section, filters)
      : empty(
          active || cursor ? t("no-matching-recipes") : emptyLabels[section],
          active || cursor ? "" : emptyDetails[section],
          cursor
            ? buttonLink(t("first-page"), listingPath(section, filters))
            : section === "library" && !active
              ? buttonLink(t("contribute-a-recipe"), "/contribute")
              : null,
        ),
    (previousCursor || nextCursor) &&
      el(
        "nav",
        { className: "list-pagination", "aria-label": t("page-navigation") },
        previousCursor &&
          buttonLink(t("previous-page"), listingPath(section, filters, previousCursor)),
        nextCursor && buttonLink(t("next-page"), listingPath(section, filters, nextCursor)),
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
 * Ask whether to submit after reviewing acknowledgeable findings.
 * @param message Findings returned by the server.
 * @param heading The visible warning category.
 */
function confirmSubmissionWarning(message, heading) {
  return new Promise((resolve) => {
    const cancel = btn(t("cancel"), () => dialog.close());
    const proceed = btn(t("submit-anyway"), () => dialog.close("continue"), "primary");
    const dialog = el(
      "dialog",
      { className: "revision-dialog", "aria-labelledby": "submission-warning-heading" },
      el("h2", { id: "submission-warning-heading" }, heading),
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
 * Retry a complete snapshot only after the author accepts each warning.
 * @param payload Recipe snapshot or selected file and its expected edit version.
 * @param path Same-origin submission endpoint that validates and saves this edit.
 */
async function submitWithWarnings(payload, path = "submit") {
  let attempt = payload;
  for (;;) {
    try {
      return await api(path, attempt);
    } catch (error) {
      if (error.code === "duplicate_warning" && !attempt.allowDuplicates) {
        if (!(await confirmSubmissionWarning(error.message, t("duplicate-content")))) {
          return null;
        }
        attempt = { ...attempt, allowDuplicates: true };
      } else if (
        error.code === "llm_warning" &&
        error.reviewReceipt &&
        error.reviewReceipt !== attempt.reviewReceipt
      ) {
        if (!(await confirmSubmissionWarning(error.message, t("llm-review-warnings")))) {
          return null;
        }
        attempt = { ...attempt, reviewReceipt: error.reviewReceipt };
      } else {
        throw error;
      }
    }
  }
}

/**
 * Edit an ordered set of recipe tags through a dropdown and free text.
 * @param initial Tags already attached to the revision, if any.
 * @param suggestions Existing tags available to this contributor.
 */
function recipeTagPicker(initial, suggestions) {
  let tags = [...initial];
  const entry = field("tagEntry", t("tags-separated-by-commas"), {
    placeholder: t("arrays-utilities"),
    maxlength: 280,
  });
  const input = entry.querySelector("input");
  const selected = el("div", { className: "selected-tags" });
  const select = el(
    "select",
    {},
    el("option", { value: "" }, t("choose-tag")),
    ...suggestions.map((tag) => el("option", { value: tag }, tag)),
  );

  /** Show selected tags and disable options that cannot add another tag. */
  function sync() {
    selected.replaceChildren(
      ...tags.map((tag) => {
        const remove = btn(
          tag + " ×",
          () => {
            tags = tags.filter((current) => current !== tag);
            input.setCustomValidity("");
            sync();
            input.focus();
          },
          "chip tag-remove",
        );
        remove.setAttribute("aria-label", t("remove-tag") + " " + tag);
        return remove;
      }),
    );
    for (const option of select.options) {
      option.disabled = Boolean(option.value) && (tags.includes(option.value) || tags.length >= 8);
    }
  }

  /**
   * Add normalized tags if the updated set fits the submission limits.
   * @param additions Tags selected from the list or entered in the text field.
   */
  function add(additions) {
    const next = [
      ...new Set([...tags, ...additions.map((tag) => tag.trim().toLowerCase()).filter(Boolean)]),
    ];
    let error = "";
    if (next.length > 8) {
      error = t("tag-count-limit");
    } else if (next.some((tag) => tag.length > 32)) {
      error = t("tag-length-limit");
    }
    input.setCustomValidity(error);
    if (error) {
      input.reportValidity();
      return false;
    }
    tags = next;
    sync();
    return true;
  }

  /** Commit typed tags and return a snapshot ready to submit. */
  function read() {
    if (!add(input.value.split(","))) {
      return null;
    }
    input.value = "";
    return [...tags];
  }

  select.addEventListener("change", () => {
    if (select.value) {
      add([select.value]);
      select.value = "";
    }
  });
  input.addEventListener("input", () => input.setCustomValidity(""));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      read();
    }
  });
  sync();
  return {
    node: el(
      "fieldset",
      { className: "recipe-tags" },
      el("legend", {}, t("recipe-tags")),
      el(
        "div",
        { className: "pair" },
        el("div", { className: "tag-entry" }, entry, btn(t("add-tags"), read)),
        suggestions.length && el("label", {}, t("existing-tag"), select),
      ),
      selected,
    ),
    read,
    /**
     * Replace the current selection when filling an example.
     * @param values Tags provided by the example recipe.
     */
    set(values) {
      tags = [...values];
      select.value = "";
      input.value = "";
      input.setCustomValidity("");
      sync();
    },
  };
}

/**
 * Build the form for creating, editing, or proposing a recipe revision.
 * @param recipe The optional revision used to prefill the form.
 * @param replace Whether to update the existing draft in place.
 */
async function contribute(recipe, replace = false) {
  const isRevision = Boolean(recipe?.id);
  const picker = recipeTagPicker(recipe?.tags ?? [], await tagOptions("contribute"));
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
        const tags = picker.read();
        if (!tags) {
          return;
        }
        const data = Object.fromEntries(new FormData(form));
        const included = Object.keys(parts).filter((part) => data[part].trim());
        const submit = form.querySelector("[type=submit]");
        submit.disabled = true;
        banner();
        try {
          const result = await submitWithWarnings({
            slug: data.slug,
            title: data.title,
            summary: data.summary,
            ...(replace
              ? { replace: recipe.id, editVersion: recipe.editVersion }
              : { base: recipe?.id }),
            tags,
            files: Object.fromEntries(included.map((part) => [part, data[part]])),
            fileNames: Object.fromEntries(
              included.map((part) => [part, data["filename-" + part].trim()]),
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
          navigate(routeRecipe(result, "mine"));
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
    picker.node,
    ...["source", "interface", "tests", "styles", "documentation", "instructions"]
      .map((key) => [key, parts[key]])
      .map(([key, name]) =>
        el(
          "div",
          { className: "recipe-file-fields" },
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
          field(
            "filename-" + key,
            t("filename") + " · " + name,
            { maxlength: 96, placeholder: t("default-filename"), spellcheck: "false" },
            recipe?.fileNames?.[key] ?? "",
          ),
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
          picker.set(example.tags);
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
 * Render a code listing with its line numbers and optional inline review.
 * @param lines The lines to display in source order.
 * @param wrap Whether line wrapping is enabled in the viewer.
 * @param label The viewer's accessible label.
 * @param review File review context, when real source lines can receive comments.
 */
function codeBox(lines, wrap, label, review) {
  return el(
    "div",
    {
      className: "code-box" + (wrap ? " wrap" : ""),
      tabindex: "0",
      role: "group",
      "aria-label": label,
    },
    ...lines.map((line, index) => codeRow(line, index + 1, review)),
  );
}

/**
 * Show one source line and give reviewers a mouse and keyboard comment target.
 * @param row The displayed text, marker, and optional diff style.
 * @param number The one-based line number in the current file.
 * @param review File feedback and permissions, when comments are available.
 */
function codeRow(row, number, review) {
  const { value, marker, style } = row;
  const comments = review?.current.get(number) ?? [];
  const thread =
    (review?.canComment || comments.length > 0) &&
    el("div", { className: "line-comment-thread" }, ...comments.map(reviewCommentText));
  /**
   * Open the inline composer underneath this line and save feedback at its anchor.
   */
  function comment() {
    openCommentComposer(thread, trigger, (body) =>
      saveReviewComment(review.recipe, review.part, number, body),
    );
  }
  const trigger = review?.canComment && btn(marker, comment, "line-marker comment-line-button");
  if (trigger) {
    const label = t("comment-on-line") + " " + number;
    trigger.setAttribute("aria-label", label);
    trigger.title = label;
  }
  const line = el(
    "div",
    { className: "code-line " + (style ?? "") + (trigger ? " commentable-line" : "") },
    trigger || el("span", { className: "line-marker", "aria-hidden": "true" }, marker),
    el(
      "code",
      { className: "line-value" },
      style &&
        el(
          "span",
          { className: "visually-hidden" },
          style === "diff-added" ? t("added") : t("removed"),
        ),
      value?.nodeType ? value : value || " ",
    ),
  );
  if (trigger) {
    line.addEventListener("click", (event) => {
      if (event.target !== trigger && window.getSelection()?.isCollapsed !== false) {
        comment();
      }
    });
  }
  return el("div", {}, line, thread);
}

/**
 * Render line changes against the baseline identified in the comparison heading.
 * @param before The previous text used as the diff baseline.
 * @param after The current text to compare with the baseline.
 * @param wrap Whether source lines wrap in the viewer.
 * @param baseline Localized label identifying the saved file or revision being compared.
 */
function diff(before, after, wrap, baseline = t("compared-with-base-revision")) {
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
      baseline,
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
 * Open an inline composer for a whole file or a source line.
 * @param comments Container that holds the feedback and composer.
 * @param trigger Button used to open the composer and restore focus on close.
 * @param submit Callback that saves the comment and returns the stored row.
 */
function openCommentComposer(comments, trigger, submit) {
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
      className: "review-comment-form",
      /**
       * Send the note and update the current comment thread.
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
          comments.insertBefore(reviewCommentText(saved), form);
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
    el("div", { className: "review-comment-actions" }, cancel, save),
  );
  comments.append(form);
  input.focus();
}

/**
 * Save private feedback and keep it in the current view when switching display modes.
 * @param recipe Revision and edit version receiving the feedback.
 * @param part File part the reviewer is commenting on.
 * @param line One-based line number or null for the whole file.
 * @param body The reviewer's comment text.
 */
async function saveReviewComment(recipe, part, line, body) {
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
}

/**
 * Group earlier comments separately from comments on the current file lines.
 * @param recipe Revision and its visible review history.
 * @param part File part that owns these comments.
 */
function fileComments(recipe, part) {
  const current = new Map();
  const earlier = [];
  for (const item of recipe.review?.comments ?? []) {
    if (item.part !== part) {
      continue;
    }
    if (item.editVersion === recipe.editVersion) {
      const comments = current.get(item.line) ?? [];
      comments.push(item);
      current.set(item.line, comments);
    } else {
      earlier.push(item);
    }
  }
  return { current, earlier };
}

/**
 * Show feedback retained from earlier draft versions with its original anchor.
 * @param comments Comments from earlier edits of the current file.
 */
function earlierComments(comments) {
  return (
    comments.length > 0 &&
    el(
      "section",
      { className: "earlier-comments" },
      el("h4", {}, t("comments-on-earlier-edits")),
      ...comments.map((comment) =>
        el(
          "div",
          { className: "historical-comment" },
          comment.line === null
            ? el("strong", {}, t("whole-file"))
            : el("code", {}, t("line") + " " + comment.line + " · " + comment.excerpt),
          reviewCommentText(comment),
        ),
      ),
    )
  );
}

/**
 * Build the visible metadata and body for one review comment.
 * @param comment The saved review comment and its anchor.
 */
function reviewCommentText(comment) {
  return el(
    "div",
    { className: "review-comment" },
    el("strong", {}, comment.authorName || t("reviewer")),
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
  const warnings = fileWarnings(key);
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
    recipe.fileNames?.[key] && el("code", { className: "recipe-filename" }, recipe.fileNames[key]),
  );
  const area = el("div", { id: "recipe-part-content-" + key });
  const status = el("span", { className: "copy-status", role: "status" });
  const { current, earlier } = fileComments(recipe, key);
  const canComment = recipe.review?.canComment && value !== undefined;
  const edit =
    recipe.canReplace &&
    value !== undefined &&
    btn(t("edit-file"), async () => {
      const result = await editRecipeFile(recipe, key, submitWithWarnings, diff);
      if (result && heading.isConnected) {
        await render();
        const target = document.getElementById(heading.id);
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: "start" });
        banner([t("draft-resubmitted-for-review"), ...(result.warnings ?? [])].join("\n"));
      }
    });
  if (edit) {
    labelFileTool(edit, "edit", t("edit-file"));
  }
  const feedback = el(
    "div",
    { className: "file-comment-thread" },
    ...(current.get(null) ?? []).map(reviewCommentText),
  );
  const fileComment =
    canComment &&
    btn(t("comment-on-file"), () =>
      openCommentComposer(feedback, fileComment, (body) =>
        saveReviewComment(recipe, key, null, body),
      ),
    );
  if (fileComment) {
    labelFileTool(fileComment, "comment", t("comment-on-file"));
  }
  let raw = prose && [...current.keys()].some(Number.isInteger);
  let comparing = false;
  let wrap = true;
  let code;
  let markdown;
  const compare =
    hasBase &&
    btn(t("show-changes"), () => {
      comparing = !comparing;
      renderPart();
    });
  const markdownSource =
    prose &&
    value !== undefined &&
    btn(t("markdown-source"), () => {
      raw = comparing || !raw;
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
    if (markdownSource) {
      labelFileTool(
        markdownSource,
        raw && !comparing ? "doc" : "code",
        raw && !comparing ? t("rendered-markdown") : t("markdown-source"),
      );
      markdownSource.setAttribute("aria-pressed", String(raw && !comparing));
    }
    wrapButton.hidden = !comparing && (value === undefined || (prose && !raw));
    wrapButton.setAttribute("aria-pressed", String(wrap));
    copy.hidden = value === undefined || comparing;
    let content;
    if (comparing) {
      content = diff(previous, value, wrap);
    } else if (value === undefined) {
      content = el("p", { className: "file-empty" }, t("this-revision-omits-this-file"));
    } else if (prose && !raw) {
      content = markdown ??= readableMarkdown(value);
    } else {
      if (!code) {
        const lines = prose
          ? sourceLines(value).map((value, index) => ({ value, marker: String(index + 1) }))
          : highlightedLines(value, key === "styles" ? "css" : "typescript");
        code = codeBox(lines, wrap, name, {
          recipe,
          part: key,
          current,
          canComment,
        });
      }
      code.classList.toggle("wrap", wrap);
      content = code;
    }
    if (area.firstChild !== content) {
      area.replaceChildren(content);
    }
  }
  for (const control of [compare, markdownSource, wrapButton].filter(Boolean)) {
    control.setAttribute("aria-controls", area.id);
  }
  renderPart();
  return {
    heading,
    name,
    warnings,
    section: el(
      "section",
      { className: "panel recipe-part", "aria-labelledby": heading.id },
      heading,
      el(
        "div",
        { className: "file-tools" },
        compare,
        markdownSource,
        fileComment,
        edit,
        wrapButton,
        copy,
        status,
      ),
      el("div", {}, warnings.list, feedback, area, earlierComments(earlier)),
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
    ...files.map(({ heading, name, warnings }) => {
      const button = btn(name, () => {
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: "start" });
      });
      button.append(warnings.marker);
      return button;
    }),
  );
  const view = el(
    "section",
    { className: "section file-viewer", "aria-labelledby": "recipe-files-heading" },
    el("h2", { id: "recipe-files-heading", className: "visually-hidden" }, t("recipe-files")),
    navigate,
    ...files.map(({ section }) => section),
  );
  /**
   * Update findings in place so reading position and open comment forms are preserved.
   * @param findings All saved findings visible to this viewer for the selected edit.
   */
  function showWarnings(findings) {
    for (const { warnings } of files) {
      warnings.update(findings);
    }
  }
  showWarnings(recipe.llmWarnings ?? []);
  return { view, showWarnings };
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
 * Mark an affected file in section navigation and display each warning above its content.
 * @param part Recipe file part whose findings belong in this section.
 */
function fileWarnings(part) {
  const label = t("llm-review-warnings");
  const marker = el(
    "span",
    { className: "file-warning-marker", hidden: "", title: label },
    icon("warning"),
    el("span", { className: "visually-hidden" }, " " + label),
  );
  const list = el("ul", { className: "file-warnings", hidden: "", "aria-label": label });
  /**
   * Keep the section marker and inline warning text in sync after a recheck.
   * @param findings Saved findings for the current revision.
   */
  function update(findings) {
    const warnings = findings.filter((finding) => finding.part === part);
    list.replaceChildren(
      ...warnings.map(({ reason }) => el("li", {}, icon("warning"), el("span", {}, reason))),
    );
    list.hidden = !warnings.length;
    marker.hidden = list.hidden;
  }
  return { list, marker, update };
}

/**
 * Present a fresh, advisory check for this open revision, including its pending and empty states.
 * @param recipe Stored snapshot with its revision ID, edit version and filenames.
 * @param showWarnings Refresh the revision's saved warnings after a successful check.
 */
function revisionRecheck(recipe, showWarnings) {
  const heading = el(
    "h2",
    { id: "revision-recheck-heading", tabindex: "-1" },
    t("llm-recheck-title"),
  );
  const status = el("p", { role: "status" });
  const details = el("div");
  const dismiss = btn(t("llm-recheck-dismiss"), () => {
    view.hidden = true;
    toolbar.querySelector(".revision-trigger")?.focus();
  });
  const view = el(
    "section",
    { hidden: "", className: "revision-recheck", "aria-labelledby": heading.id },
    el("div", { className: "recheck-heading" }, heading, dismiss),
    status,
    details,
  );
  let running = false;
  /** Run the current rules once per request and show the findings saved by the server. */
  async function run() {
    view.hidden = false;
    heading.focus();
    if (running) {
      return;
    }
    running = true;
    details.replaceChildren();
    status.classList.remove("revision-action-error");
    status.textContent = t("llm-recheck-running");
    try {
      const report = await api("review/recheck", {
        slug: recipe.slug,
        revision: recipe.id,
        editVersion: recipe.editVersion,
      });
      showWarnings(report.savedWarnings);
      if (!report.checkedParts.length) {
        status.textContent = t("llm-recheck-empty");
        return;
      }
      status.textContent = report.warnings.length
        ? t("llm-recheck-warnings")
        : t("llm-recheck-clean");
      const names = report.checkedParts.map((part) => recipe.fileNames?.[part] ?? parts[part]);
      details.append(
        el(
          "p",
          { className: "muted" },
          t("llm-recheck-files").replace("{files}", names.join(", ")),
        ),
      );
    } catch (error) {
      status.classList.add("revision-action-error");
      status.textContent = error.message;
    } finally {
      running = false;
    }
  }
  return { view, run };
}

/**
 * List the actions available for the current revision and viewer.
 * @param recipe Loaded revision with the author's permissions and review status.
 * @param recheck Optional callback for a maintainer's advisory review.
 */
function revisionChoices(recipe, recheck) {
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
  if (recheck) {
    choices.push({ label: t("llm-recheck-action"), run: recheck });
  }
  if (recipe.state !== "quarantined") {
    choices.push({
      label: recipe.canReplace ? t("edit-draft") : t("propose-an-improvement"),
      href:
        (recipe.canReplace ? "/edit/" : "/improve/") +
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
 * @param recheck Optional action that checks the displayed edit in place.
 */
function revisionControls(recipe, section, recheck) {
  // Readers can propose an improvement. Only maintainers can see quarantined revisions.
  const choices = revisionChoices(recipe, recheck);
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
  const page = location.pathname;
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
    if (location.pathname !== page) {
      return;
    }
    banner(action === "publish" ? t("recipe-published") : t("revision-updated"), false, true);
    if (["remove_draft", "approve_removal"].includes(action)) {
      navigate(listingPaths.get(section) ?? "/" + section);
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
            if (choice.run) {
              void choice.run();
            } else {
              showRevisionAction(choice, submit, trigger);
            }
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
  const files = fileViewer(recipe, base);
  const recheck = maintainer ? revisionRecheck(recipe, files.showWarnings) : null;
  const filters = new URL(listingPaths.get(section) ?? "/" + section, location.origin).searchParams;
  return {
    actions: revisionControls(recipe, section, recheck?.run),
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
          ...recipe.tags.map((tag) => tagLink(tag, section, filters)),
          recipe.state === "published" &&
            (recipe.files.instructions || recipe.files.documentation) &&
            buttonLink(
              t("download-skill"),
              "/api/skill?" + new URLSearchParams({ slug, revision: recipe.id }),
            ),
        ),
      ),
      recheck?.view,
      recipe.review_note && el("p", { className: "panel" }, recipe.review_note),
      recipe.removal_reason &&
        el("p", { className: "panel" }, t("removal-requested") + recipe.removal_reason),
      files.view,
      el(
        "dl",
        { className: "revision-meta" },
        el("div", {}, el("dt", {}, t("recipe-slug")), el("dd", {}, el("code", {}, recipe.slug))),
        el("div", {}, el("dt", {}, t("revision-id")), el("dd", {}, el("code", {}, recipe.id))),
      ),
    ],
  };
}

/**
 * Populate reasoning choices using the selected model's documented capabilities.
 * @param select The reasoning control associated with the model.
 * @param model The exact selected model ID.
 * @param saved Previously selected effort to retain when supported.
 */
function updateReasoningChoices(select, model, saved) {
  const options = reasoningOptions(model);
  const defaultEffort = effectiveReasoning(model, "");
  select.replaceChildren(
    el(
      "option",
      { value: "" },
      t("openai-model-default") + (defaultEffort ? " (" + defaultEffort + ")" : ""),
    ),
    ...options.map((effort) => el("option", { value: effort }, effort)),
  );
  select.value = options.includes(saved) ? saved : "";
}

/**
 * Load the saved key's catalog and let the maintainer save the conversation model and effort.
 * @param initial Saved model and key status.
 */
function openAiModelPicker(initial) {
  let state = initial;
  let request = 0;
  const select = el("select", { name: "model", required: "" });
  const reasoning = el("select", { name: "reasoningEffort" });
  const status = el("p", { role: "status", className: "muted" });
  const save = el("button", { type: "submit", className: "primary" }, t("openai-save-model"));
  const refreshButton = btn(t("openai-load-models"), () => void refresh());
  /**
   * Fetch current models, discarding a result if the key changed during the request.
   */
  async function refresh() {
    const current = ++request;
    select.replaceChildren(el("option", { value: "" }, t("openai-choose-model")));
    select.disabled = true;
    reasoning.disabled = true;
    save.disabled = true;
    refreshButton.disabled = true;
    if (!state.hasCredential || !state.encryptionAvailable) {
      status.textContent = t("openai-key-first");
      return;
    }
    status.textContent = t("openai-loading-models");
    try {
      const catalog = await api("assistant/models");
      if (current !== request) {
        return;
      }
      if (catalog.status === "ready" && catalog.models.length) {
        select.append(...catalog.models.map((model) => el("option", { value: model }, model)));
        select.disabled = false;
        select.value = catalog.models.includes(state.model)
          ? state.model
          : catalog.models.includes("gpt-6.2-sol")
            ? "gpt-6.2-sol"
            : "";
        status.textContent = state.model && !select.value ? t("assistant-model-missing") : "";
        reasoning.disabled = false;
        updateReasoningChoices(
          reasoning,
          select.value,
          state.model === select.value ? state.reasoningEffort : "",
        );
        save.disabled = !select.value || select.value === state.model;
      } else if (catalog.status === "unauthorized") {
        status.textContent = t("assistant-model-unauthorized");
      } else {
        status.textContent = t("assistant-model-unavailable");
      }
    } catch (error) {
      if (current === request) {
        status.textContent = error.message;
      }
    } finally {
      if (current === request) {
        refreshButton.disabled = false;
      }
    }
  }
  select.addEventListener("change", () => {
    updateReasoningChoices(
      reasoning,
      select.value,
      select.value === state.model ? state.reasoningEffort : "",
    );
    save.disabled = !select.value || select.value === state.model;
  });
  reasoning.addEventListener("change", () => {
    save.disabled =
      !select.value || (select.value === state.model && reasoning.value === state.reasoningEffort);
  });
  const form = el(
    "form",
    {
      className: "panel form",
      /**
       * Save the selected catalog entry without editing the key.
       * @param event Model form submission.
       */
      onsubmit: async (event) => {
        event.preventDefault();
        const model = select.value;
        if (!model || save.disabled) {
          return;
        }
        const current = request;
        save.disabled = true;
        select.disabled = true;
        refreshButton.disabled = true;
        try {
          const updated = await api("settings/openai", { model, reasoningEffort: reasoning.value });
          if (current === request) {
            state = updated;
            status.textContent = t("openai-model-saved");
          }
        } catch (error) {
          if (current === request) {
            status.textContent = error.message;
            save.disabled = false;
          }
        } finally {
          if (current === request) {
            select.disabled = false;
            refreshButton.disabled = false;
          }
        }
      },
    },
    el("h2", {}, t("openai-model")),
    el("label", {}, t("openai-choose-model"), select),
    el("label", {}, t("openai-reasoning-effort"), reasoning),
    el("div", { className: "actions" }, save, refreshButton),
    status,
  );
  void refresh();
  return {
    form,
    /**
     * Reload the catalog with the latest credential from the server.
     * @param updated Metadata returned after the credential changes.
     */
    update(updated) {
      state = updated;
      void refresh();
    },
  };
}

/**
 * Build the OpenAI settings form with a write-only credential field.
 * @param settings Current model, credential presence and encryption readiness.
 */
function openAiSettingsForm(settings) {
  const picker = openAiModelPicker(settings);
  const key = field("apiKey", t("openai-key"), {
    type: "password",
    autocomplete: "new-password",
    maxlength: 512,
    spellcheck: "false",
    required: "",
    "aria-describedby": "openai-key-permissions",
  });
  key.querySelector("input").disabled = !settings.encryptionAvailable;
  const keyStatus = el("p", { className: "muted" });
  const result = el("p", { role: "status" });
  const save = el("button", { type: "submit", className: "primary" }, t("openai-save"));
  const remove = btn(t("openai-remove"), () => {
    confirmation.hidden = false;
    confirmRemove.focus();
  });
  const cancel = btn(t("cancel"), () => {
    confirmation.hidden = true;
    remove.focus();
  });
  const confirmRemove = btn(t("openai-confirm-remove"), async () => {
    confirmRemove.disabled = true;
    cancel.disabled = true;
    save.disabled = true;
    try {
      const state = await api("settings/openai/remove-key", {});
      update(state);
      picker.update(state);
      result.textContent = t("openai-removed");
      confirmation.hidden = true;
      save.disabled = false;
      save.focus();
    } catch (error) {
      result.textContent = error.message;
    } finally {
      confirmRemove.disabled = false;
      cancel.disabled = false;
      save.disabled = false;
    }
  });
  const confirmation = el(
    "div",
    { hidden: "" },
    el("p", {}, t("openai-remove-help")),
    el("div", { className: "actions" }, confirmRemove, cancel),
  );
  /**
   * Update the visible status without populating the credential field.
   * @param state Metadata returned by the settings endpoint.
   */
  function update(state) {
    keyStatus.textContent = state.hasCredential
      ? t("openai-key-configured")
      : t("openai-key-missing");
    remove.hidden = !state.hasCredential;
  }
  update(settings);
  const form = el(
    "form",
    {
      className: "panel form",
      /**
       * Save or replace the credential without changing the model.
       * @param event Browser submission event for the OpenAI settings section.
       */
      onsubmit: async (event) => {
        event.preventDefault();
        const input = event.currentTarget.elements;
        const replacement = input.apiKey.value.trim();
        input.apiKey.value = "";
        save.disabled = true;
        remove.disabled = true;
        confirmation.hidden = true;
        result.textContent = "";
        try {
          const state = await api("settings/openai", { apiKey: replacement });
          update(state);
          picker.update(state);
          result.textContent = t("openai-saved");
        } catch (error) {
          result.textContent = error.message;
        } finally {
          save.disabled = false;
          remove.disabled = false;
        }
      },
    },
    el("h2", {}, t("openai-api-key")),
    !settings.configured &&
      el(
        "p",
        { className: "muted" },
        t("openai-review-setup"),
        " ",
        el("a", { href: "/settings/llm-review" }, t("llm-review-settings")),
      ),
    el(
      "p",
      { id: "openai-key-permissions", className: "muted" },
      t("openai-key-permissions"),
      " ",
      el(
        "a",
        { href: "https://developers.openai.com/api/docs/guides/rbac" },
        t("openai-permissions-docs"),
      ),
    ),
    key,
    keyStatus,
    !settings.encryptionAvailable &&
      el("p", { className: "muted" }, t("openai-encryption-missing")),
    el("div", { className: "actions" }, save, remove),
    confirmation,
    result,
  );
  return [form, picker.form];
}

/** Build the maintainer’s recipe quality settings form. */
async function codePolicyPage() {
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

/**
 * Keep enough recent chat text for follow-up questions within the request budget.
 * @param turns Successful user and assistant messages from this panel.
 */
function recentAssistantHistory(turns) {
  const history = turns
    .slice(-8)
    .map(({ role, content }) => ({ role, content: content.slice(0, 1_200) }));
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(history)).byteLength > 12_000) {
    history.shift();
  }
  return history;
}

/** Build the Assistant transcript and composer, both retained across navigation. */
async function assistantContent() {
  const { configured, docsSearch, context7Search } = await api("assistant");
  if (!configured) {
    return [
      el("p", {}, t("assistant-unconfigured")),
      buttonLink(t("openai-settings"), "/settings/openai"),
    ];
  }

  const turns = [];
  const transcript = el("div", { className: "assistant-transcript", role: "log" });
  const status = el("div", { role: "status", className: "muted" });
  const question = el("textarea", {
    name: "question",
    "aria-label": t("assistant-question"),
    placeholder: t("assistant-placeholder"),
    maxlength: 4000,
    rows: 2,
    required: "",
  });
  const send = el("button", { className: "primary", type: "submit" }, t("assistant-ask"));
  const docs = el(
    "fieldset",
    { id: "assistant-docs-options", className: "assistant-docs-options", hidden: "" },
    field("docsQuery", t("assistant-docs-query"), {
      maxlength: 160,
      "aria-describedby": "assistant-docs-help",
    }),
    context7Search &&
      field("libraryId", t("assistant-context7-library"), {
        maxlength: 160,
        placeholder: t("assistant-context7-example"),
      }),
    el("p", { id: "assistant-docs-help", className: "muted" }, t("assistant-docs-help")),
  );
  docs.disabled = true;
  const docsButton =
    (docsSearch || context7Search) &&
    btn(t("assistant-docs-action"), () => {
      docs.hidden = !docs.hidden;
      docs.disabled = docs.hidden;
      docsButton.setAttribute("aria-expanded", String(!docs.hidden));
      if (!docs.hidden) {
        docs.querySelector("input").focus();
      }
    });
  if (docsButton) {
    docsButton.setAttribute("aria-controls", docs.id);
    docsButton.setAttribute("aria-expanded", "false");
  }

  return [
    transcript,
    el(
      "form",
      {
        className: "assistant-composer",
        /**
         * Append a successful exchange and retain the draft if the request fails.
         * @param event Form submission containing the message and optional lookup terms.
         */
        onsubmit: async (event) => {
          event.preventDefault();
          const content = question.value.trim();
          if (!content || send.disabled) {
            return;
          }
          const data = new FormData(event.currentTarget);
          send.disabled = true;
          question.value = "";
          const pending = el("div", { className: "assistant-question" }, content);
          transcript.append(pending);
          transcript.scrollTop = transcript.scrollHeight;
          status.textContent = t("assistant-working");
          try {
            const { answer, sources, docsSources } = await api("assistant", {
              question: content,
              history: recentAssistantHistory(turns),
              docsQuery: data.get("docsQuery")?.trim(),
              libraryId: data.get("libraryId")?.trim(),
            });
            const links = [
              ...sources.map(({ slug, id, title }) => ({
                href: routeRecipe({ slug, id }, "library"),
                title,
              })),
              ...docsSources.map(({ url, title }) => ({ href: url, title })),
            ];
            turns.push({ role: "user", content }, { role: "assistant", content: answer });
            transcript.append(
              el(
                "div",
                {},
                el("div", { className: "assistant-answer" }, answer),
                links.length
                  ? el(
                      "ul",
                      {},
                      ...links.map(({ href, title }) => el("li", {}, el("a", { href }, title))),
                    )
                  : null,
              ),
            );
            transcript.scrollTop = transcript.scrollHeight;
            status.textContent = "";
          } catch (error) {
            pending.remove();
            if (!question.value) {
              question.value = content;
            }
            status.textContent = error.message;
          } finally {
            send.disabled = false;
          }
        },
      },
      status,
      docs,
      question,
      el("div", { className: "actions" }, send, docsButton),
      el("small", { className: "muted" }, t("assistant-data-use")),
    ),
  ];
}

/** Close the Assistant while keeping its current draft and answer available. */
function closeAssistant() {
  assistantPanel.hidden = true;
  assistantToggle.setAttribute("aria-expanded", "false");
  assistantToggle.focus();
}

/**
 * Resize the open desktop chat without squeezing the page below its minimum width.
 * @param requested The new width in CSS pixels, or the current width to announce.
 */
function resizeAssistant(requested) {
  const workspace = assistantPanel.parentElement;
  const maximum = Math.max(300, Math.min(800, workspace.clientWidth - 360));
  const width = Math.round(assistantPanel.getBoundingClientRect().width);
  const actual = Math.min(maximum, Math.max(300, requested ?? width));
  if (requested !== undefined) {
    workspace.style.setProperty("--assistant-width", actual + "px");
  }
  assistantResize.setAttribute("aria-valuemax", String(maximum));
  assistantResize.setAttribute("aria-valuenow", String(actual));
}

/** Open the Assistant beside the current page, loading its form on first use. */
async function openAssistant() {
  assistantPanel.hidden = false;
  resizeAssistant();
  assistantToggle.setAttribute("aria-expanded", "true");
  assistantClose.focus();
  const question = assistantView.querySelector('[name="question"]');
  if (question || assistantLoading) {
    question?.focus();
    return;
  }
  assistantLoading = true;
  assistantView.replaceChildren(el("p", { role: "status" }, t("assistant-loading")));
  try {
    assistantView.replaceChildren(...(await assistantContent()).filter(Boolean));
    if (!assistantPanel.hidden && assistantPanel.contains(document.activeElement)) {
      assistantView.querySelector('[name="question"]')?.focus();
    }
  } catch (error) {
    assistantView.replaceChildren(
      el("p", { role: "status" }, error.message),
      btn(t("retry"), openAssistant),
    );
  } finally {
    assistantLoading = false;
  }
}

/** Build the maintainer controls and a read-only check for Bist's MCP tool list. */
async function mcpSettingsForm() {
  const { enabled, enabledTools, tools } = await api("settings/mcp");
  const endpoint = new URL("/mcp", location.origin);
  const active = el("input", { type: "checkbox", name: "enabled" });
  active.checked = enabled;
  const status = el("p", { role: "status", className: "muted" });
  const save = el("button", { type: "submit", className: "primary" }, t("mcp-save"));
  const check = btn(t("mcp-check"), async () => {
    check.disabled = true;
    status.textContent = "";
    try {
      const { tools: available } = await api("settings/mcp/check");
      status.textContent = available.length ? t("mcp-check-ready") : t("mcp-check-empty");
    } catch {
      status.textContent = t("mcp-check-failed");
    } finally {
      check.disabled = false;
    }
  });
  return el(
    "form",
    {
      className: "panel form",
      /**
       * Save the instance's tool switch and selected capabilities.
       * @param event Submission from the maintainer's MCP form.
       */
      onsubmit: async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        save.disabled = true;
        status.textContent = "";
        try {
          await api("settings/mcp", {
            enabled: data.has("enabled"),
            enabledTools: data.getAll("enabledTool"),
          });
          status.textContent = t("mcp-saved");
        } catch (error) {
          status.textContent = error.message;
        } finally {
          save.disabled = false;
        }
      },
    },
    field("endpoint", t("mcp-endpoint"), { type: "url", readonly: "" }, endpoint.href),
    el("label", { className: "setting-toggle" }, t("mcp-enable"), active),
    el(
      "div",
      { className: "policy-fields" },
      ...tools.map(({ name, description }) => {
        const control = el("input", { type: "checkbox", name: "enabledTool", value: name });
        control.checked = enabledTools.includes(name);
        const id = "mcp-tool-" + name;
        control.setAttribute("aria-labelledby", id);
        control.setAttribute("aria-describedby", id + "-help");
        return el(
          "label",
          { className: "setting-toggle" },
          el(
            "span",
            {},
            el("code", { id }, name),
            el("br"),
            el("span", { id: id + "-help", className: "muted" }, description),
          ),
          control,
        );
      }),
    ),
    el("div", { className: "actions" }, save, check),
    status,
  );
}

/** List every Assistant integration and save each switch as an independent setting. */
async function assistantAddOns() {
  const [openAi, context7, policy] = await Promise.all([
    api("settings/mcp/openai-docs"),
    api("settings/mcp/context7"),
    api("settings/mcp/skills"),
  ]);
  let enabled = policy.enabled;
  const details = {
    caveman: [
      t("skill-caveman-description"),
      "cms-assistant-skill-caveman/af8ed8d9-e24f-4db3-b9f4-d40af87771a4",
    ],
    suomenkieli: [
      t("skill-finnish-description"),
      "cms-assistant-skill-finnish/6bd4384b-3496-4778-8cbe-a57f91c8535f",
    ],
    seo: [
      t("skill-seo-description"),
      "cms-assistant-skill-seo/f21ae44b-dcf9-4cb0-9aba-ead2c514fa16",
    ],
    design: [
      t("skill-design-description"),
      "cms-assistant-skill-design/ea7aef17-bb39-4e44-87ad-718f225930fd",
    ],
    import: [
      t("skill-import-description"),
      "cms-assistant-skill-import/3aa2200b-08a2-4965-91bc-b97136fde80d",
    ],
    publication: [
      t("skill-publication-description"),
      "cms-assistant-skill-publication/c7e20f8f-d706-4788-a70a-7d81f49314a1",
    ],
  };
  const status = el("p", { role: "status", className: "muted" });
  const fields = el("fieldset", { className: "assistant-add-ons" });
  /**
   * Render and persist a single integration switch.
   * @param title Name of the skill or MCP provider.
   * @param description Short description of what the integration does.
   * @param active The currently saved toggle state.
   * @param save Callback that atomically persists this row's new state.
   * @param metadata Attribution, licensing and source links for the row.
   */
  function row(title, description, active, save, metadata) {
    const control = el("input", { type: "checkbox" });
    control.checked = active;
    control.addEventListener("change", async () => {
      const next = control.checked;
      fields.disabled = true;
      status.textContent = "";
      try {
        await save(next);
        status.textContent = t("mcp-skills-saved");
      } catch (error) {
        control.checked = !next;
        status.textContent = error.message;
      } finally {
        fields.disabled = false;
      }
    });
    return el(
      "div",
      { className: "assistant-add-on" },
      el(
        "label",
        { className: "setting-toggle" },
        el(
          "span",
          {},
          el("strong", {}, title),
          el("br"),
          el("span", { className: "muted" }, description),
        ),
        control,
      ),
      el("small", { className: "muted" }, ...metadata),
    );
  }
  fields.append(
    ...policy.skills.map((id) => {
      const [description, source] = details[id];
      return row(
        responseSkillLabels[id],
        description,
        enabled.includes(id),
        async (selected) => {
          const next = selected ? [...enabled, id] : enabled.filter((current) => current !== id);
          ({ enabled } = await api("settings/mcp/skills", { enabled: next }));
        },
        [
          t("skill-author"),
          " · ",
          el(
            "a",
            { href: "https://github.com/sendanor/bist/blob/HEAD/LICENSE" },
            t("skill-license"),
          ),
          " · ",
          el("a", { href: "/recipe/review/" + source }, t("skill-source")),
          id === "caveman" && " · ",
          id === "caveman" &&
            el(
              "a",
              { href: "https://github.com/JuliusBrussee/caveman/tree/main/skills/caveman" },
              t("skill-caveman-upstream"),
            ),
        ],
      );
    }),
    row(
      t("mcp-assistant-connection"),
      t("mcp-assistant-docs-help"),
      openAi.enabled,
      (enabled) => api("settings/mcp/openai-docs", { enabled }),
      [
        t("mcp-openai-publisher"),
        " · ",
        el("a", { href: "https://developers.openai.com/learn/docs-mcp" }, t("mcp-provider-docs")),
      ],
    ),
    row(
      t("mcp-context7-connection"),
      t("mcp-context7-help"),
      context7.enabled,
      (enabled) => api("settings/mcp/context7", { enabled }),
      [
        t("mcp-context7-publisher"),
        " · ",
        el(
          "a",
          { href: "https://context7.com/docs/resources/all-clients" },
          t("mcp-provider-docs"),
        ),
      ],
    ),
  );
  return el(
    "section",
    { className: "panel form" },
    el("h2", {}, t("mcp-response-skills")),
    fields,
    status,
  );
}

/** Configure which new file parts receive an advisory or blocking OpenAI review. */
async function llmReviewForm() {
  const policy = await api("settings/llm-review");
  const openAi = await api("settings/openai");
  const enabled = el("input", { type: "checkbox" });
  enabled.checked = policy.enabled;
  const modelField = field(
    "model",
    t("llm-review-model"),
    {
      maxlength: 100,
      placeholder: openAi.model ?? "",
      list: "llm-review-models",
    },
    policy.model,
  );
  const model = modelField.querySelector("input");
  const reasoning = el("select");
  const reference = field(
    "referenceQuery",
    t("llm-review-reference-query"),
    { maxlength: 160 },
    policy.referenceQuery,
  );
  const referenceLibrary = field(
    "referenceLibraryId",
    t("llm-review-reference-library"),
    { maxlength: 160 },
    policy.referenceLibraryId,
  );
  updateReasoningChoices(reasoning, model.value || openAi.model || "", policy.reasoningEffort);
  model.addEventListener("input", () => {
    updateReasoningChoices(reasoning, model.value.trim() || openAi.model || "", reasoning.value);
  });
  const rules = Object.entries(parts).map(([part, title]) => {
    const mode = el(
      "select",
      {},
      el("option", { value: "off" }, t("llm-review-off")),
      el("option", { value: "warn" }, t("llm-review-warn")),
      el("option", { value: "error" }, t("llm-review-block")),
    );
    mode.value = policy.rules[part]?.mode ?? "off";
    const fieldset = field(
      "instruction",
      t("llm-review-instruction"),
      { maxlength: 2000, rows: 5, className: "review-instruction" },
      policy.rules[part]?.instruction ?? "",
      true,
    );
    return { part, title, mode, fieldset, instruction: fieldset.querySelector("textarea") };
  });
  const save = el("button", { type: "submit", className: "primary" }, t("llm-review-save"));
  const status = el("p", { role: "status" });
  return el(
    "form",
    {
      className: "panel form",
      /**
       * Save the complete review policy for subsequent submissions.
       * @param event Submission from the review settings form.
       */
      onsubmit: async (event) => {
        event.preventDefault();
        save.disabled = true;
        status.textContent = "";
        try {
          await api("settings/llm-review", {
            enabled: enabled.checked,
            model: model.value.trim(),
            reasoningEffort: reasoning.value,
            referenceQuery: reference.querySelector("input").value.trim(),
            referenceLibraryId: referenceLibrary.querySelector("input").value.trim(),
            rules: Object.fromEntries(
              rules.map(({ part, mode, instruction }) => [
                part,
                { mode: mode.value, instruction: instruction.value.trim() },
              ]),
            ),
          });
          status.textContent = t("llm-review-saved");
        } catch (error) {
          status.textContent = error.message;
        } finally {
          save.disabled = false;
        }
      },
    },
    el("p", { className: "muted" }, t("llm-review-description")),
    el("label", { className: "setting-toggle" }, t("llm-review-enable"), enabled),
    modelField,
    el(
      "datalist",
      { id: "llm-review-models" },
      ...["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6-luna"].map((id) =>
        el("option", { value: id }),
      ),
    ),
    el("label", {}, t("openai-reasoning-effort"), reasoning),
    reference,
    referenceLibrary,
    el("p", { className: "muted" }, t("llm-review-reference-help")),
    ...rules.map(({ title, mode, fieldset }) =>
      el(
        "fieldset",
        { className: "panel form" },
        el("legend", {}, title),
        el("label", {}, t("llm-review-mode"), mode),
        fieldset,
      ),
    ),
    el("div", { className: "actions" }, save, status),
  );
}

/**
 * Navigate among settings sections while retaining the active section.
 * @param page The current settings route.
 */
async function settingsPage(page) {
  const nav = el(
    "nav",
    { className: "actions settings-nav", "aria-label": t("settings") },
    ...[
      ["settings/openai", t("openai-settings")],
      ["settings/code-policy", t("code-policy")],
      ["settings/mcp", t("mcp-settings")],
      ["settings/llm-review", t("llm-review-settings")],
    ].map(([path, label]) =>
      el(
        "a",
        {
          className: "button",
          href: "/" + path,
          "aria-current": page === path ? "page" : undefined,
        },
        label,
      ),
    ),
  );
  if (page === "settings/openai") {
    return [title(t("openai-settings")), nav, ...openAiSettingsForm(await api("settings/openai"))];
  }
  if (page === "settings/code-policy") {
    const [heading, form] = await codePolicyPage();
    return [heading, nav, form];
  }
  if (page === "settings/llm-review") {
    return [title(t("llm-review-settings")), nav, await llmReviewForm()];
  }
  if (page === "settings/mcp") {
    return [
      title(t("mcp-settings"), t("mcp-settings-help")),
      nav,
      await mcpSettingsForm(),
      await assistantAddOns(),
    ];
  }
  return [title(t("settings")), nav];
}

/** Render the current page path and discard stale asynchronous results. */
async function render() {
  if (location.pathname === "/assistant") {
    history.replaceState(history.state, "", "/library" + location.search);
    if (maintainer) {
      void openAssistant();
    }
  }
  const current = ++renderId;
  toolbar.replaceChildren();
  const { page, section, slug, revision } = parsePagePath(location.pathname);
  const reading = page === "recipe";
  topBar.classList.toggle("recipe-top", reading);
  outlet.classList.toggle("recipe-view", reading);
  revisionBack.hidden = !reading;
  if (reading) {
    revisionBack.href = listingPaths.get(section) ?? "/" + section;
    const backLabel = t("back-to") + (labels[section] ?? t("library")).toLowerCase();
    revisionBack.setAttribute("aria-label", backLabel);
    revisionBack.title = backLabel;
  }
  locationLabel.textContent = labels[section] ?? labels.library;
  for (const link of document.querySelectorAll(".rail nav a")) {
    if (link.pathname === "/" + section) {
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
      ({ view, actions, toolbarTitle } = await recipePage(section, slug, revision));
    } else if (page === "improve" || page === "edit") {
      const recipe =
        page === "improve" && recentRecipe?.id === revision && recentRecipe.slug === slug
          ? recentRecipe
          : await api("recipe?" + new URLSearchParams({ slug, revision }));
      if (page === "edit" && !recipe.canReplace) {
        throw new Error(t("draft-no-longer-editable"));
      }
      view = await contribute(recipe, page === "edit");
    } else if (section === "contribute") {
      view = await contribute();
    } else if (section === "settings") {
      view = await settingsPage(page);
    } else {
      view = await listingPage(section);
      if (current === renderId) {
        listingPaths.set(section, location.pathname + location.search);
      }
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

/** Replace a legacy bookmark on the root page with its canonical path and keep its query. */
function upgradeLegacyRoute() {
  if (location.pathname !== "/" || !location.hash) {
    return false;
  }
  const path = "/" + location.hash.slice(1);
  if (!parsePagePath(path)) {
    return false;
  }
  history.replaceState(history.state, "", path + location.search);
  return true;
}

/** Render a navigation and reset content focus once its latest view has loaded. */
async function renderNavigation() {
  const target = location.href;
  await render();
  if (location.href === target) {
    document.querySelector("#content").focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

/**
 * Open an application path and retain the previous page in the browser history.
 * @param path The known same-origin application path, optionally with a query string.
 */
function navigate(path) {
  if (location.pathname + location.search !== path || location.hash) {
    history.pushState(null, "", path);
    void renderNavigation();
  }
}

upgradeLegacyRoute();
try {
  ({ maintainer } = await api("session"));
  for (const route of ["review", "settings"]) {
    document.querySelector(`.rail nav a[href="/${route}"]`).hidden = !maintainer;
  }
  assistantToggle.hidden = !maintainer;
  assistantToggle.addEventListener("click", () => {
    if (assistantPanel.hidden) {
      void openAssistant();
    } else {
      closeAssistant();
    }
  });
  assistantClose.addEventListener("click", closeAssistant);
  assistantResize.addEventListener("pointerdown", (event) => {
    if (event.button === 0) {
      assistantResize.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  });
  assistantResize.addEventListener("pointermove", (event) => {
    if (assistantResize.hasPointerCapture(event.pointerId)) {
      resizeAssistant(assistantPanel.parentElement.getBoundingClientRect().right - event.clientX);
    }
  });
  assistantResize.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const change = event.key === "ArrowLeft" ? 24 : -24;
      resizeAssistant(assistantPanel.getBoundingClientRect().width + change);
      event.preventDefault();
    }
  });
  assistantPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      closeAssistant();
    }
  });
  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    ) {
      return;
    }
    const link = event.target.closest("a[href]");
    if (
      link instanceof HTMLAnchorElement &&
      link.origin === location.origin &&
      (!link.target || link.target === "_self") &&
      !link.hasAttribute("download") &&
      !link.hash &&
      parsePagePath(link.pathname)
    ) {
      event.preventDefault();
      navigate(link.pathname + link.search);
    }
  });
  window.addEventListener("popstate", () => {
    upgradeLegacyRoute();
    void renderNavigation();
  });
  window.addEventListener("hashchange", () => {
    if (upgradeLegacyRoute()) {
      void renderNavigation();
    }
  });
  await render();
} catch (error) {
  outlet.replaceChildren(
    empty(
      t("sign-in-to-the-cookbook"),
      error.message,
      el(
        "a",
        {
          className: "button primary",
          href:
            "/signin-with-chatgpt?" +
            new URLSearchParams({ returnTo: location.pathname + location.search }),
          target: "_top",
        },
        t("sign-in-with-chatgpt"),
      ),
    ),
  );
}
