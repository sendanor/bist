import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { basename, relative, resolve } from "node:path";
import istanbul from "istanbul-lib-instrument";

const root = resolve("src");
const globals = {
  esModules: true,
  coverageGlobalScope: "globalThis",
  coverageGlobalScopeFunc: false,
};

/**
 * Identify an executable project source file in any test runtime.
 * @param filename Absolute filename to check.
 */
export function coversSource(filename) {
  const path = relative(root, filename);
  return path !== "" && !path.startsWith("..") && /\.[jt]s$/u.test(path) && !path.endsWith(".d.ts");
}

/**
 * Preserve source coordinates for erasable types and map emitted TypeScript syntax.
 * @param filename Original source filename for the source map.
 * @param source JavaScript or TypeScript to instrument.
 */
function executableSource(filename, source) {
  if (filename.endsWith(".ts")) {
    try {
      return { script: stripTypeScriptTypes(source) };
    } catch (error) {
      if (error.code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
        throw error;
      }
    }
    const output = stripTypeScriptTypes(source, {
      mode: "transform",
      sourceMap: true,
      sourceUrl: basename(filename),
    });
    const marker = "//# sourceMappingURL=data:application/json;base64,";
    const index = output.lastIndexOf(marker);
    const map = JSON.parse(Buffer.from(output.slice(index + marker.length), "base64").toString());
    return { script: output.slice(0, index), map };
  }
  return { script: source };
}

/**
 * Give every runtime the same source locations and coverage counters.
 * @param filename Absolute project source filename.
 * @param source Original JavaScript or erasable TypeScript source.
 */
export function instrument(filename, source) {
  const instrumenter = istanbul.createInstrumenter(globals);
  const { script, map } = executableSource(filename, source);
  const code = instrumenter.instrumentSync(script, "src/" + relative(root, filename), map);
  return { code, counts: instrumenter.lastFileCoverage() };
}

export const coveragePlugin = {
  name: "bist-test-coverage",
  /**
   * Instrument own code before bundling it with uninstrumented dependencies.
   * @param builder Esbuild plugin context for the test-only bundle.
   */
  setup(builder) {
    builder.onLoad({ filter: /\.[jt]s$/ }, async ({ path }) => {
      if (coversSource(path)) {
        return { loader: "js", contents: instrument(path, await readFile(path, "utf8")).code };
      }
    });
  },
};
