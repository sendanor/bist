import { mkdir, cp, readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { assertPublicBundle } from "./public-bundle.mjs";

const english = JSON.parse(await readFile("src/locales/en.json", "utf8"));
const htmlEscapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

const compilerDir = dirname(createRequire(import.meta.url).resolve("typescript"));
const standardLibraries = {};
for (const file of (await readdir(compilerDir)).sort()) {
  if (
    /^lib\.(?:es\d[^.]*|es5|es6|es201[5-9].+|es202[0-6].+|dom(?:\.iterable)?|decorators(?:\.legacy)?)\.d\.ts$/u.test(
      file,
    )
  ) {
    standardLibraries["/" + file] = await readFile(join(compilerDir, file), "utf8");
  }
}
await mkdir("dist/.openai", { recursive: true });
try {
  await cp(".openai/hosting.json", "dist/.openai/hosting.json");
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
  await cp(".openai/hosting.example.json", "dist/.openai/hosting.json");
}
await cp("drizzle", "dist/.openai/drizzle", { recursive: true });
const client = await build({
  entryPoints: ["src/browser.js"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
});
assertPublicBundle(client.outputFiles[0].text);
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  external: [
    "fs",
    "path",
    "os",
    "crypto",
    "inspector",
    "perf_hooks",
    "source-map-support",
    "node:*",
  ],
  loader: { ".html": "text", ".css": "text" },
  plugins: [
    {
      name: "cookbook-bundles",
      setup(builder) {
        builder.onResolve({ filter: /^cookbook:typescript-libraries$/ }, () => ({
          path: "standard-libraries",
          namespace: "cookbook-libraries",
        }));
        builder.onLoad({ filter: /.*/, namespace: "cookbook-libraries" }, () => ({
          contents: JSON.stringify(standardLibraries),
          loader: "json",
        }));
        builder.onLoad({ filter: /\/src\/page\.html$/ }, async ({ path }) => {
          const template = await readFile(path, "utf8");
          const html = template.replace(/\{\{t:([a-z0-9-]+)\}\}/gu, (_, key) => {
            if (!Object.hasOwn(english, key)) {
              throw new Error(`Missing shell translation: ${key}`);
            }
            return english[key].replace(/[&<>"']/gu, (character) => htmlEscapes[character]);
          });
          return { contents: html, loader: "text" };
        });
        // Sites exposes Node globals. The recipe compiler uses only our in-memory host.
        builder.onLoad({ filter: /\/typescript\/lib\/typescript\.js$/ }, async ({ path }) => {
          const source = await readFile(path, "utf8");
          const nodeHost =
            'return typeof process !== "undefined" && !!process.nextTick && !process.browser && typeof require !== "undefined";';
          if (source.split(nodeHost).length !== 2) {
            throw new Error("Review TypeScript's Node host detection after upgrading TypeScript.");
          }
          return { contents: source.replace(nodeHost, "return false;"), loader: "js" };
        });
        // Prettier's pinned TypeScript parser already generates ESLint-compatible
        // tokens. Enable them so token-based ESLint rules can use the same AST.
        builder.onLoad({ filter: /\/prettier\/plugins\/typescript\.mjs$/ }, async ({ path }) => {
          const source = await readFile(path, "utf8");
          const flag = "comment:!0,tokens:!1,loggerFn:!1,project:!1";
          if (source.split(flag).length !== 2) {
            throw new Error("Review the TypeScript parser token flag after upgrading Prettier.");
          }
          return {
            contents: source.replace(flag, flag.replace("tokens:!1", "tokens:!0")),
            loader: "js",
          };
        });
        builder.onResolve({ filter: /^cookbook:browser$/ }, () => ({
          path: "browser-client",
          namespace: "cookbook",
        }));
        builder.onLoad({ filter: /.*/, namespace: "cookbook" }, () => ({
          contents: client.outputFiles[0].text,
          loader: "text",
        }));
      },
    },
  ],
});

async function rejectSourceMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) {
      await rejectSourceMaps(target);
    } else if (entry.name.endsWith(".map")) {
      throw new Error(`Source map found in publishable output: ${target}`);
    }
  }
}
await rejectSourceMaps("dist");
