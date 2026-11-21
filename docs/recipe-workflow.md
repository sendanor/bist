# Recipe workflow

## Edit and review

**Review queue** shows up to 20 revisions per page, newest first. Filter by keyword, tag,
or review status, then use **Previous page** and **Next page**. Search matches the slug,
title, summary, and tags. The URL retains the filters and page when shared with another
maintainer.

A recipe can include any combination of `source`, `interface`, `tests`, `styles`,
`documentation`, and `instructions`. Include at least one non-empty part. Each part has a
12,000 UTF-8 byte limit, and a JSON request has a 96,000 byte limit.

Use a lowercase, hyphenated slug. To update your own unapproved revision, use **Edit draft**
and include all parts you want to keep. To make further changes to an approved or published
revision, propose an improvement. This creates a new revision that needs its own approval.

Maintain a separation between review and publication. A maintainer can approve a revision
or request changes. Publishing an approved revision makes it the default in search.
Open **Comments** on a file part to review it. Maintainers can select **Comment on file**
to discuss the whole file or select a line number to comment on an individual line,
including Markdown and blank lines. The author and maintainers can read the feedback.
After a draft edit, earlier comments appear under **Comments on earlier edits**, with
the original excerpt preserved for each line comment.

Authors can remove their own unapproved revisions, including revisions with changes requested.
Protected removal requires a reason and maintainer action. Quarantining a revision hides it
from contributors immediately and clears its published pointer if it was current.

## Use MCP

The MCP endpoint is `/mcp` on your instance. For a hosted instance, use its authorized MCP
connection. The repository does not distribute connection credentials. See the
[local MCP example](local-preview.md#try-mcp) for a request you can run without an account.

- `search_recipes` finds published recipe summaries by query or tag.
- `get_recipe` takes a slug and can retrieve selected parts. It defaults to the current
  published revision. Supply a revision ID to open a draft you can access.
- `submit_recipe` accepts a slug, title, summary, optional tags, and the file snapshot.
  Set `replace` and the current `editVersion` to edit a draft. Set `base` to create a
  new revision from an existing one.
- `my_revisions` lists your submissions and their review statuses.
- `review_queue` lists revisions awaiting maintainer action. It accepts the keyword
  `query`, a `tag`, and the optional `state` filter (`pending`, `approved`, `quarantined`,
  or `removal`).

List tools return an object with `items`, `nextCursor`, and `previousCursor`. They default
to 20 summaries and accept a `limit` from 1 to 50. To continue, send the returned cursor as
`cursor` with the same filters and limit. A null cursor indicates the end in that direction.
Omit the cursor when changing filters. Listings return metadata only. Use `get_recipe` with
selected `parts` for file content.

Duplicate checks consider your active revisions and published recipes. Code is compared as a
whole snapshot, while documentation and agent instructions are checked separately.
Maintainers can disable, warn on, or block duplicates. Retry with `allowDuplicates: true`
only to acknowledge a duplicate warning. Older revisions are indexed in batches, so you
may be asked to retry a submission while that work finishes. See the
[quality policy](../QUALITY.md) for other checks.

## Run a recipe's tests

Run downloaded tests in the project that consumes the recipe. When tests import
`./source.ts` and use Node's built-in `node:test` and `node:assert/strict`, save the
parts as `source.ts` and `recipe.test.ts` in an ECMAScript module project. From that
directory, run the test suite with Node.js 24.

```sh
node --test recipe.test.ts
```

Bist can type-check these imports using pinned Node declarations. Review recipe code and
tests before running them in your environment.
