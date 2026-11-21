# Code Cookbook

Code Cookbook, also called Bist, is a shared library of reusable code recipes and guides for
software teams and coding agents. Save a small solution with its tests or usage notes, review it
before sharing it, and retrieve the parts you need for another project.

- Search published recipes by keyword or tag in the browser or through the Model Context
  Protocol (MCP). Fetch only the parts you need.
- Submit TypeScript, public interfaces, tests, CSS, documentation, or agent instructions. A guide
  can consist of documentation or instructions alone.
- Review a specific revision before publishing it. Maintainers can compare edits and leave private
  comments on whole files or individual lines, including lines in Markdown files.

![The isRecord recipe in Code Cookbook with the sidebar, toolbar, documentation, source, and tests.](docs/is-record.jpg)

This README describes the source in the `develop` branch. Hosted instances may run an earlier
version. Recipe tests are stored and checked as text. Run them in the project where you reuse
the code.

## Install a private instance with ChatGPT Sites

If your ChatGPT account has access to Sites, you can deploy Bist from the public
`sendanor/bist` GitHub repository and connect it as a private MCP plugin for ChatGPT and
Codex in the ChatGPT desktop app. In ChatGPT on the web or in the desktop app, select
`@Sites` and send a prompt like this. [ChatGPT Sites documentation](https://learn.chatgpt.com/docs/sites/creating-a-site)

```text
@Sites Deploy Bist (Code Cookbook) from the develop branch of
https://github.com/sendanor/bist as a new private ChatGPT Site. Use the existing
application and build instructions. Set up the D1 database binding named DB and
apply the repository migrations. Ask me which verified ChatGPT email should be a
maintainer and set MAINTAINER_EMAILS in the Sites runtime settings.
Publish with access limited to my account and MCP enabled. Give me the Site URL
and help me install and connect its private Code Cookbook plugin for ChatGPT and Codex.
```

After the Site owner publishes it, open the plugin card Sites provides. If needed, find
**Code Cookbook** under **Plugins → Personal → Created by you**, then choose **Install**
and **Connect** as prompted. In a new ChatGPT or Codex conversation, select the plugin and
ask it to list your recipe revisions. An empty list is expected on a fresh instance.
[ChatGPT MCP installation guide](https://learn.chatgpt.com/docs/extend/mcp#3-publish-and-install)

If Sites needs a local copy of the source, clone the repository using the command below
and use the checkout as the source project in the ChatGPT desktop app.

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

Maintainers configure formatting, lint, type, CSS, and duplicate checks in **Settings → Code policy**.
See the [quality policy](QUALITY.md) for defaults, configurable checks, and supported inputs.

The included hosting configuration targets ChatGPT Sites and uses a Cloudflare Worker with a
D1 database binding named `DB`. To prepare an instance-specific configuration, copy
[the example manifest](.openai/hosting.example.json) to `.openai/hosting.json` and set its
`project_id` to your Sites project ID. The local manifest is ignored by Git. Configure
`MAINTAINER_EMAILS` as a comma-separated list of verified ChatGPT email addresses in the
hosted runtime. Apply the [D1 migrations](drizzle/) to the instance database. Keep deployment
settings and credentials outside the public repository.

### OpenAI assistant

The optional **Assistant** tool in the top bar lets maintainers ask questions about
published recipes while browsing the app.
Set a randomly generated 32-byte key, encoded as 64 hexadecimal characters, as the
`SETTINGS_ENCRYPTION_KEY` deployment secret. Keep a secure copy separate from D1 backups.
In **Settings → OpenAI**, save a restricted OpenAI project API key with **List models
(Read)** and **Responses API (Write)**. Bist loads the model catalog so
you can choose a model that supports the Responses API and function calling. Save the model
separately. Bist stores the API key encrypted in D1 and shows only
whether a key is configured. Maintainers can update the model or replace or remove the API key
without redeploying. [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)

Open **Assistant** and select **Check model access** to see whether the model appears in the key's
catalog, then ask a question to verify inference and tool support. If upgrading from an
environment-configured release, enter the model and credential in Bist Settings and remove
the old `OPENAI_API_KEY` and `OPENAI_MODEL` deployment values. If the deployment encryption
key changes or is lost, enter the OpenAI credential again to encrypt it under the replacement.

See [OpenAI integration](docs/openai-integration.md) for the current API calls and proposed
extensions.

The assistant sends each question and any published recipe excerpts it uses to OpenAI.
Bist does not save the conversation. The assistant can search published recipes and read
their source and documentation. Submitted drafts and private review feedback stay outside
its tool scope.

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

Code Cookbook is licensed under the [MIT License](LICENSE).
