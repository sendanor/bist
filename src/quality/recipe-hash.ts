import ts from "typescript";
import { generate, parse } from "css-tree";

const codeParts = ["source", "interface", "tests", "styles"] as const;

/** Fingerprints of the complete code snapshot and each of its code parts. */
export interface RecipeFingerprint {
  readonly snapshot: string | null;
  readonly units: Partial<Record<(typeof codeParts)[number], string>>;
  readonly documentation: string | null;
  readonly instructions: string | null;
}

/**
 * Canonicalize a TypeScript part before fingerprinting its code.
 * @param text The submitted code whose formatting should be ignored.
 */
function canonicalTypeScript(text: string) {
  let file = ts.createSourceFile("recipe.tsx", text, ts.ScriptTarget.Latest, true);
  if (
    "parseDiagnostics" in file &&
    Array.isArray(file.parseDiagnostics) &&
    file.parseDiagnostics.length
  ) {
    const script = ts.createSourceFile("recipe.ts", text, ts.ScriptTarget.Latest, true);
    if (
      "parseDiagnostics" in script &&
      Array.isArray(script.parseDiagnostics) &&
      !script.parseDiagnostics.length
    ) {
      file = script;
    }
  }
  const entries: (number | string)[] = [];
  /**
   * Visit syntax nodes to preserve tokens that affect code meaning.
   * @param node The TypeScript node at the current traversal position.
   */
  function visit(node: ts.Node) {
    if (ts.isJSDoc(node)) {
      return;
    }
    const children = node.getChildren(file);
    entries.push(node.kind);
    if (!children.length) {
      if (ts.isStringLiteral(node)) {
        // Escape spelling can be significant in directives such as "use strict".
        entries.push(node.getText(file).slice(1, -1));
      } else if (node.kind === ts.SyntaxKind.JsxText) {
        entries.push(node.getFullText(file));
      } else {
        entries.push(node.getText(file));
      }
    }
    for (const [index, child] of children.entries()) {
      const optionalPunctuation =
        (child.kind === ts.SyntaxKind.SemicolonToken &&
          node.kind !== ts.SyntaxKind.EmptyStatement) ||
        (child.kind === ts.SyntaxKind.CommaToken && node.kind === ts.SyntaxKind.SyntaxList);
      if (index === children.length - 1 && optionalPunctuation) {
        continue;
      }
      visit(child);
    }
    entries.push(-1);
  }
  visit(file);
  const directives = (ts.getLeadingCommentRanges(text, 0) ?? [])
    .map(({ pos, end }) => text.slice(pos, end))
    .filter((comment) =>
      /<reference\b|@(?:jsx(?:Frag|ImportSource|Runtime)?|ts-[\w-]+|checkJs|noCheck)\b/iu.test(
        comment,
      ),
    );
  return JSON.stringify([entries, directives]);
}

/**
 * Compute a hexadecimal SHA-256 digest from UTF-8 text.
 * @param value The normalized content to hash.
 */
async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash the parsed code so indentation and line wrapping do not affect identity.
 * @param files Validated TypeScript and CSS recipe parts, plus any accompanying prose.
 * @throws {Error} When a stylesheet cannot be parsed.
 */
export async function fingerprintRecipe(
  files: Readonly<Partial<Record<string, string>>>,
): Promise<RecipeFingerprint> {
  const units: RecipeFingerprint["units"] = {};
  for (const part of codeParts) {
    const text = files[part];
    if (text?.trim()) {
      const canonical = part === "styles" ? generate(parse(text)) : canonicalTypeScript(text);
      units[part] = await digest(JSON.stringify(["bist-unit-v1", part, canonical]));
    }
  }
  const snapshot = Object.keys(units).length
    ? await digest(JSON.stringify(["bist-snapshot-v1", units]))
    : null;
  /**
   * Fingerprint a prose part if it contains nonblank text.
   * @param text The optional Markdown text from the recipe snapshot.
   */
  async function prose(text: string | undefined) {
    return text?.trim()
      ? digest(JSON.stringify(["bist-prose-v1", text.replace(/\r\n?/g, "\n").trimEnd()]))
      : null;
  }
  return {
    snapshot,
    units,
    documentation: await prose(files.documentation),
    instructions: await prose(files.instructions),
  };
}
