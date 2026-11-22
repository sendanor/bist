import { isString } from "./guards.ts";

/** Current working copy and the author's instruction for a single recipe file. */
export interface FileEditRequest {
  readonly filename: string;
  readonly content: string;
  readonly instruction: string;
}

/**
 * Check the UTF-8 size limit shared by recipe submissions and the file editor.
 * @param value Untrusted file contents, including whitespace in the author's working copy.
 */
export function isRecipeFileText(value: unknown): value is string {
  return (
    isString(value) &&
    value.length <= 12_000 &&
    new TextEncoder().encode(value).byteLength <= 12_000
  );
}
