import { isArray, isRecord, isRevisionId, isString } from "./guards";
import {
  defaultCodePolicy,
  eslintRules,
  prettierOptions,
  qualityOptions,
  validateCodePolicy,
} from "./code-policy";
import { normalizeFiles, parts } from "./format";
import { sourceLines } from "./line-diff";
import { fingerprintRecipe, type RecipeFingerprint } from "./quality/recipe-hash";
export interface Statement {
  /**
   * Bind positional values to SQL parameters without string interpolation.
   * @param values The ordered values for statement placeholders.
   */
  bind(...values: unknown[]): Statement;

  /** Execute the statement and return the first result or null. */
  first<T>(): Promise<T | null>;

  /** Execute the statement and return all matching rows. */
  all<T>(): Promise<{ results: T[] }>;

  /** Execute a mutation and expose its changed-row count. */
  run(): Promise<{ meta: { changes: number } }>;
}

export interface Database {
  /**
   * Prepare a SQL statement for later binding and execution.
   * @param sql The SQL text with placeholders for dynamic data.
   */
  prepare(sql: string): Statement;

  /**
   * Execute the supplied statements as a database batch.
   * @param statements The prepared statements in their execution order.
   */
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

/** Private review feedback anchored to a file or line of a specific saved edit. */
interface ReviewComment {
  readonly id: number;
  readonly editVersion: number;
  readonly part: string;
  readonly line: number | null;
  readonly excerpt: string | null;
  readonly body: string;
}

const visibleDuplicate = `
  FROM revisions
  WHERE state NOT IN ('removed', 'quarantined')
    AND (author = ? OR state = 'published') AND id != COALESCE(?, '')
`;

const matchingSnapshot = `
  SELECT 1 ${visibleDuplicate}
    AND (code_hash = ? OR documentation_hash = ? OR instructions_hash = ?)
`;

class DuplicateCheck {
  /**
   * Record the fingerprints and policy needed for duplicate checks.
   * @param code The code fingerprint, or null to skip code matching.
   * @param documentation The documentation fingerprint, or null to skip documentation matching.
   * @param instructions The instructions fingerprint, or null to skip instructions matching.
   * @param policy The configured duplicate policy for each part.
   */
  constructor(
    readonly code: string | null,
    readonly documentation: string | null,
    readonly instructions: string | null,
    readonly policy: typeof defaultCodePolicy.quality,
  ) {}

  /** Return the fingerprints in the order required by the duplicate query. */
  bindings() {
    return [this.code, this.documentation, this.instructions];
  }

  /**
   * Explain which visible snapshots conflict with a pending submission.
   * @param db The prepared statement that identifies matching part fingerprints.
   * @throws {RequestError} When a matching part requires a warning acknowledgement or prevents the submission.
   */
  async report(db: Statement) {
    const matches = await db.first<{ code: number; documentation: number; instructions: number }>();
    const summary: string[] = [];
    let blocking = false;
    if (matches?.code) {
      summary.push(
        "The same code is already saved in one of your revisions or a published recipe.",
      );
      blocking = this.policy.duplicateCode === "error";
    }
    if (matches?.documentation) {
      summary.push(
        "The same documentation is already saved in one of your revisions or a published recipe.",
      );
    }
    if (matches?.instructions) {
      summary.push(
        "The same agent instructions are already saved in one of your revisions or a published recipe.",
      );
    }
    if (matches?.documentation || matches?.instructions) {
      blocking ||= this.policy.duplicateProse === "error";
    }
    if (summary.length) {
      throw new RequestError(summary.join("\n"), 409, blocking ? undefined : "duplicate_warning");
    }
  }
}

/**
 * Select the fingerprints that require duplicate checks under this policy.
 * @param fingerprint The normalized fingerprints from the submitted snapshot.
 * @param policy The configured severities for matching code and prose.
 * @param allow Whether the author has acknowledged duplicate warnings.
 */
function duplicateCheck(
  fingerprint: RecipeFingerprint,
  policy: typeof defaultCodePolicy.quality,
  allow: boolean,
) {
  /**
   * Decide if the current attempt still needs a duplicate lookup.
   * @param severity The configured severity for this kind of fingerprint.
   */
  const check = (severity: string) => severity === "error" || (severity === "warn" && !allow);
  const code = check(policy.duplicateCode) ? fingerprint.snapshot : null;
  const prose = check(policy.duplicateProse);
  return new DuplicateCheck(
    code,
    prose ? fingerprint.documentation : null,
    prose ? fingerprint.instructions : null,
    policy,
  );
}

const fields = "v.id, v.slug, v.title, v.summary, v.tags, v.state, v.created, v.published_at";
const reviewScope =
  "v.state IN ('pending','approved','quarantined') OR (v.removal_reason IS NOT NULL AND v.state != 'removed')";
const reviewStates: Readonly<Record<string, string>> = {
  pending: "v.state = 'pending'",
  approved: "v.state = 'approved'",
  quarantined: "v.state = 'quarantined'",
  removal: "v.removal_reason IS NOT NULL",
};

type PageDirection = "next" | "previous";

/**
 * Read a bounded page size and validate an optional cursor from a prior response.
 * @param input The pagination parameters from the API or MCP client.
 * @throws {RequestError} When the page size or cursor has an invalid format.
 */
function pageOptions(input: Input) {
  const rawLimit = input.limit ?? 20;
  const limit =
    typeof rawLimit === "string" && /^\d{1,2}$/u.test(rawLimit) ? Number(rawLimit) : rawLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RequestError("Page size must be an integer from 1 to 50.");
  }
  const token = str(input.cursor, "page cursor", 120, true);
  if (!token) {
    return { limit, cursor: null };
  }
  const [direction, time, id, ...extra] = token.split("|");
  if (
    extra.length ||
    (direction !== "next" && direction !== "previous") ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(time ?? "") ||
    !isRevisionId(id)
  ) {
    throw new RequestError("Invalid page cursor. Restart from the first page.");
  }
  return { limit, cursor: { direction, time, id } };
}

/** Database fields identifying a boundary between two listing pages. */
interface PageBoundary {
  readonly sort_time: string;
  readonly id: string;
}

/**
 * Build a cursor from the first or last revision on the page.
 * @param direction Which side of the boundary to read.
 * @param row The boundary revision, if another page is available.
 */
function pageCursor(direction: PageDirection, row: PageBoundary | undefined) {
  return row ? `${direction}|${row.sort_time}|${row.id}` : null;
}

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
  /**
   * Construct a request failure with its caller-facing status and optional code.
   * @param message The message safe to include in the response.
   * @param status The HTTP status for this failure.
   * @param code The optional machine-readable code for duplicate warnings.
   */
  constructor(
    message: string,
    public status = 400,
    public code?: "duplicate_warning",
  ) {
    super(message);
  }
}

/**
 * Read and trim a text field while enforcing its length and presence.
 * @param value The unvalidated input value for the field.
 * @param name The label used in any request diagnostic.
 * @param max The maximum length of the trimmed field.
 * @param optional Whether an absent or blank string is accepted.
 * @throws {RequestError} When a required field is missing or the supplied value is invalid.
 */
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
  /**
   * Bind recipe operations to a database and the current identity.
   * @param db The database binding storing recipes and policy.
   * @param user The identity and privileges of the current requester.
   */
  constructor(
    private readonly db: Database,
    private readonly user: User,
  ) {}

  /**
   * Prepare a database statement and bind supplied positional values.
   * @param query The SQL text containing any parameter placeholders.
   * @param values The values corresponding to the placeholders in order.
   */
  private sql(query: string, ...values: unknown[]) {
    return this.db.prepare(query).bind(...values);
  }

  /**
   * Require the current identity to have maintainer permissions.
   * @throws {RequestError} When the current identity lacks maintainer access.
   */
  private maintainer() {
    if (!this.user.maintainer) {
      throw new RequestError("Maintainer access required.", 403);
    }
  }

  /** Report saved model metadata and whether an encrypted credential exists. */
  async openAiSettings() {
    this.maintainer();
    const row = await this.sql(
      "SELECT model, credential IS NOT NULL AS hasCredential FROM openai_settings WHERE id = 1",
    ).first<{ model: string; hasCredential: number }>();
    return { model: row?.model ?? null, hasCredential: Boolean(row?.hasCredential) };
  }

  /** Load encrypted connection settings for the authorized backend integration. */
  async readOpenAiConnection() {
    this.maintainer();
    return this.sql("SELECT model, credential FROM openai_settings WHERE id = 1").first<{
      model: string;
      credential: string | null;
    }>();
  }

  /**
   * Save the model and optional replacement ciphertext in a permission-checked write.
   * @param model Model ID approved by the current maintainer.
   * @param credential Replacement encrypted envelope, or null to preserve the existing value.
   */
  async saveOpenAiSettings(model: string, credential: string | null) {
    this.maintainer();
    await this.sql(
      `INSERT INTO openai_settings (id, model, credential) SELECT 1, ?, ? WHERE ? = 1
       ON CONFLICT(id) DO UPDATE SET model = excluded.model,
         credential = COALESCE(excluded.credential, openai_settings.credential)`,
      model,
      credential,
      this.user.maintainer ? 1 : 0,
    ).run();
  }

  /** Remove the OpenAI credential while leaving the configured model in place. */
  async removeOpenAiKey() {
    this.maintainer();
    await this.sql(
      "UPDATE openai_settings SET credential = NULL WHERE id = 1 AND ? = 1",
      this.user.maintainer ? 1 : 0,
    ).run();
  }

  /**
   * Reserve one operation in the authenticated maintainer's one-minute rate window.
   * @param action OpenAI operation whose independent quota is being reserved.
   * @throws {RequestError} When the caller is unauthorized or exceeds the quota.
   */
  async reserveOpenAiRequest(action: "settings" | "catalog" | "ask") {
    this.maintainer();
    const result = await this.sql(
      `INSERT INTO openai_rate_limits (actor, action, window, hits)
       SELECT ?, ?, unixepoch(), 1 WHERE ? = 1
       ON CONFLICT(actor, action) DO UPDATE SET
         hits = CASE WHEN openai_rate_limits.window <= excluded.window - 60
                     THEN 1 ELSE openai_rate_limits.hits + 1 END,
         window = CASE WHEN openai_rate_limits.window <= excluded.window - 60
                       THEN excluded.window ELSE openai_rate_limits.window END
       WHERE openai_rate_limits.window <= excluded.window - 60 OR openai_rate_limits.hits < ?`,
      this.user.id,
      action,
      this.user.maintainer ? 1 : 0,
      action === "ask" ? 8 : 12,
    ).run();
    if (!result.meta.changes) {
      throw new RequestError("Too many OpenAI requests. Try again shortly.", 429);
    }
  }

  /**
   * Read the stored recipe policy and apply settings defaults.
   * @throws {Error} When stored settings do not form an object.
   */
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

  /** Return the effective code settings and supported rules for maintainers. */
  async codeSettings() {
    this.maintainer();
    return { policy: await this.readCodePolicy(), prettierOptions, eslintRules, qualityOptions };
  }

  /**
   * Validate and save a new code policy on behalf of a maintainer.
   * @param input The proposed recipe settings from the request body.
   */
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

  /**
   * Suggest frequently used tags from recipes visible in the requested section.
   * @param scope Browser section whose tag visibility rules apply.
   * @throws {RequestError} When the scope is invalid or requires maintainer access.
   */
  async tags(scope: unknown) {
    const published = "v.state = 'published' AND v.id = r.live";
    const own = "v.author = ? AND v.state != 'removed'";
    let condition;
    let bindings: string[] = [];
    switch (scope) {
      case "library":
      case undefined:
        condition = published;
        break;
      case "mine":
        condition = own;
        bindings = [this.user.id];
        break;
      case "review":
        this.maintainer();
        condition = reviewScope;
        break;
      case "contribute":
        condition = `(${published}) OR (${own})`;
        bindings = [this.user.id];
        break;
      default:
        throw new RequestError("Choose a supported tag scope.");
    }
    const rows = await this.sql(
      `SELECT tag.value AS name FROM revisions v LEFT JOIN recipes r ON r.slug = v.slug
       CROSS JOIN json_each(v.tags) AS tag
       WHERE (${condition}) AND tag.type = 'text'
       GROUP BY tag.value ORDER BY COUNT(*) DESC, tag.value LIMIT 100`,
      ...bindings,
    ).all<{ name: string }>();
    return rows.results.map(({ name }) => name).sort();
  }

  /**
   * Find one page of published recipes matching the requested terms and tag.
   * @param input The search filters and cursor received from the API or MCP client.
   */
  async search(input: Input) {
    return this.listPage(
      input,
      "JOIN recipes r ON r.slug = v.slug AND r.live = v.id",
      "v.state = 'published' AND v.published_at IS NOT NULL",
      [],
      "published_at",
    );
  }

  /**
   * List one page of revisions for an author or maintainer.
   * @param input The search filters and cursor received from the API or MCP client.
   * @param mine Whether to limit results to the current author's own submissions.
   */
  async queue(input: Input, mine: boolean) {
    if (!mine) {
      this.maintainer();
    }
    const state = str(input.state, "review status", 32, true);
    if (state && (mine || !Object.hasOwn(reviewStates, state))) {
      throw new RequestError("Choose a supported review status.");
    }
    const scope = mine ? "v.author = ? AND v.state != 'removed'" : reviewScope;
    return this.listPage(
      input,
      "",
      state ? `(${scope}) AND ${reviewStates[state]}` : scope,
      mine ? [this.user.id] : [],
      "created",
    );
  }

  /**
   * Read a bounded page ordered by timestamp and revision ID.
   * @param input The submitted search filters and pagination parameters.
   * @param join The fixed SQL join required for the list's visibility scope.
   * @param scope The fixed SQL visibility predicate for the selected list.
   * @param bindings The values required by that visibility predicate.
   * @param timestamp The column defining the list's primary sort order.
   */
  private async listPage(
    input: Input,
    join: string,
    scope: string,
    bindings: readonly string[],
    timestamp: "published_at" | "created",
  ) {
    const words = str(input.query, "search text", 160, true)
      .toLowerCase()
      .split(/\s+/u)
      .filter(Boolean);
    if (words.length > 12) {
      throw new RequestError("Search supports up to 12 terms.");
    }
    const tag = str(input.tag, "tag", 32, true).toLowerCase();
    const { limit, cursor } = pageOptions(input);
    const backwards = cursor?.direction === "previous";
    const order = backwards ? "ASC" : "DESC";
    const sort = `v.${timestamp}`;
    const reviewFields = timestamp === "created" ? ", v.removal_reason" : "";
    const where = [
      ...words.map(
        () => "instr(lower(v.slug || ' ' || v.title || ' ' || v.summary || ' ' || v.tags), ?) > 0",
      ),
      ...(tag ? ["EXISTS (SELECT 1 FROM json_each(v.tags) WHERE value = ?)"] : []),
      ...(cursor ? [`(${sort}, v.id) ${backwards ? ">" : "<"} (?, ?)`] : []),
    ];
    const { results } = await this.sql(
      `SELECT ${fields}${reviewFields}, ${sort} AS sort_time FROM revisions v ${join}
       WHERE (${scope}) ${where.length ? "AND " + where.join(" AND ") : ""}
       ORDER BY ${sort} ${order}, v.id ${order} LIMIT ?`,
      ...bindings,
      ...words,
      ...(tag ? [tag] : []),
      ...(cursor ? [cursor.time, cursor.id] : []),
      limit + 1,
    ).all<Revision & { sort_time: string }>();
    const page = results.slice(0, limit);
    if (backwards) {
      page.reverse();
    }
    const more = results.length > limit;
    return {
      items: page.map(({ sort_time: _sortTime, ...row }) => clean(row)),
      previousCursor: pageCursor("previous", (backwards ? more : cursor) ? page[0] : undefined),
      nextCursor: pageCursor("next", (backwards ? cursor : more) ? page.at(-1) : undefined),
    };
  }

  /**
   * Retrieve a visible recipe snapshot and optionally include review metadata.
   * @param input The slug, revision, and file parts requested by the client.
   * @param includeReview Whether to include line comments and allowed actions when available.
   */
  async get(input: Input, includeReview = false) {
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
    const canReadReview = this.user.maintainer || row.author === this.user.id;
    const review =
      includeReview && canReadReview
        ? {
            canComment: this.user.maintainer,
            comments: (
              await this.sql(
                `SELECT id, edit_version AS editVersion, part, line, excerpt, body
             FROM revision_comments WHERE revision = ? AND edit_version <= ?
             ORDER BY edit_version DESC, part, line, id`,
                row.id,
                row.edit_version,
              ).all<ReviewComment>()
            ).results,
          }
        : undefined;
    return {
      id: row.id,
      ...(review ? { review } : {}),
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

  /**
   * Save a maintainer's private feedback on the whole file or a line of the current edit.
   * @param input Revision ID, slug, edit version, part, optional one-based line and comment body.
   * @throws {RequestError} When access is denied, the file or line is invalid, or the edit has changed.
   */
  async comment(input: Input) {
    this.maintainer();
    const slug = str(input.slug, "recipe slug", 64);
    const id = revisionId(input.revision, "revision ID");
    const version = snapshotVersion(input.editVersion);
    const { part } = input;
    const line = input.line ?? null;
    if (
      !isRecipePart(part) ||
      (line !== null && (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1))
    ) {
      throw new RequestError("Choose a valid file part and, for a line comment, a line number.");
    }
    const body = str(input.body, "a comment", 2000);
    const row = await this.sql(
      "SELECT files, edit_version FROM revisions WHERE id = ? AND slug = ? AND state != 'removed'",
      id,
      slug,
    ).first<Pick<Revision, "files" | "edit_version">>();
    if (!row) {
      throw new RequestError("Recipe revision not found.", 404);
    }
    const stale = "This revision changed. Reload it before adding a comment.";
    if (row.edit_version !== version) {
      throw new RequestError(stale, 409);
    }
    const file = decodeFiles(row.files, [part])[part];
    if (file === undefined) {
      throw new RequestError("This file part does not exist in the selected revision.");
    }
    const excerpt = line === null ? null : sourceLines(file)[line - 1];
    if (excerpt === undefined) {
      throw new RequestError("This line does not exist in the selected file part.");
    }
    const saved = await this.sql(
      `INSERT INTO revision_comments (revision, edit_version, part, line, excerpt, body, reviewer)
       SELECT id, edit_version, ?, ?, ?, ?, ? FROM revisions
       WHERE id = ? AND slug = ? AND edit_version = ? AND state != 'removed'
       RETURNING id, edit_version AS editVersion, part, line, excerpt, body`,
      part,
      line,
      excerpt,
      body,
      this.user.id,
      id,
      slug,
      version,
    ).first<ReviewComment>();
    if (!saved) {
      throw new RequestError(stale, 409);
    }
    return saved;
  }

  /**
   * Format and lint a snapshot and translate diagnostics into request errors.
   * @param files The unvalidated file parts supplied by the author.
   * @param policy The effective policy controlling formatting and validation.
   * @throws {RequestError} When a part exceeds its limits or fails validation.
   */
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
      "SELECT id, files, edit_version FROM revisions WHERE fingerprints_ready = 0 AND files IS NOT NULL ORDER BY id LIMIT ?",
      limit + 1,
    ).all<LegacySnapshot>();
    const statements = [];
    for (const row of results.slice(0, limit)) {
      const files = decodeFiles(row.files, parts);
      const { snapshot, units, documentation, instructions } = await fingerprintRecipe(files);
      statements.push(
        this.sql(
          `UPDATE revisions SET code_hash = ?, unit_hashes = ?, documentation_hash = ?, instructions_hash = ?,
             fingerprints_ready = 1 WHERE id = ? AND edit_version = ? AND fingerprints_ready = 0 AND files IS NOT NULL`,
          snapshot,
          JSON.stringify(units),
          documentation,
          instructions,
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

  /**
   * Look up visible fingerprint collisions to explain a rejected write.
   * @param check The fingerprints and severities used for matching.
   * @param except The current revision ID to exclude when replacing a draft.
   */
  private async explainDuplicate(check: DuplicateCheck, except: string | null) {
    if (check.bindings().every((hash) => hash === null)) {
      return;
    }
    await check.report(
      this.sql(
        `SELECT EXISTS(SELECT 1 ${visibleDuplicate} AND code_hash = ?) AS code,
              EXISTS(SELECT 1 ${visibleDuplicate} AND documentation_hash = ?) AS documentation,
              EXISTS(SELECT 1 ${visibleDuplicate} AND instructions_hash = ?) AS instructions`,
        this.user.id,
        except,
        check.code,
        this.user.id,
        except,
        check.documentation,
        this.user.id,
        except,
        check.instructions,
      ),
    );
  }

  /**
   * Submit or replace an unapproved revision after validation and duplicate checks.
   * @param input The proposed recipe and revision operation received from the client.
   */
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
    if (input.allowDuplicates !== undefined && typeof input.allowDuplicates !== "boolean") {
      throw new RequestError("allowDuplicates must be a boolean.");
    }
    const tags = input.tags ?? [];
    if (!isArray(tags) || tags.length > 8) {
      throw new RequestError("Use up to eight tags.");
    }
    const normalizedTags = [...new Set(tags.map((tag) => str(tag, "tag", 32).toLowerCase()))];
    const policy = await this.readCodePolicy();
    const { files, warnings } = await this.normalizeSubmission(input.files, policy);
    await this.indexLegacySnapshots();
    const fingerprint = await fingerprintRecipe(files);
    const duplicate = duplicateCheck(fingerprint, policy.quality, input.allowDuplicates === true);
    const hashes = [
      fingerprint.snapshot,
      JSON.stringify(fingerprint.units),
      fingerprint.documentation,
      fingerprint.instructions,
    ];
    const match = [this.user.id, replace, ...duplicate.bindings()];
    const payload = {
      title,
      summary,
      tags: JSON.stringify(normalizedTags),
      files: JSON.stringify(files),
    };
    const notices = warnings.length ? { warnings } : {};
    if (replace) {
      const updated = await this.sql(
        `UPDATE revisions
         SET title = ?, summary = ?, tags = ?, files = ?, edit_version = edit_version + 1,
             state = 'pending', review_note = NULL, code_hash = ?, unit_hashes = ?,
             documentation_hash = ?, instructions_hash = ?, fingerprints_ready = 1
         WHERE id = ? AND slug = ? AND author = ? AND edit_version = ?
           AND state IN ('pending', 'changes') AND published_at IS NULL AND removal_reason IS NULL
           AND NOT EXISTS (${matchingSnapshot})`,
        payload.title,
        payload.summary,
        payload.tags,
        payload.files,
        ...hashes,
        replace,
        slug,
        this.user.id,
        editVersion,
        ...match,
      ).run();
      if (!updated.meta.changes) {
        await this.explainDuplicate(duplicate, replace);
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
        ...match,
      ),
      this.sql(
        `INSERT INTO revisions(id,slug,author,base,title,summary,tags,files,code_hash,unit_hashes,
          documentation_hash,instructions_hash,fingerprints_ready)
        SELECT ?,r.slug,?,?,?,?,?,?,?,?,?,?,1 FROM recipes r WHERE r.slug = ? AND NOT EXISTS (${matchingSnapshot}) AND (
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
        ...hashes,
        slug,
        ...match,
        base,
        this.user.id,
        this.user.maintainer,
        base,
        this.user.id,
        this.user.maintainer,
      ),
    ]);
    if (!result[1].meta.changes) {
      await this.explainDuplicate(duplicate, null);
      throw new RequestError("Choose an accessible base revision for this recipe.", 409);
    }
    return { slug, id, state: "pending", editVersion, ...notices };
  }

  /**
   * Apply a review, publication, or removal action to a recipe revision.
   * @param input The target revision, requested action, and accompanying review data.
   */
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
