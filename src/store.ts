import { isArray, isRecord, isRevisionId, isString } from "./guards";
import {
  defaultCodePolicy,
  eslintRules,
  prettierOptions,
  qualityOptions,
  validateCodePolicy,
} from "./code-policy";
import { normalizeFiles, parts } from "./format";
import { fingerprintRecipe } from "./quality/recipe-hash";
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>;
}
export type User = { id: string; maintainer: boolean };
export type Input = Record<string, unknown>;
type Revision = {
  id: string;
  slug: string;
  author: string;
  edit_version: number;
  base: string | null;
  title: string;
  summary: string;
  tags: string;
  files: string | null;
  state: string;
  created: string;
  live: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  published_at: string | null;
  removal_reason: string | null;
  removal_by: string | null;
};
/** Stored code snapshot awaiting fingerprint generation after migration. */
interface LegacySnapshot {
  readonly id: string;
  readonly files: string;
  readonly edit_version: number;
}

const matchingSnapshot = `
  SELECT 1 FROM revisions
  WHERE code_hash = ? AND state NOT IN ('removed', 'quarantined')
    AND (author = ? OR state = 'published') AND id != COALESCE(?, '')
`;

const fields = "v.id, v.slug, v.title, v.summary, v.tags, v.state, v.created, v.published_at";
/**
 * Decode stored revision tags before exposing them to API readers.
 * @param json JSON text persisted when a revision was submitted.
 * @throws {Error} When the stored tags are malformed or contain non-string values.
 */
function decodeTags(json: string) {
  const tags: unknown = JSON.parse(json);
  if (!isArray(tags) || !tags.every(isString)) {
    throw new Error("Stored tags must be an array of strings.");
  }
  return tags;
}

/**
 * Recognize file part names accepted by the recipe API.
 * @param value Unvalidated part name supplied by a caller.
 */
function isRecipePart(value: unknown): value is (typeof parts)[number] {
  return parts.some((part) => part === value);
}

interface TaggedRow {
  readonly tags: string;
}

/**
 * Replace a database row's stored tag JSON with validated strings.
 * @param row Database record with an encoded tags column.
 */
function clean<T extends TaggedRow>(row: T) {
  return { ...row, tags: decodeTags(row.tags) };
}

/**
 * Read the selected files from a stored revision.
 * @param json Encoded revision files, or null for a removed revision.
 * @param selected Supported file parts requested by the caller.
 * @throws {Error} When persisted file contents do not match the recipe format.
 */
function decodeFiles(json: string | null, selected: readonly (typeof parts)[number][]) {
  const files: unknown = JSON.parse(json ?? "{}");
  if (!isRecord(files)) {
    throw new Error("Stored files must be a JSON object.");
  }
  return Object.fromEntries(
    selected
      .filter((part) => Object.hasOwn(files, part))
      .map((part) => {
        const content = files[part];
        if (!isString(content)) {
          throw new Error("Stored file content must be text.");
        }
        return [part, content];
      }),
  );
}
export class RequestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function str(value: unknown, name: string, max: number, optional = false) {
  if (optional && value === undefined) {
    return "";
  }
  if (!isString(value) || value.length > max || (!optional && !value.trim())) {
    throw new RequestError(`Provide ${name} (up to ${max} characters).`);
  }
  return value.trim();
}
/**
 * Read a Cookbook revision identifier from an external request.
 * @param value Unvalidated request field.
 * @param name Label to show if the field is invalid.
 * @param optional Whether an omitted revision refers to the published snapshot.
 * @throws {RequestError} When a supplied value is not a lowercase version 4 UUID.
 */
function revisionId(value: unknown, name: string, optional = false) {
  if (optional && (value === undefined || value === "")) {
    return "";
  }
  if (!isRevisionId(value)) {
    throw new RequestError(`Provide ${name} as a lowercase version 4 UUID.`);
  }
  return value;
}
/**
 * Validate the version of the snapshot that the caller read.
 * @param value Version returned by the recipe endpoint.
 * @throws {RequestError} When the caller did not supply a valid snapshot version.
 */
function snapshotVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RequestError("Provide the recipe's current editVersion.");
  }
  return value;
}

export class Cookbook {
  constructor(
    private readonly db: Database,
    private readonly user: User,
  ) {}
  private sql(query: string, ...values: unknown[]) {
    return this.db.prepare(query).bind(...values);
  }
  private maintainer() {
    if (!this.user.maintainer) {
      throw new RequestError("Maintainer access required.", 403);
    }
  }
  private async readCodePolicy() {
    const row = await this.sql("SELECT config FROM code_policy WHERE id = 1").first<{
      config: string;
    }>();
    if (!row) {
      return defaultCodePolicy;
    }
    const saved: unknown = JSON.parse(row.config);
    if (!isRecord(saved)) {
      throw new Error("Stored code policy must be an object.");
    }
    const legacy = !Object.hasOwn(saved, "quality");
    const previousRules = isRecord(saved.eslint) ? saved.eslint : {};
    const previousGlobals = isRecord(saved.globals) ? saved.globals : {};
    return validateCodePolicy({
      prettier: saved.prettier,
      eslint: legacy ? { ...defaultCodePolicy.eslint, ...previousRules } : saved.eslint,
      globals: legacy ? { ...defaultCodePolicy.globals, ...previousGlobals } : saved.globals,
      settings: saved.settings,
      overrides: legacy ? defaultCodePolicy.overrides : saved.overrides,
      quality: saved.quality,
    });
  }
  async codeSettings() {
    this.maintainer();
    return { policy: await this.readCodePolicy(), prettierOptions, eslintRules, qualityOptions };
  }
  async saveCodeSettings(input: Input) {
    this.maintainer();
    const policy = (() => {
      try {
        return validateCodePolicy(input);
      } catch (error) {
        throw new RequestError((error as Error).message);
      }
    })();
    await this.sql(
      "INSERT INTO code_policy (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config",
      JSON.stringify(policy),
    ).run();
    return { policy, prettierOptions, eslintRules, qualityOptions };
  }
  async search(input: Input) {
    const words = str(input.query, "search text", 160, true)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (words.length > 12) {
      throw new RequestError("Search supports up to 12 terms.");
    }
    const tag = str(input.tag, "tag", 32, true).toLowerCase();
    const where = words.map(
      () => "instr(lower(v.slug || ' ' || v.title || ' ' || v.summary || ' ' || v.tags), ?) > 0",
    );
    if (tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(v.tags) WHERE value = ?)");
    }
    const rows = await this.sql(
      `SELECT ${fields} FROM recipes r
      JOIN revisions v ON r.live = v.id WHERE v.state = 'published'
      ${where.length ? "AND " + where.join(" AND ") : ""} ORDER BY v.published_at DESC, v.slug LIMIT 50`,
      ...words,
      ...(tag ? [tag] : []),
    ).all<Revision>();
    return rows.results.map(clean);
  }
  async queue(mine: boolean) {
    if (!mine) {
      this.maintainer();
    }
    const rows = await this.sql(
      `SELECT ${fields}, v.removal_reason FROM revisions v
      WHERE ${
        mine
          ? "v.author = ? AND v.state != 'removed'"
          : "v.state IN ('pending','approved','quarantined') OR (v.removal_reason IS NOT NULL AND v.state != 'removed')"
      }
      ORDER BY v.created DESC, v.rowid DESC LIMIT 100`,
      ...(mine ? [this.user.id] : []),
    ).all<Revision>();
    return rows.results.map(clean);
  }
  async get(input: Input) {
    const slug = str(input.slug, "recipe slug", 64);
    const id = revisionId(input.revision, "revision ID", true);
    const selected = input.parts ?? parts;
    if (!isArray(selected) || selected.length > parts.length || !selected.every(isRecipePart)) {
      throw new RequestError("Select supported file parts.");
    }
    const row = await this.sql(
      `SELECT v.*, r.live FROM recipes r JOIN revisions v ON v.slug = r.slug
      WHERE r.slug = ? AND v.id = ${id ? "?" : "r.live"}`,
      slug,
      ...(id ? [id] : []),
    ).first<Revision>();
    if (
      !row ||
      row.state === "removed" ||
      (row.state !== "published" && row.author !== this.user.id && !this.user.maintainer) ||
      (row.state === "quarantined" && !this.user.maintainer)
    ) {
      throw new RequestError("Recipe revision not found.", 404);
    }
    const ownUnapproved =
      row.author === this.user.id &&
      !row.published_at &&
      (row.state === "pending" || row.state === "changes");
    return {
      id: row.id,
      editVersion: row.edit_version,
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      tags: decodeTags(row.tags),
      state: row.state,
      created: row.created,
      base: row.base,
      live: row.live === row.id,
      review_note: row.review_note,
      removal_reason: row.removal_reason,
      published_at: row.published_at,
      canReplace: ownUnapproved && !row.removal_reason,
      canRemoveDraft: ownUnapproved,
      canRequestRemoval: row.author === this.user.id || this.user.maintainer,
      files: decodeFiles(row.files, selected),
    };
  }
  private async normalizeSubmission(files: unknown, policy: typeof defaultCodePolicy) {
    try {
      return await normalizeFiles(files, policy);
    } catch (error) {
      throw new RequestError(error instanceof Error ? error.message : "Recipe validation failed.");
    }
  }
  /**
   * Index snapshots created before fingerprints were introduced.
   * @throws {RequestError} When more legacy snapshots remain for a later request.
   */
  private async indexLegacySnapshots() {
    const limit = 24;
    const { results } = await this.sql(
      "SELECT id, files, edit_version FROM revisions WHERE code_hash IS NULL AND files IS NOT NULL ORDER BY id LIMIT ?",
      limit + 1,
    ).all<LegacySnapshot>();
    const statements = [];
    for (const row of results.slice(0, limit)) {
      const files = decodeFiles(row.files, parts);
      const { snapshot, units } = await fingerprintRecipe(files);
      statements.push(
        this.sql(
          "UPDATE revisions SET code_hash = ?, unit_hashes = ? WHERE id = ? AND edit_version = ? AND code_hash IS NULL AND files IS NOT NULL",
          snapshot,
          JSON.stringify(units),
          row.id,
          row.edit_version,
        ),
      );
    }
    if (statements.length) {
      await this.db.batch(statements);
    }
    if (results.length > limit) {
      throw new RequestError(
        "Older revisions are still being indexed. Retry submission to continue.",
        503,
      );
    }
  }

  private async assertNoDuplicate(hash: string, except: string | null) {
    const existing = await this.sql(
      matchingSnapshot + " LIMIT 1",
      hash,
      this.user.id,
      except,
    ).first();
    if (existing) {
      throw new RequestError(
        "The same code is already saved in one of your revisions or a published recipe.",
        409,
      );
    }
  }

  async submit(input: Input) {
    const slug = str(input.slug, "recipe slug", 64);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new RequestError("Use a lowercase hyphenated slug.");
    }
    const title = str(input.title, "title", 100);
    const summary = str(input.summary, "summary", 300);
    const base = revisionId(input.base, "base revision ID", true) || null;
    const replace = revisionId(input.replace, "revision ID to replace", true) || null;
    if (base && replace) {
      throw new RequestError("Choose either a base revision or a revision to replace.");
    }
    const editVersion = replace ? snapshotVersion(input.editVersion) : 0;
    const tags = input.tags ?? [];
    if (!isArray(tags) || tags.length > 8) {
      throw new RequestError("Use up to eight tags.");
    }
    const normalizedTags = [...new Set(tags.map((tag) => str(tag, "tag", 32).toLowerCase()))];
    const policy = await this.readCodePolicy();
    const { files, warnings } = await this.normalizeSubmission(input.files, policy);
    await this.indexLegacySnapshots();
    const { snapshot, units } = await fingerprintRecipe(files);
    const payload = {
      title,
      summary,
      tags: JSON.stringify(normalizedTags),
      files: JSON.stringify(files),
      units: JSON.stringify(units),
    };
    const notices = warnings.length ? { warnings } : {};
    if (replace) {
      const updated = await this.sql(
        `UPDATE revisions
         SET title = ?, summary = ?, tags = ?, files = ?, edit_version = edit_version + 1,
             state = 'pending', review_note = NULL, code_hash = ?, unit_hashes = ?
         WHERE id = ? AND slug = ? AND author = ? AND edit_version = ?
           AND state IN ('pending', 'changes') AND published_at IS NULL AND removal_reason IS NULL
           AND NOT EXISTS (${matchingSnapshot})`,
        payload.title,
        payload.summary,
        payload.tags,
        payload.files,
        snapshot,
        payload.units,
        replace,
        slug,
        this.user.id,
        editVersion,
        snapshot,
        this.user.id,
        replace,
      ).run();
      if (!updated.meta.changes) {
        await this.assertNoDuplicate(snapshot, replace);
        throw new RequestError(
          "This draft cannot be replaced. Reload it to check its current status.",
          409,
        );
      }
      return { slug, id: replace, state: "pending", editVersion: editVersion + 1, ...notices };
    }
    const id = crypto.randomUUID();
    const result = await this.db.batch([
      this.sql(
        `INSERT OR IGNORE INTO recipes(slug, owner) SELECT ?, ? WHERE ? IS NULL AND NOT EXISTS (${matchingSnapshot})`,
        slug,
        this.user.id,
        base,
        snapshot,
        this.user.id,
        null,
      ),
      this.sql(
        `INSERT INTO revisions(id,slug,author,base,title,summary,tags,files,code_hash,unit_hashes)
        SELECT ?,r.slug,?,?,?,?,?,?,?,? FROM recipes r WHERE r.slug = ? AND NOT EXISTS (${matchingSnapshot}) AND (
          (? IS NULL AND r.live IS NULL AND (r.owner = ? OR ?) AND NOT EXISTS
            (SELECT 1 FROM revisions WHERE slug = r.slug AND state != 'removed'))
          OR EXISTS (SELECT 1 FROM revisions p WHERE p.id = ? AND p.slug = r.slug AND
            (p.state = 'published' OR (p.state IN ('pending','approved','changes') AND (p.author = ? OR ?)))))`,
        id,
        this.user.id,
        base,
        payload.title,
        payload.summary,
        payload.tags,
        payload.files,
        snapshot,
        payload.units,
        slug,
        snapshot,
        this.user.id,
        null,
        base,
        this.user.id,
        this.user.maintainer,
        base,
        this.user.id,
        this.user.maintainer,
      ),
    ]);
    if (!result[1].meta.changes) {
      await this.assertNoDuplicate(snapshot, null);
      throw new RequestError("Choose an accessible base revision for this recipe.", 409);
    }
    return { slug, id, state: "pending", editVersion, ...notices };
  }
  async action(input: Input) {
    const slug = str(input.slug, "recipe slug", 64);
    const id = revisionId(input.revision, "revision ID");
    const action = str(input.action, "action", 32);
    const reason = str(input.reason, "reason", 1000, true);
    const target = "WHERE id = ? AND slug = ?";
    let statements: Statement[];
    switch (action) {
      case "approve":
      case "request_changes":
        this.maintainer();
        if (action === "request_changes" && !reason) {
          throw new RequestError("Explain the requested changes.");
        }
        statements = [
          this.sql(
            `UPDATE revisions SET state = ?, reviewed_by = ?, review_note = ?
          ${target} AND state = 'pending' AND removal_reason IS NULL AND edit_version = ?`,
            action === "approve" ? "approved" : "changes",
            this.user.id,
            reason,
            id,
            slug,
            snapshotVersion(input.editVersion === undefined ? 0 : input.editVersion),
          ),
        ];
        break;
      case "publish":
        this.maintainer();
        statements = [
          this.sql(
            `UPDATE recipes SET live = ? WHERE slug = ? AND EXISTS (
            SELECT 1 FROM revisions ${target} AND state = 'approved' AND removal_reason IS NULL)`,
            id,
            slug,
            id,
            slug,
          ),
          this.sql(
            `UPDATE revisions SET state = 'published', published_at = CURRENT_TIMESTAMP
            ${target} AND state = 'approved' AND removal_reason IS NULL`,
            id,
            slug,
          ),
        ];
        break;
      case "quarantine":
      case "approve_removal":
        this.maintainer();
        if (action === "quarantine" && !reason) {
          throw new RequestError("Give a quarantine reason.");
        }
        statements = [
          action === "quarantine"
            ? this.sql(
                `UPDATE revisions SET state = 'quarantined', review_note = ?
                ${target} AND state NOT IN ('quarantined','removed')`,
                reason,
                id,
                slug,
              )
            : this.sql(
                `UPDATE revisions SET state = 'removed', files = NULL
                ${target} AND state != 'removed' AND removal_reason IS NOT NULL`,
                id,
                slug,
              ),
          this.sql(
            `UPDATE recipes SET live = NULL WHERE slug = ? AND live = ? AND EXISTS
            (SELECT 1 FROM revisions ${target} AND state IN ('quarantined','removed'))`,
            slug,
            id,
            id,
            slug,
          ),
        ];
        break;
      case "remove_draft":
        statements = [
          this.sql(
            `UPDATE revisions SET state = 'removed', files = NULL
          ${target} AND author = ? AND state IN ('pending', 'changes') AND published_at IS NULL
            AND edit_version = ?`,
            id,
            slug,
            this.user.id,
            snapshotVersion(input.editVersion === undefined ? 0 : input.editVersion),
          ),
        ];
        break;
      case "request_removal":
        if (!reason) {
          throw new RequestError("Give a removal reason.");
        }
        statements = [
          this.sql(
            `UPDATE revisions SET removal_reason = ?, removal_by = ? ${target}
          AND state != 'removed' AND removal_reason IS NULL AND (author = ? OR ?)`,
            reason,
            this.user.id,
            id,
            slug,
            this.user.id,
            this.user.maintainer,
          ),
        ];
        break;
      default:
        throw new RequestError("Unknown action.");
    }
    const results = await this.db.batch(statements);
    if (!results.some((result) => result.meta.changes)) {
      const message =
        action === "approve" || action === "request_changes"
          ? "The revision changed or is no longer awaiting review. Reload it before reviewing."
          : "This action is unavailable for the current revision.";
      throw new RequestError(message, 409);
    }
    return { action, slug, id };
  }
}
