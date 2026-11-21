# Recipe workflow

## Edit and review

**Recipe library** shows published recipes. Leave the search field empty to browse all of
them, or select **Show all recipes** to clear a search.

**Review queue** shows up to 20 revisions per page, newest first. Filter by keyword, tag,
or review status, then use **Previous page** and **Next page**. Search matches the slug,
title, summary, and tags. The URL retains the filters and page when shared with another
maintainer.

Click a tag on a recipe or in a result list to add it to the current search. Click a
selected tag again to remove it. You can also type keywords and tags in the same field,
for example `storage tag:architecture tag:typescript`. Quote a tag that contains spaces,
as in `tag:"code review"`. Results must match every keyword and every selected tag.
A keyword is optional. Search supports up to eight tags.

A recipe can include any combination of `source`, `interface`, `tests`, `styles`,
`documentation`, and `instructions`. Include at least one non-empty part. Each part has a
12,000 UTF-8 byte limit, and a JSON request has a 96,000 byte limit.

Each part has an optional **Filename** in the contribution form. Use a filename with the
appropriate extension, such as `is-record.ts`, `record.d.ts`, or `is-record.test.ts`.
Leave the field blank for the default. Update local imports if you rename a code file.

On the contribution form, select an existing tag or type new tags separated by commas.
Use **Add tags** or press Enter to add the typed tags. Select a tag's remove button to
take it off the draft. Each revision supports up to eight tags.

Use a lowercase, hyphenated slug. To update your own unapproved revision, use **Edit draft**
and include all parts you want to keep. To make further changes to an approved or published
revision, propose an improvement. This creates a new revision that needs its own approval.

Maintain a separation between review and publication. A maintainer can approve a revision
or request changes. Publishing an approved revision makes it the default in search.
Maintainers can click a code line or use its line-number button to comment directly
under the line. For documentation and agent instructions, open **Markdown source** to
comment on the original Markdown lines, including blank lines. Select **Comment on file**
to discuss the whole file. The author and maintainers can read the feedback.
After a draft edit, earlier comments appear under **Comments on earlier edits**, with
the original excerpt preserved for each line comment.

Authors can remove their own unapproved revisions, including revisions with changes requested.
Protected removal requires a reason and maintainer action. Quarantining a revision hides it
from contributors immediately and clears its published pointer if it was current.

## Use MCP

The MCP endpoint is `/mcp` on your instance. For a hosted instance, use its authorized MCP
connection. The repository does not distribute connection credentials. See the
[local MCP example](local-preview.md#try-mcp) for a request you can run without an account.

Maintainers can open **Settings → MCP** to copy the endpoint, check its tool list, pause
MCP tool calls, or choose which tools clients can use. Changes apply to new calls even
if a client has cached an older tool list. The MCP endpoint still responds to discovery
when paused. Existing client and recipe permissions continue to apply, and the browser
workflow and built-in OpenAI assistant use their own application routes.

**Settings → MCP → Assistant add-ons** can enable the public OpenAI Docs lookup.
It is off by default. After enabling it, open **Search documentation** in **Assistant**
and enter public search terms alongside a question. Bist makes at most one documentation search per question.
The MCP endpoint receives only those terms. The Assistant displays links returned by
the documentation service. [OpenAI Docs MCP](https://developers.openai.com/learn/docs-mcp)

Enable **Context7** in the same list to look up public library documentation.
In **Assistant**, enter public search terms and an exact library ID such as
`/react/react`. Bist sends those two fields to Context7. Leave the library ID blank
to use the OpenAI Docs connection, if enabled. [Context7 MCP tools](https://context7.com/docs/resources/all-clients)

- `search_recipes` finds published recipe summaries by keyword and tag. Listing tools accept
  `tags` as an array of exact tags that must all match, alongside the optional `query`.
- `get_recipe` takes a slug and can retrieve selected parts. It defaults to the current
  published revision. Supply a revision ID to open a draft you can access.
- `submit_recipe` accepts a slug, title, summary, optional tags, and the file snapshot.
  Set `replace` and the current `editVersion` to edit a draft. Set `base` to create a
  new revision from an existing one.
  Set `fileNames` by part, for example `{"source":"is-record.ts","interface":"record.d.ts"}`.
  Omit a name to keep it on a draft edit or use an empty string to restore the default.
  `get_recipe` returns the effective filenames for the requested parts in `fileNames`.
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

## Use agent skills

In **Settings → MCP → Assistant add-ons**, maintainers enable built-in skills
for this instance. The model can load an enabled skill when it fits the task.
Caveman and Suomen kieli are enabled by default. Maintainers can also enable the CMS
skills for SEO and social previews, layout, importing source material, and checking
drafts before publication. An empty saved selection disables skill loading.

Open **Assistant** from the top bar on any page. It docks to the right when the window
is wide enough. Drag its left edge or focus the divider and use the arrow keys to resize it.
In narrower windows it appears above the page content. Messages and
the current draft stay in the panel while you navigate. CMS skills use the information
and tools available in Bist.

The library offers Caveman and Suomen kieli as downloads.
On a published recipe, **Download SKILL.md** exports its agent instructions
with skill metadata. If the recipe has only documentation, the export uses that text.

Review the file before installing it. For project-scoped Codex use, save it as
`.agents/skills/<skill-name>/SKILL.md`, using the manifest's `name` for the folder,
then start a new Codex session. [Codex skill installation](https://developers.openai.com/api/reference/cli)

## Configure LLM review

**Settings → LLM review** controls the review model, reasoning effort, and instructions
for each recipe file type. A fresh instance shows the following rules. Review starts
when a maintainer first finishes connecting an OpenAI key and an Assistant model.
To opt out, save **Enable LLM review** unchecked before completing setup. Bist preserves
saved policies, including individual rules set to **Off**.

| File type          | On a finding | What reviewers look for                                                                                                          |
| ------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Documentation      | Warn         | A README's first usable result, missing prerequisites or contradictory examples. Guides, licenses and templates can stand alone. |
| Public interface   | Block        | Infrastructure leaking into a public contract, unchecked return types or missing JSDoc for named callables.                      |
| Source             | Block        | Demonstrable behavior or architecture defects, unsafe input handling or missing JSDoc for named callables.                       |
| Tests              | Warn         | Assertions that miss a regression, unawaited checks and uncontrolled external state.                                             |
| Stylesheet         | Warn         | Class naming, loss of keyboard focus or rules that break narrow layouts or unrelated components.                                 |
| Agent instructions | Block        | Directions to disclose credentials, bypass approvals or perform unauthorized destructive work, or conflicting mandatory steps.   |

**Warn** lets the author acknowledge a finding and continue. Reviewers see acknowledged
warnings on the revision. **Block** requires a correction. Each instruction asks for
evidence in the submitted file and an actionable fix. Optional files can be omitted.

By default, review uses the Assistant model and its model-specific default reasoning effort.
The check sends only new or changed files covered by enabled rules to OpenAI. Reading
a recipe or editing only its metadata makes no review request. Once review is enabled,
submissions that require it fail if the provider is unavailable or the key is removed.

Optionally enter a public MCP reference query under **LLM review**. Enable OpenAI Docs
or Context7 in **Assistant add-ons** so the model can look up that reference when it
needs it. The MCP server receives the configured public query and optional library ID.

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
