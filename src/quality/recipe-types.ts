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
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
};

const testLibraries = [
  "/cookbook-node-types/test.d.ts",
  "/cookbook-node-types/assert.d.ts",
  "/cookbook-node-types/assert/strict.d.ts",
];

let cachedLibraries: Map<string, ts.SourceFile>;

/** Load the pinned declaration library texts for the virtual compiler. */
function loadLibraries() {
  cachedLibraries ??= new Map();
  return cachedLibraries;
}

/**
 * Check a recipe snapshot using only the pinned standard libraries and its submitted files.
 * @param sources The authored TypeScript parts supplied to the virtual compiler.
 * @param limit The diagnostic limit enforced for a single snapshot.
 */
export function checkRecipeTypes(sources: RecipeSources, limit: number): string[] {
  const files = new Map<string, ts.SourceFile>();
  for (const part of Object.keys(virtualFiles) as (keyof typeof virtualFiles)[]) {
    const text = sources[part];
    if (text !== undefined) {
      const name = "/" + virtualFiles[part];
      files.set(name, ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true));
    }
  }

  const host: ts.CompilerHost = {
    /**
     * Find an authored or standard-library file in the virtual filesystem.
     * @param name The absolute virtual filename requested by the compiler.
     */
    getSourceFile(name) {
      const text = libraries[name];
      if (text === undefined) {
        return files.get(name);
      }
      const cache = loadLibraries();
      let file = cache.get(name);
      if (!file) {
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
    /**
     * Read authored or pinned declarations without host filesystem access.
     * @param name The virtual filename requested by the compiler.
     */
    readFile: (name) => files.get(name)?.text ?? libraries[name],
    /**
     * Resolve permitted imports against the recipe's virtual files and pinned declarations.
     * @param names The import specifiers requested by the compiler.
     */
    resolveModuleNames(names) {
      return names.map((name) => {
        const part = resolveRecipePart(name);
        if (!part) {
          return undefined;
        }
        const path = "/" + virtualFiles[part];
        return files.has(path)
          ? {
              resolvedFileName: path,
              extension: part === "interface" ? ts.Extension.Dts : ts.Extension.Tsx,
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
        ([, filename]) => "/" + filename === entry.file?.fileName,
      )?.[0];
      const { line, character } = entry.file.getLineAndCharacterOfPosition(entry.start);
      location = `${part ?? entry.file.fileName}:${line + 1}:${character + 1}`;
    }
    return `${location} ${ts.flattenDiagnosticMessageText(entry.messageText, " ")} (TS${entry.code})`;
  });
}
