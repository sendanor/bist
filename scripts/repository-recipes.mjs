import { readFile } from "node:fs/promises";
import ts from "typescript";
import { secretKinds } from "./secret-patterns.mjs";

const definitions = {
  "bounded-line-diff": { module: "line-diff", bundledGuard: false },
  "bounded-json-object-reader": { module: "read-json-object", bundledGuard: true },
};

/**
 * Assemble a trusted recipe snapshot from source and test files in this checkout.
 * @param slug The recipe slug identifying the repository fixture.
 */
export async function repositoryRecipe(slug) {
  const { module, bundledGuard } = definitions[slug];
  let source = await readFile(`src/${module}.ts`, "utf8");
  const tests = await readFile(`tests/${module}.test.ts`, "utf8");
  const originalImport = JSON.stringify(`../src/${module}.ts`);
  if (!tests.includes(originalImport)) {
    throw new Error(`Expected repository module import in ${module} tests.`);
  }

  if (bundledGuard) {
    const original = 'import { isRecord } from "./guards.ts";';
    const guards = ts.createSourceFile(
      "guards.ts",
      await readFile("src/guards.ts", "utf8"),
      ts.ScriptTarget.ES2022,
    );
    const guard = guards.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "isRecord",
    );
    if (!source.includes(original) || !guard?.body) {
      throw new Error("Expected the shared isRecord guard in the JSON reader.");
    }
    const declaration = guard.getText(guards);
    const documentation = guards.text.slice(guard.getFullStart(), guard.getStart(guards)).trim();
    source = source.replace(original, documentation + "\n" + declaration.replace(/^export /u, ""));
  }

  const snapshot = { source, tests: tests.replace(originalImport, '"./source.ts"') };
  if (Object.values(snapshot).some((value) => secretKinds(value).length)) {
    throw new Error(`Possible credential in repository recipe ${slug}. Value omitted.`);
  }
  return snapshot;
}
