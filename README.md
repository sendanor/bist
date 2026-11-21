# Code Cookbook

Code Cookbook, also called Bist, is a shared library of reusable code recipes and guides for
software teams and coding agents. Save a small solution with its tests or usage notes, review it
before sharing it, and retrieve the parts you need for another project.

- Search published recipes by keyword or tag in the browser or through the Model Context
  Protocol (MCP). Fetch only the parts you need.
- Submit TypeScript, public interfaces, tests, CSS, documentation, or agent instructions. A guide
  can consist of documentation or instructions alone.
- Review a specific revision before publishing it. Maintainers can compare edits and leave private
  comments on individual lines, including lines in Markdown files.

![The isRecord recipe in Code Cookbook with the sidebar, toolbar, documentation, source, and tests.](docs/is-record.jpg)

This README describes the source in the `develop` branch. Hosted instances may run an earlier
version. Recipe tests are stored and checked as text. Run them in the project where you reuse
the code.

## Try it locally

You need Git, Bash, Node.js 24 with npm, and access to the npm registry. The local preview uses test
data and a synthetic maintainer account. It needs no ChatGPT account or hosted database.

Clone the repository and build the Worker from the repository root.

```sh
git clone --branch develop https://github.com/sendanor/bist.git
cd bist
npm ci
npm run build
```

Start the [local browser preview](docs/local-preview.md) and open `http://127.0.0.1:8787/`.
In **Contribute**, select **Fill with example**, then **Submit for review**. The recipe opens
with a **Pending review** status. You can approve and publish it from **Revision actions**
using the preview account, then find **Batch items into chunks** in the recipe library.

If you already have access to a hosted instance, open its URL and sign in with ChatGPT.
The instance operator manages access.

## Use recipes

A revision is one complete snapshot of a recipe. Use **Edit draft** to update your own
unapproved revision in place. To improve an approved or published revision, create a new
revision from it. Approval belongs to that specific revision, and publishing makes it the
default version in search. For review comments and removal, see the
[recipe workflow](docs/recipe-workflow.md).

MCP clients can use `search_recipes` to find a slug and `get_recipe` to retrieve a published
revision or selected parts. The [recipe workflow](docs/recipe-workflow.md#use-mcp) describes the
endpoint and submission fields. The [local preview](docs/local-preview.md#try-mcp) includes a
runnable MCP request.

## Configure an instance

Maintainers configure formatting, lint, type, CSS, and duplicate checks in **Settings**.
See the [quality policy](QUALITY.md) for defaults, configurable checks, and supported inputs.

The included hosting configuration targets ChatGPT Sites and uses a Cloudflare Worker with a
D1 database binding named `DB`. To prepare an instance-specific configuration, copy
[the example manifest](.openai/hosting.example.json) to `.openai/hosting.json` and set its
`project_id` to your Sites project ID. The local manifest is ignored by Git. Configure
`MAINTAINER_EMAILS` as a comma-separated list of verified ChatGPT email addresses in the
hosted runtime. Apply the [D1 migrations](drizzle/) to the instance database. Keep deployment
settings and credentials outside the public repository.

## Development

From the repository root, after `npm ci`, run the repository checks and tests.

```sh
npm run check
npm test
```

The tests exercise the built Worker with Miniflare and a temporary local database. They cover
submission, review, publication, and retrieval. They run trusted repository fixtures in a
separate consumer project. See [AGENTS.md](AGENTS.md) for contribution and commit practices.
[HANDOFF.md](HANDOFF.md) records historical context and plans.

Report reproducible bugs or request features through
[GitHub Issues](https://github.com/sendanor/bist/issues). The repository does not document a
separate channel for security reports.

## License

[LICENSE](LICENSE) contains the MIT License. The license metadata in
[package.json](package.json) and [package-lock.json](package-lock.json) currently says ISC.
