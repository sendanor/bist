import { builtinModules } from "node:module";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Marked } from "marked";
import ts from "typescript";
import { checkTranslations } from "./translations.mjs";

const root = process.cwd();
const sourceRoot = resolve("src");
const browserFiles = new Set(["browser.js", "browser-api.js", "localization.js"]);
const baseFiles = new Set([
  "guards.ts",
  "line-diff.ts",
  "contracts.ts",
  "read-json-object.ts",
  "routes.ts",
]);
const virtual = new Map([
  ["cookbook:browser", "src/index.ts"],
  ["cookbook:typescript-libraries", "src/quality/recipe-types.ts"],
]);
const builtins = new Set(builtinModules.flatMap((name) => [name, "node:" + name]));
const problems = [];
const documentPaths = [];
const tsOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
  resolveJsonModule: true,
};

/**
 * Classify a source file for import boundary checks.
 * @param file The project-relative path to classify.
 */
function layer(file) {
  const path = relative(sourceRoot, file);
  if (baseFiles.has(path)) {
    return "base";
  }
  if (browserFiles.has(path) || path.startsWith("locales/")) {
    return "browser";
  }
  if (path.startsWith("quality/") || ["format.ts", "code-policy.ts"].includes(path)) {
    return "quality";
  }
  if (path === "store.ts") {
    return "storage";
  }
  if (path === "openai.ts") {
    return "provider";
  }
  if (path === "index.ts") {
    return "entry";
  }
  if (path.startsWith("../")) {
    return "tooling";
  }
  return "asset";
}

const allowedLayers = {
  base: ["base"],
  browser: ["base", "browser"],
  quality: ["base", "quality"],
  storage: ["base", "quality", "storage"],
  provider: ["base"],
  entry: ["base", "quality", "storage", "provider", "asset"],
  asset: ["asset"],
};

/**
 * Check whether the filesystem path is a regular file.
 * @param path The candidate file path to inspect.
 */
async function fileExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a resolved path stays within the repository.
 * @param path The absolute path to compare with the repository root.
 */
function withinRoot(path) {
  const name = relative(root, path);
  return name !== ".." && !name.startsWith("../") && !isAbsolute(name);
}

/**
 * Resolve a module specifier and record any architecture or path violations.
 * @param file The importing file to cite.
 * @param path The literal import path to resolve.
 * @param at The source position for the diagnostic.
 * @param typeOnly Whether the dependency is a type-only import.
 */
async function checkImport(file, path, at, typeOnly) {
  const name = relative(root, file);
  if (path === undefined) {
    problems.push(`${at} Use a literal dynamic module path. (module-path)`);
    return;
  }
  if (virtual.has(path)) {
    if (virtual.get(path) !== name) {
      problems.push(`${at} '${path}' is private to its declared entry point. (layer)`);
    }
    return;
  }
  if (builtins.has(path)) {
    if (layer(file) !== "tooling") {
      problems.push(`${at} Runtime Worker code cannot import '${path}'. (layer)`);
    }
    return;
  }
  if (isAbsolute(path) || path.startsWith("file:")) {
    problems.push(`${at} Use a project-relative module path. (module-path)`);
    return;
  }
  const target = ts.resolveModuleName(path, file, tsOptions, ts.sys).resolvedModule
    ?.resolvedFileName;
  if (!path.startsWith(".")) {
    if (layer(file) === "base") {
      problems.push(`${at} The base layer cannot depend on external packages. (layer)`);
    }
    if (!target) {
      try {
        import.meta.resolve(path);
      } catch {
        problems.push(`${at} Cannot resolve package '${path}'. (module-path)`);
      }
    }
    if (layer(file) !== "tooling" && ["eslint", "node:test"].includes(path) && !typeOnly) {
      problems.push(
        `${at} Build tooling is only available through a type import in runtime source. (layer)`,
      );
    }
    return;
  }
  const asset = /\.(?:html|css|json)$/u.test(path) ? resolve(dirname(file), path) : undefined;
  const absolute = target
    ? resolve(target)
    : asset && (await fileExists(asset))
      ? asset
      : undefined;
  if (!absolute || !withinRoot(await realpath(absolute))) {
    problems.push(`${at} Missing local module or target outside project: '${path}'. (module-path)`);
  } else if (allowedLayers[layer(file)] && !allowedLayers[layer(file)].includes(layer(absolute))) {
    problems.push(
      `${at} ${layer(file)} cannot import ${layer(absolute)} through '${path}', including type imports. (layer)`,
    );
  }
}

/**
 * Collect static and dynamic dependency references from a parsed source file.
 * @param ast The parsed file to walk for dependencies.
 */
function moduleReferences(ast) {
  const references = [];
  /**
   * Record a module load and its source location.
   * @param expression The expression that names the module to load.
   * @param typeOnly Whether only types are referenced.
   * @param position The node offset to report for unresolved paths.
   */
  function load(expression, typeOnly = false, position = expression?.getStart(ast)) {
    references.push({
      path: expression && ts.isStringLiteralLike(expression) ? expression.text : undefined,
      position,
      typeOnly,
    });
  }

  /**
   * Walk the syntax tree and record the module references on each node.
   * @param node The current syntax node in the walk.
   */
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        load(node.moduleSpecifier, node.isTypeOnly || node.importClause?.isTypeOnly);
      }
    } else if (ts.isExternalModuleReference(node)) {
      load(node.expression);
    } else if (ts.isImportTypeNode(node)) {
      load(
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
        true,
        node.getStart(ast),
      );
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      load(node.arguments[0], false, node.getStart(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return references;
}

/**
 * Check one authored file for forbidden dependencies and code patterns.
 * @param file The absolute path to the authored file.
 * @param text The source text to parse and inspect.
 */
async function inspectCode(file, text) {
  const name = relative(root, file);
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  for (const reference of moduleReferences(ast)) {
    const { line, character } = ast.getLineAndCharacterOfPosition(reference.position ?? 0);
    await checkImport(
      file,
      reference.path,
      `${name}:${line + 1}:${character + 1}`,
      reference.typeOnly,
    );
  }
  if (layer(file) === "browser" && name !== "src/browser-api.js") {
    /**
     * Inspect a syntax node and recursively visit its children.
     * @param node The current syntax node in the walk.
     */
    function visit(node) {
      if (
        ts.isIdentifier(node) &&
        [
          "fetch",
          "XMLHttpRequest",
          "WebSocket",
          "EventSource",
          "indexedDB",
          "localStorage",
          "sessionStorage",
          "sendBeacon",
        ].includes(node.text)
      ) {
        const { line, character } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        problems.push(
          `${name}:${line + 1}:${character + 1} Use the browser service API for network or storage. (layer)`,
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}

/**
 * Find authored files recursively while skipping excluded paths.
 * @param directory The directory to walk for project files.
 */
async function collect(directory) {
  const skip = new Set([".git", ".agents", ".codex", ".aws", "node_modules", "dist", "coverage"]);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (skip.has(entry.name)) {
      continue;
    }
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(path);
    } else if (/\.(?:md|js|mjs|ts|jsx|tsx)$/u.test(entry.name) && entry.isFile()) {
      if (entry.name.endsWith(".md")) {
        documentPaths.push(path);
      } else {
        await inspectCode(path, await readFile(path, "utf8"));
      }
    }
  }
}

/**
 * Derive a Markdown heading anchor for local link validation.
 * @param heading The heading text before anchor normalization.
 */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

/** Check local documentation links and required files and collect failures. */
async function checkDocs() {
  const markdown = new Marked();
  const docs = new Map();
  for (const path of documentPaths) {
    const text = await readFile(path, "utf8");
    const tokens = markdown.lexer(text);
    const headings = new Set();
    const links = [];
    markdown.walkTokens(tokens, (token) => {
      if (token.type === "heading") {
        headings.add(slug(token.text));
      }
      if (token.type === "link" || token.type === "image") {
        links.push(token.href);
      }
    });
    docs.set(path, { text, headings, links });
  }
  for (const [path, { links }] of docs) {
    for (const link of links) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(link)) {
        continue;
      }
      try {
        const [pathname, fragment] = link.split("#", 2).map(decodeURIComponent);
        const target = pathname ? resolve(dirname(path), pathname) : path;
        if (
          !withinRoot(target) ||
          !(await fileExists(target)) ||
          (fragment && docs.has(target) && !docs.get(target).headings.has(fragment))
        ) {
          problems.push(
            `${relative(root, path)} Broken local documentation link '${link}'. (doc-link)`,
          );
        }
      } catch {
        problems.push(`${relative(root, path)} Invalid documentation URL '${link}'. (doc-link)`);
      }
    }
  }
  for (const required of ["README.md", "AGENTS.md", "HANDOFF.md", "QUALITY.md"]) {
    if (!docs.has(resolve(required))) {
      problems.push(`Missing required documentation: ${required}. (required-doc)`);
    }
  }
  const plan = docs.get(resolve("PLAN.md"));
  if (plan) {
    const tasks = new Set();
    const entries = [...plan.text.matchAll(/^#{2,6}\s+\[?(TASK-[\d]+)\]?\s+.*$/gmu)];
    for (const [index, entry] of entries.entries()) {
      const id = entry[1];
      if (tasks.has(id)) {
        problems.push(`PLAN.md Duplicate task ID '${id}'. (plan)`);
      }
      tasks.add(id);
      const block = plan.text.slice(entry.index + entry[0].length, entries[index + 1]?.index);
      if (!/^\s*(?:[-*]\s+)?Acceptance criteria:\s*\S.{9,}$/imu.test(block)) {
        problems.push(`PLAN.md '${id}' needs observable acceptance criteria. (plan)`);
      }
    }
    if (!entries.length) {
      problems.push(
        "PLAN.md Expected task headings with TASK-123 IDs and acceptance criteria. (plan)",
      );
    }
  }
}

await collect(root);
await checkDocs();
problems.push(...(await checkTranslations()));
for (const problem of problems) {
  console.error(problem);
}
if (problems.length) {
  process.exitCode = 1;
}
