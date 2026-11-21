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

let cachedLibraries: Map<string, ts.SourceFile>;

function loadLibraries() {
  cachedLibraries ??= new Map();
  return cachedLibraries;
}

/** Check a recipe snapshot using only the pinned standard libraries and its submitted files. */
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
    getDefaultLibFileName: () => "/lib.es2022.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => files.has(name) || Object.hasOwn(libraries, name),
    readFile: (name) => files.get(name)?.text ?? libraries[name],
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
  const program = ts.createProgram([...files.keys()], { ...options, skipLibCheck: true }, host);
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
