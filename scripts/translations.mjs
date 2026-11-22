import { readFile, readdir } from "node:fs/promises";
import ts from "typescript";

const visibleAttributes = new Set(["placeholder", "alt", "title", "aria-label"]);
const copyMaps = new Set(["labels", "parts", "stateLabels"]);
const userCalls = new Map([
  ["empty", 0],
  ["banner", 0],
  ["btn", 0],
  ["buttonLink", 0],
  ["title", 0],
  ["field", 1],
  ["addAction", 1],
  ["el", 2],
]);

/**
 * Collect translatable strings and translation keys from browser source.
 * @param ast The parsed browser module to inspect.
 */
export function browserCopy(ast) {
  const strings = [];
  const used = new Set();
  /**
   * Identify the name of a supported translation or DOM helper call.
   * @param node The call node whose name is needed.
   */
  function callName(node) {
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      ? node.expression.text
      : undefined;
  }

  /**
   * Inspect translatable values and visit child nodes recursively.
   * @param node The current browser syntax node.
   */
  function visit(node) {
    if (callName(node) === "t") {
      const key = node.arguments[0];
      if (key && ts.isStringLiteral(key)) {
        used.add(key.text);
      } else {
        strings.push({ node, dynamicKey: true });
      }
      return;
    }
    if (ts.isStringLiteralLike(node) && /\p{L}/u.test(node.text)) {
      let current = node;
      while (current.parent) {
        const wrapper = current.parent;
        if (
          (ts.isBinaryExpression(wrapper) &&
            [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken].includes(
              wrapper.operatorToken.kind,
            )) ||
          (ts.isConditionalExpression(wrapper) && wrapper.condition !== current) ||
          ts.isParenthesizedExpression(wrapper) ||
          ts.isArrayLiteralExpression(wrapper) ||
          (ts.isPropertyAccessExpression(wrapper) && wrapper.expression === current) ||
          (ts.isCallExpression(wrapper) && wrapper.expression === current)
        ) {
          current = wrapper;
        } else {
          break;
        }
      }
      const parent = current.parent;
      const name = parent?.name?.text;
      const call = callName(parent);
      const index = call ? parent.arguments.indexOf(current) : -1;
      const first = userCalls.get(call);
      if (
        (parent &&
          ts.isPropertyAssignment(parent) &&
          parent.initializer === current &&
          (visibleAttributes.has(name) || copyMaps.has(parent.parent.parent?.name?.text))) ||
        (first !== undefined &&
          index >= first &&
          (["el", "title", "empty"].includes(call) || index === first)) ||
        (parent &&
          ts.isBinaryExpression(parent) &&
          parent.right === current &&
          parent.left?.name?.text === "textContent") ||
        (parent && ts.isNewExpression(parent) && parent.expression.getText(ast) === "Error")
      ) {
        strings.push({ node });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { strings, used };
}

const shellKey = /\{\{t:([a-z0-9-]+)\}\}/gu;
/**
 * Collect translation placeholders from the browser shell.
 * @param html The HTML template before translation is applied.
 */
export function shellCopy(html) {
  const used = new Set([...html.matchAll(shellKey)].map((match) => match[1]));
  const source = html.replace(shellKey, "");
  const raw = [...source.matchAll(/>([^<]*\p{L}[^<]*)</gu)].map((match) => match[1].trim());
  for (const match of source.matchAll(/\b(?:aria-label|content)="([^"]*\p{L}[^"]*)"/gu)) {
    if (!match[1].startsWith("width=")) {
      raw.push(match[1]);
    }
  }
  return { used, raw };
}

/** Validate translation keys, placeholders, and visible source strings. */
export async function checkTranslations() {
  const findings = [];
  const locales = new Map();
  for (const file of (await readdir("src/locales")).sort()) {
    if (!file.endsWith(".json")) {
      continue;
    }
    locales.set(file, JSON.parse(await readFile("src/locales/" + file, "utf8")));
  }
  const fallback = locales.get("en.json");
  if (!fallback) {
    return ["Missing English translation catalog."];
  }
  const used = new Set();
  for (const file of [
    "src/browser.js",
    "src/browser-api.js",
    "src/browser-dom.js",
    "src/file-editor.js",
  ]) {
    const ast = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    );
    const result = browserCopy(ast);
    for (const key of result.used) {
      used.add(key);
    }
    for (const { node, dynamicKey } of result.strings) {
      const { line, character } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      findings.push(
        `${file}:${line + 1}:${character + 1} ${dynamicKey ? "Use a literal translation key." : "Localize " + JSON.stringify(node.text) + "."} (i18n)`,
      );
    }
  }
  const shell = shellCopy(await readFile("src/page.html", "utf8"));
  for (const text of shell.raw) {
    findings.push(`src/page.html Localize ${JSON.stringify(text)}. (i18n)`);
  }
  for (const key of shell.used) {
    used.add(key);
  }
  for (const key of used) {
    if (!Object.hasOwn(fallback, key)) {
      findings.push(`Missing English translation for '${key}'. (i18n)`);
    }
  }
  /**
   * Collect a translation string's interpolation placeholders.
   * @param text The source or translated message to examine.
   */
  const placeholders = (text) =>
    [...text.matchAll(/\{[\w-]+\}/gu)]
      .map((match) => match[0])
      .sort()
      .join(",");
  for (const [file, catalog] of locales) {
    for (const [key, value] of Object.entries(catalog)) {
      if (
        !used.has(key) ||
        typeof value !== "string" ||
        !value.trim() ||
        (typeof fallback[key] === "string" && placeholders(value) !== placeholders(fallback[key]))
      ) {
        findings.push(`src/locales/${file} Invalid or unused translation '${key}'. (i18n)`);
      }
    }
    for (const key of used) {
      if (!Object.hasOwn(catalog, key)) {
        findings.push(`src/locales/${file} Missing translation '${key}'. (i18n)`);
      }
    }
  }
  return findings;
}
