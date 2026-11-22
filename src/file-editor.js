import { api } from "./browser-api.js";
import { btn, el } from "./browser-dom.js";
import { t } from "./localization.js";
import { isRecipeFileText } from "./recipe-file.ts";

/**
 * Build the controls for one file editor. The caller owns their state and event handlers.
 * @param filename The stored name shown to the author in this dialog.
 * @param original Saved text used as the starting point for manual and assisted edits.
 */
function editorControls(filename, original) {
  const content = el("textarea", { className: "code-input", rows: 12, spellcheck: "false" });
  content.value = original;
  const instruction = el("textarea", { rows: 2, maxlength: 2000 });
  const suggest = el("button", { type: "button" }, t("file-edit-suggest"));
  const compare = el("button", { type: "button", "aria-pressed": "false" }, t("show-changes"));
  const save = el("button", { type: "button", className: "primary" }, t("file-edit-save"));
  const cancel = btn(t("cancel"), () => dialog.close());
  const status = el("p", { className: "file-edit-status", role: "status" });
  const preview = el("div", { className: "file-edit-preview", hidden: "" });
  const text = el("label", {}, t("file-edit-contents"), content);
  const dialog = el(
    "dialog",
    { className: "revision-dialog file-editor", "aria-labelledby": "file-editor-title" },
    el("h2", { id: "file-editor-title" }, t("edit-file"), " · ", el("code", {}, filename)),
    text,
    preview,
    el(
      "div",
      { className: "file-edit-assist" },
      el("label", {}, t("file-edit-instruction"), instruction),
      suggest,
    ),
    status,
    el("div", { className: "revision-dialog-buttons" }, compare, cancel, save),
  );
  return { dialog, content, text, instruction, preview, suggest, compare, save, cancel, status };
}

/**
 * Toggle a comparison of the working copy with the revision opened by its author.
 * @param ui Controls for this instance of the editor.
 * @param original Text previously saved in the draft.
 * @param diff Comparison renderer shared with the revision page.
 */
function connectComparison(ui, original, diff) {
  /** Refresh an open comparison after applying a suggestion or changing the view. */
  function refresh() {
    if (!ui.preview.hidden) {
      ui.preview.replaceChildren(diff(original, ui.content.value, true));
    }
  }
  ui.compare.addEventListener("click", () => {
    const show = ui.preview.hidden;
    ui.preview.hidden = !show;
    ui.text.hidden = show;
    ui.compare.setAttribute("aria-pressed", String(show));
    ui.compare.textContent = show ? t("file-edit-text") : t("show-changes");
    if (!show) {
      ui.content.focus();
    }
    refresh();
  });
  return refresh;
}

/**
 * Edit a file directly or ask the model to stage a replacement. Save always needs an author action.
 * @param recipe Current authorized draft snapshot, including filenames and concurrency version.
 * @param part Selected file category in that snapshot.
 * @param submit Submit through the normal warning acknowledgement flow.
 * @param diff Render a wrapped, line-by-line comparison with the original file.
 */
export async function editRecipeFile(recipe, part, submit, diff) {
  const target = { slug: recipe.slug, revision: recipe.id, editVersion: recipe.editVersion, part };
  const original = recipe.files[part];
  const ui = editorControls(recipe.fileNames[part], original);
  const refreshComparison = connectComparison(ui, original, diff);
  let request;
  let saving = false;
  let result = null;

  /** Synchronize available actions with the current contents and outstanding requests. */
  function update() {
    const changed = original !== ui.content.value;
    const valid = isRecipeFileText(ui.content.value);
    ui.save.disabled = saving || !changed || !valid || !ui.content.value.trim();
    ui.compare.disabled = saving || (!changed && ui.preview.hidden);
    ui.suggest.disabled = saving || Boolean(request) || !valid || !ui.instruction.value.trim();
    ui.content.readOnly = saving;
    ui.instruction.readOnly = saving;
    ui.cancel.disabled = saving;
  }

  /** Cancel a pending suggestion when the author changes its input or closes the dialog. */
  function cancelRequest() {
    request?.abort();
    request = undefined;
  }

  /** Preserve typed changes and explain the byte limit when the working copy exceeds it. */
  function changedInput() {
    cancelRequest();
    ui.status.textContent = isRecipeFileText(ui.content.value) ? "" : t("file-edit-size");
    update();
  }

  /** Request a proposal for this working copy and discard any response to superseded input. */
  async function suggest() {
    const controller = new AbortController();
    request = controller;
    ui.status.textContent = t("file-edit-generating");
    update();
    try {
      const proposed = await api(
        "recipe/file/suggest",
        {
          ...target,
          content: ui.content.value,
          instruction: ui.instruction.value.trim(),
        },
        controller.signal,
      );
      if (!controller.signal.aborted && ui.dialog.open) {
        const changed = proposed.content !== ui.content.value;
        ui.content.value = proposed.content;
        refreshComparison();
        ui.status.textContent = changed ? t("file-edit-proposed") : t("this-file-is-unchanged");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        ui.status.textContent = error.message;
      }
    } finally {
      if (request === controller) {
        request = undefined;
        update();
      }
    }
  }

  /** Save the reviewed text. Declined warnings and validation failures leave the editor open. */
  async function save() {
    cancelRequest();
    saving = true;
    update();
    ui.status.textContent = t("file-edit-saving");
    try {
      result = await submit({ ...target, content: ui.content.value }, "recipe/file");
      if (result) {
        ui.dialog.close();
      } else {
        ui.status.textContent = t("file-edit-unsaved");
      }
    } catch (error) {
      ui.status.textContent = error.message;
    } finally {
      saving = false;
      update();
    }
  }

  ui.content.addEventListener("input", changedInput);
  ui.instruction.addEventListener("input", changedInput);
  ui.suggest.addEventListener("click", suggest);
  ui.save.addEventListener("click", save);
  ui.dialog.addEventListener("cancel", (event) => {
    if (saving) {
      event.preventDefault();
    }
  });
  update();
  document.body.append(ui.dialog);
  ui.dialog.showModal();
  ui.content.focus();
  await new Promise((resolve) => ui.dialog.addEventListener("close", resolve, { once: true }));
  cancelRequest();
  ui.dialog.remove();
  return result;
}
