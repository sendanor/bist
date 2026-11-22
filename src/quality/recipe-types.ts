import ts from "typescript";
import libraries from "cookbook:typescript-libraries";
import { resolveRecipePart, virtualFiles } from "./recipe-rules.js";

/** One authored code part and its validated filename in a recipe. */
export interface RecipeTypeFile {
  readonly part: keyof typeof virtualFiles;
  readonly name: string;
  readonly content: string;
}

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
const pinnedFiles = new Map(
  Object.entries(libraries).map(([name, content]) => [name, { label: name, content }]),
);

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
 * @param filename The resolved recipe filename, validated against the supported suffixes.
 */
function recipeExtension(filename: string) {
  const [suffix] = filename.match(/(?:\.d\.[cm]?ts|\.[cm]?[jt]s|\.[jt]sx)$/u)!;
  return extensions[suffix];
}

/**
 * Check a recipe snapshot using only the pinned standard libraries and its submitted files.
 * @param sources The authored code parts and their effective filenames.
 * @param limit The diagnostic limit enforced for a single snapshot.
 */
export function checkRecipeTypes(sources: readonly RecipeTypeFile[], limit: number): string[] {
  const files = new Map(
    sources.map(({ name, part, content }) => ["/recipe/" + name, { label: part, content }]),
  );
  const names = Object.fromEntries(sources.map(({ part, name }) => [part, name]));
  const parsedFiles = new Map<string, ts.SourceFile>();

  /**
   * Find a virtual file with the label used in recipe diagnostics.
   * @param name The absolute path of a submitted file or a pinned declaration.
   */
  function virtualFile(name: string) {
    return files.get(name) ?? pinnedFiles.get(name);
  }

  /**
   * Read authored or pinned declarations without host filesystem access.
   * @param name The virtual filename requested by the compiler.
   */
  function readFile(name: string) {
    return virtualFile(name)?.content;
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
    // Function.prototype is a no-op. The virtual host never writes compiler output.
    writeFile: Function.prototype as ts.WriteFileCallback,
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
    fileExists: (name) => files.has(name) || pinnedFiles.has(name),
    readFile,
    /**
     * Resolve permitted imports against the recipe's virtual files and pinned declarations.
     * @param specifiers The import specifiers requested by the compiler.
     */
    resolveModuleNames(specifiers) {
      return specifiers.map((name) => {
        const part = resolveRecipePart(name, names);
        const filename = part && names[part];
        if (!filename) {
          return undefined;
        }
        return {
          resolvedFileName: "/recipe/" + filename,
          extension: recipeExtension(filename),
        };
      });
    },
  };
  const roots = Array.from(files.keys());
  if (names.tests !== undefined) {
    roots.push(...testLibraries);
  }
  const program = ts.createProgram(roots, { ...options, skipLibCheck: true }, host);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((entry) => entry.category === ts.DiagnosticCategory.Error);
  return diagnostics.slice(0, limit).map((entry) => {
    let location = "recipe";
    if (entry.file && entry.start !== undefined) {
      const { label } = virtualFile(entry.file.fileName)!;
      const { line, character } = entry.file.getLineAndCharacterOfPosition(entry.start);
      location = `${label}:${line + 1}:${character + 1}`;
    }
    const detail = ts.flattenDiagnosticMessageText(entry.messageText, host.getNewLine());
    return `${location} ${detail} (TS${entry.code})`;
  });
}
