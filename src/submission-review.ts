import { parts } from "./format";
import { readLlmReviewPolicy } from "./llm-review-settings.ts";
import { isOpenAiModel, runOpenAiReview } from "./openai.ts";
import { effectiveReasoning } from "./reasoning.ts";
import { openOpenAiKey } from "./settings-crypto.ts";
import { docsMcpEnabled } from "./mcp-settings.ts";
import { searchContext7, searchOpenAiDocs } from "./openai-docs-mcp.ts";
import {
  decodeLlmFindings,
  RequestError,
  type Database,
  type LlmFinding,
  type SubmissionSnapshot,
} from "./store";

/** One cached result for a particular author, file snapshot, and policy. */
interface ReviewReceipt {
  readonly receipt: string;
  readonly warnings: string;
}

/**
 * Review new content, preserve unchanged findings and require explicit warning acknowledgement.
 * @param db The instance database binding.
 * @param encryptionKey Deployment key used to open the stored OpenAI credential.
 * @param candidate Normalized files and review context for the current authenticated author.
 * @throws {RequestError} If review is unavailable, blocks the submission, or needs acknowledgement.
 */
export async function reviewSubmission(
  db: Database,
  encryptionKey: string | undefined,
  candidate: SubmissionSnapshot,
) {
  const retained = candidate.previousWarnings.filter(
    ({ part }) => candidate.files[part] && candidate.files[part] === candidate.previous[part],
  );
  const policy = await readLlmReviewPolicy(db);
  const changed = parts.flatMap((part) => {
    const content = candidate.files[part];
    const rule = policy.rules[part];
    return content && content !== candidate.previous[part] && rule && rule.mode !== "off"
      ? [{ part, content, instruction: rule.instruction, mode: rule.mode }]
      : [];
  });
  if (!policy.enabled || !changed.length) {
    return retained;
  }

  const connection = await db
    .prepare("SELECT model, credential FROM openai_settings WHERE id = 1")
    .first<{ model: string; credential: string | null }>();
  const model = policy.model || connection?.model;
  if (!connection?.credential || !isOpenAiModel(model) || !encryptionKey) {
    throw new RequestError(
      "LLM review is enabled. Configure an OpenAI API key and a review or Assistant model before submitting these files.",
      503,
    );
  }
  const { referenceQuery, referenceLibraryId } = policy;
  const context7 = Boolean(referenceLibraryId);
  if (referenceQuery && !(await docsMcpEnabled(db, context7))) {
    throw new RequestError(
      "Enable the MCP connection selected for LLM review reference lookup.",
      503,
    );
  }
  /** Read only the public reference entered by the maintainer and recheck its saved connection. */
  async function searchDocs() {
    /** Recheck the chosen reference connection immediately before each outbound operation. */
    const allowed = () => docsMcpEnabled(db, context7);
    if (context7) {
      const excerpt = await searchContext7(referenceQuery, referenceLibraryId, allowed);
      if (excerpt) {
        return { excerpt };
      }
    } else {
      const hits = await searchOpenAiDocs(referenceQuery, allowed);
      if (hits) {
        return { hits };
      }
    }
    throw new RequestError("The reference MCP lookup failed. Try the submission again.", 503);
  }
  const context = { model, reasoningEffort: effectiveReasoning(model, policy.reasoningEffort) };
  const encoded = new TextEncoder().encode(
    JSON.stringify([
      candidate.actor,
      candidate.intent,
      changed,
      context,
      referenceQuery,
      referenceLibraryId,
    ]),
  );
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const digest = [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const match = db
    .prepare(
      "SELECT receipt, warnings FROM llm_review_receipts WHERE digest = ? AND expires > unixepoch()",
    )
    .bind(digest);
  let cached = await match.first<ReviewReceipt>();

  if (!cached) {
    const limit = await db
      .prepare(
        `INSERT INTO openai_rate_limits (actor, action, window, hits)
      VALUES (?, 'review', unixepoch(), 1) ON CONFLICT(actor, action) DO UPDATE SET
      hits = CASE WHEN window <= excluded.window - 60 THEN 1 ELSE hits + 1 END,
      window = CASE WHEN window <= excluded.window - 60 THEN excluded.window ELSE window END
      WHERE window <= excluded.window - 60 OR hits < 6`,
      )
      .bind(candidate.actor)
      .run();
    if (!limit.meta.changes) {
      throw new RequestError("Too many LLM review requests. Try again shortly.", 429);
    }
    const key = await openOpenAiKey(encryptionKey, connection.credential);
    const findings = await runOpenAiReview(
      { ...context, key, context7, searchDocs: referenceQuery ? searchDocs : undefined },
      changed,
    );
    await db.batch([
      db.prepare("DELETE FROM llm_review_receipts WHERE expires <= unixepoch()"),
      db
        .prepare(
          "INSERT OR IGNORE INTO llm_review_receipts (digest, receipt, expires, warnings) VALUES (?, ?, unixepoch() + 600, ?)",
        )
        .bind(digest, crypto.randomUUID(), JSON.stringify(findings)),
    ]);
    cached = await match.first<ReviewReceipt>();
    if (!cached) {
      throw new RequestError("Could not save the LLM review. Please retry.", 503);
    }
  }

  const findings = decodeLlmFindings(cached.warnings);
  const blocking = findings.some(({ part }) => policy.rules[part]?.mode === "error");
  if (findings.length && (blocking || candidate.receipt !== cached.receipt)) {
    const detail = findings.map(({ part, reason }) => part + ": " + reason).join("\n");
    if (blocking) {
      throw new RequestError("LLM review blocked this submission.\n" + detail, 422);
    }
    throw new RequestError(detail, 409, "llm_warning", cached.receipt);
  }
  return [...retained, ...findings] satisfies readonly LlmFinding[];
}
