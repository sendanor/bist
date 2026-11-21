# Code Cookbook

A TypeScript Worker with a browser workspace and a stateless MCP endpoint. Both surfaces use the same D1 database. The cookbook handles recipe files as text and applies bundled Prettier and ESLint to TypeScript parts. Maintainers can configure formatting, lint, type, and optional stylesheet checks in Settings. See the [quality policy](QUALITY.md). The policy applies to new revisions submitted through the website and MCP. Submitted files are never run by the service.

## Development

Run `npm ci`, `npm run check`, `npm run build`, and `node scripts/smoke.mjs`. The smoke test uses the actual Worker bundle in workerd, applies the D1 migration, verifies the author/maintainer/reader flow and persistence across runtime restart, and executes a known fixture in a separate consumer project. It reports measured reuse latency and selective versus full retrieval payload sizes and tokens using the o200k_base tokenizer.

The Sites manifest declares `DB` and MCP. For a private deployment, copy `.openai/hosting.example.json` to the ignored `.openai/hosting.json` and set the target Sites project ID there. Local builds can use the example directly. Keep the Site’s access policy private or scoped to trusted collaborators. Set `MAINTAINER_EMAILS` in the hosted runtime as a comma-separated allowlist of verified ChatGPT email addresses. A signed-in Site member can contribute. Maintainers can review, publish, quarantine, and approve protected removal. The owner may review their own submission in this single-maintainer MVP. MCP tools can submit, search, retrieve, and list owned revisions. Moderation uses the browser.

A new recipe uses a lowercase, hyphenated slug. To update your own draft before approval, use **Edit draft** or pass its ID as `replace` and its current `editVersion` to MCP. Include the complete file snapshot. You can also remove your own unapproved revision from its review actions, including after a reviewer requests changes. To improve a reviewed and approved revision, use its ID as `base` to create a new revision. Publishing replaces the default revision shown in search. Quarantine immediately hides a revision from contributors and clears the published pointer if it was current. Protected removal requires a recorded reason and a subsequent maintainer action.

Code parts have individual SHA-256 fingerprints and a combined fingerprint. A new submission
cannot repeat the complete code of your own active revisions or a published recipe, even with
different formatting or documentation. The comparison includes TypeScript source, interfaces,
tests, and CSS. Changing any code part can create a new revision. Editing the same draft can
also update just its documentation or metadata. Older revisions are indexed in batches on
submission. If the service reports that indexing is still in progress, retry the submission.
