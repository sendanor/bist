import ts from "typescript";
import libraries from "cookbook:typescript-libraries";
import { resolveRecipePart, virtualFiles } from "./recipe-rules.js";

type RecipeSources = Partial<Record<keyof typeof virtualFiles, string>>;

const options: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  types: [],
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  allowJs: true,
  checkJs: true,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
};

const testLibraries = [
  "/cookbook-node-types/test.d.ts",
  "/cookbook-node-types/assert.d.ts",
  "/cookbook-node-types/assert/strict.d.ts",
];

const cachedLibraries = new Map<string, ts.SourceFile>();

const extensions: Readonly<Record<string, ts.Extension>> = {
  ".d.ts": ts.Extension.Dts,
  ".d.mts": ts.Extension.Dmts,
  ".d.cts": ts.Extension.Dcts,
  ".ts": ts.Extension.Ts,
  ".tsx": ts.Extension.Tsx,
  ".mts": ts.Extension.Mts,
  ".cts": ts.Extension.Cts,
  ".js": ts.Extension.Js,
  ".jsx": ts.Extension.Jsx,
  ".mjs": ts.Extension.Mjs,
  ".cjs": ts.Extension.Cjs,
};

/**
 * Map the chosen filename to the TypeScript compiler’s module extension.
 * @param filename The virtual path of the resolved recipe file.
 */
function recipeExtension(filename: string) {
  return extensions[filename.match(/(?:\.d)?\.[a-z]+$/u)?.[0] ?? ""] ?? ts.Extension.Ts;
}

/**
 * Check a recipe snapshot using only the pinned standard libraries and its submitted files.
 * @param sources The authored TypeScript parts supplied to the virtual compiler.
 * @param limit The diagnostic limit enforced for a single snapshot.
 * @param names Effective names of the submitted code parts.
 */
export function checkRecipeTypes(
  sources: RecipeSources,
  limit: number,
  names: Partial<Record<keyof typeof virtualFiles, string>> = {},
): string[] {
  const files = new Map<string, string>();
  const parsedFiles = new Map<string, ts.SourceFile>();
  for (const part of Object.keys(virtualFiles) as (keyof typeof virtualFiles)[]) {
    const text = sources[part];
    if (text !== undefined) {
      const name = "/recipe/" + (names[part] ?? virtualFiles[part]);
      files.set(name, text);
    }
  }

  /**
   * Read authored or pinned declarations without host filesystem access.
   * @param name The virtual filename requested by the compiler.
   */
  function readFile(name: string) {
    return files.get(name) ?? libraries[name];
  }

  const host: ts.CompilerHost = {
    /**
     * Find an authored or standard-library file in the virtual filesystem.
     * @param name The absolute virtual filename requested by the compiler.
     */
    getSourceFile(name) {
      const cache = files.has(name) ? parsedFiles : cachedLibraries;
      let file = cache.get(name);
      if (!file) {
        const text = readFile(name);
        if (text === undefined) {
          return undefined;
        }
        file = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true);
        cache.set(name, file);
      }
      return file;
    },
    /** Use the pinned ES2022 declaration file as the compiler default. */
    getDefaultLibFileName: () => "/lib.es2022.d.ts",
    /** Discard writes because recipe checking only reports diagnostics. */
    writeFile: () => {},
    /** Resolve all compiler paths relative to the virtual root. */
    getCurrentDirectory: () => "/",
    /**
     * Preserve filename spelling in the case-sensitive virtual filesystem.
     * @param name The virtual filename to use as a cache key.
     */
    getCanonicalFileName: (name) => name,
    /** Treat differently cased virtual filenames as distinct. */
    useCaseSensitiveFileNames: () => true,
    /** Use LF as the compiler's virtual newline. */
    getNewLine: () => "\n",
    /**
     * Check whether the virtual files include this path.
     * @param name The virtual filename to check for availability.
     */
    fileExists: (name) => files.has(name) || Object.hasOwn(libraries, name),
    readFile,
    /**
     * Resolve permitted imports against the recipe's virtual files and pinned declarations.
     * @param specifiers The import specifiers requested by the compiler.
     */
    resolveModuleNames(specifiers) {
      return specifiers.map((name) => {
        const part = resolveRecipePart(name, names);
        if (!part) {
          return undefined;
        }
        const path = "/recipe/" + (names[part] ?? virtualFiles[part]);
        return files.has(path)
          ? {
              resolvedFileName: path,
              extension: recipeExtension(path),
            }
          : undefined;
      });
    },
  };
  const roots = Array.from(files.keys());
  if (sources.tests !== undefined) {
    roots.push(...testLibraries);
  }
  const program = ts.createProgram(roots, { ...options, skipLibCheck: true }, host);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((entry) => entry.category === ts.DiagnosticCategory.Error);
  return diagnostics.slice(0, limit).map((entry) => {
    let location = "recipe";
    if (entry.file && entry.start !== undefined) {
      const part = Object.entries(virtualFiles).find(
        ([part, filename]) =>
          "/recipe/" + (names[part as keyof typeof virtualFiles] ?? filename) ===
          entry.file?.fileName,
      )?.[0];
      const { line, character } = entry.file.getLineAndCharacterOfPosition(entry.start);
      location = `${part ?? entry.file.fileName}:${line + 1}:${character + 1}`;
    }
    return `${location} ${ts.flattenDiagnosticMessageText(entry.messageText, " ")} (TS${entry.code})`;
  });
}
