import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coversSource, instrument } from "./coverage-instrument.mjs";

registerHooks({
  /**
   * Instrument project sources while Node loads the regular unit tests.
   * @param url Node's resolved module URL.
   * @param context Loader options provided by Node.
   * @param nextLoad The normal Node loader.
   */
  load(url, context, nextLoad) {
    if (url.startsWith("file:")) {
      const path = fileURLToPath(url);
      if (coversSource(path)) {
        const source = instrument(path, readFileSync(path, "utf8")).code;
        return { source, format: "module", shortCircuit: true };
      }
    }
    return nextLoad(url, context);
  },
});

process.on("exit", () => {
  if (globalThis.__coverage__) {
    writeFileSync(
      join(process.env.BIST_TEST_COVERAGE, "unit-" + process.pid + ".json"),
      JSON.stringify(globalThis.__coverage__),
    );
  }
});
