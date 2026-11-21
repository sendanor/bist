import { isRecord } from "./guards.ts";
import { parts, type Part } from "./format";
import {
  defaultReviewPolicy,
  type LlmReviewPolicy,
  type LlmReviewRule,
} from "./quality/review-defaults.ts";
import { RequestError, str, type Database, type Input } from "./store";
export type { LlmReviewPolicy } from "./quality/review-defaults.ts";

/**
 * Validate and order the maintainer's complete policy before saving or using it.
 * @param input Untrusted or previously stored policy data.
 * @throws {RequestError} If a file rule or the global switch is invalid.
 */
export function llmReviewPolicy(input: Input): LlmReviewPolicy {
  if (typeof input.enabled !== "boolean" || !isRecord(input.rules)) {
    throw new RequestError("Provide a review mode and rules for the recipe files.");
  }
  const rules: Partial<Record<Part, LlmReviewRule>> = {};
  const referenceQuery = str(input.referenceQuery, "public MCP reference query", 160, true);
  const referenceLibraryId = str(
    input.referenceLibraryId,
    "Context7 reference library ID",
    160,
    true,
  );
  if (
    referenceLibraryId &&
    (!referenceQuery || !/^\/[\w.-]+\/[\w.-]+(?:\/[\w.+-]+)?$/u.test(referenceLibraryId))
  ) {
    throw new RequestError("Enter a public reference query and an exact Context7 library ID.");
  }
  for (const part of parts) {
    const rule = input.rules[part];
    if (rule === undefined) {
      continue;
    }
    if (!isRecord(rule) || (rule.mode !== "off" && rule.mode !== "warn" && rule.mode !== "error")) {
      throw new RequestError("Choose Off, Warn, or Block for each file type.");
    }
    rules[part] = {
      mode: rule.mode,
      instruction: str(
        rule.instruction,
        "review instructions for " + part,
        2_000,
        rule.mode === "off",
      ),
    };
  }
  return {
    enabled: input.enabled,
    model: str(input.model, "review model", 100, true),
    reasoningEffort: str(input.reasoningEffort, "review reasoning effort", 12, true),
    referenceQuery,
    referenceLibraryId,
    rules,
  };
}

/**
 * Read the saved policy or offer the standard rules before review is activated.
 * @param db The instance database binding.
 */
export async function readLlmReviewPolicy(db: Database) {
  const row = await db
    .prepare("SELECT policy FROM llm_review_settings WHERE id = 1")
    .first<{ policy: string }>();
  if (!row) {
    return { ...defaultReviewPolicy, enabled: false };
  }
  const parsed: unknown = JSON.parse(row.policy);
  if (!isRecord(parsed)) {
    throw new RequestError("The saved LLM review policy is invalid.", 503);
  }
  return llmReviewPolicy(parsed);
}

/**
 * Persist the validated policy after the request has passed the maintainer check.
 * @param db The instance database binding.
 * @param policy Validated, ordered settings to replace the current policy.
 */
export async function saveLlmReviewPolicy(db: Database, policy: LlmReviewPolicy) {
  await db
    .prepare(
      "INSERT INTO llm_review_settings (id, policy) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET policy = excluded.policy",
    )
    .bind(JSON.stringify(policy))
    .run();
  return policy;
}
