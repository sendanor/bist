# Local browser preview

This preview runs the built Worker with Miniflare, a local Workers runtime, and an in-memory
D1 database. It binds to `127.0.0.1` and supplies a synthetic identity so you can test both
author and maintainer workflows. Use it only for local testing.

From the repository root, install and build as described in the
[README](../README.md#try-it-locally). Then run this command in Bash. Leave it running while
you use the preview. If port 8787 is already in use, change it in `origin` and use the
corresponding URL below.

```sh
mkdir -p .tmp
cat > .tmp/local-preview.mjs <<'JS'
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Miniflare } from "miniflare";

const origin = new URL("http://127.0.0.1:8787");
const worker = new Miniflare({
  scriptPath: "dist/server/index.js",
  modules: true,
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: "cookbook-preview" },
  bindings: { MAINTAINER_EMAILS: "preview@example.test" },
});
const db = await worker.getD1Database("DB");
const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
for (const { tag } of journal.entries) {
  const sql = await readFile(`drizzle/${tag}.sql`, "utf8");
  await db.batch(sql.split("--> statement-breakpoint").map((part) => db.prepare(part.trim())));
}

const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const result = await worker.dispatchFetch(origin.href.slice(0, -1) + request.url, {
      method: request.method,
      headers: {
        ...request.headers,
        "oai-authenticated-user-id": "preview",
        "oai-authenticated-user-email": "preview@example.test",
      },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    console.error(error);
    response.writeHead(500);
    response.end("Local preview failed. See the terminal.");
  }
});
server.listen(Number(origin.port), origin.hostname, () => console.log(`Open ${origin.href}`));
JS
node .tmp/local-preview.mjs
```

Open `http://127.0.0.1:8787/`. Submit the built-in example from **Contribute**. Open
**Revision actions**, select **Approve revision**, and confirm. Open **Revision actions** again
and select **Publish approved revision**, then confirm. The recipe title appears in the library after publication.
Stop the preview with Ctrl+C. Its data is discarded when the process exits.

## Try MCP

With the example published and the preview still running, run this request with curl from another terminal.

```sh
curl --fail --silent --show-error http://127.0.0.1:8787/mcp \
  --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_recipes","arguments":{"query":"batch"}}}'
```

The JSON-RPC result includes a text item containing the recipe summary as JSON. Look for
the slug `batch-items`. The preview injects the synthetic identity for this request too.
Hosted clients need authorized access to their own instance.
