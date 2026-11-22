import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import istanbul from "istanbul-lib-coverage";
import sourceMaps from "istanbul-lib-source-maps";
import { coversSource, instrument } from "./coverage-instrument.mjs";

const directory = await mkdtemp(join(tmpdir(), "bist-coverage-"));
const check = process.argv.includes("--check");

/**
 * Run a test step with counters collected into this run's isolated directory.
 * @param args Node options and the script or test entry point.
 * @throws {Error} If the child cannot run or exits unsuccessfully.
 */
function run(...args) {
  const { status, error } = spawnSync(process.execPath, args, {
    env: { ...process.env, BIST_TEST_COVERAGE: directory },
    stdio: "inherit",
  });
  if (status !== 0) {
    throw error ?? new Error("Coverage step failed: " + args.join(" "));
  }
}

try {
  run("--import", "./scripts/coverage-unit.mjs", "--test", "tests/*.test.*");
  run("scripts/build.mjs", directory);
  run("scripts/smoke.mjs");

  const map = istanbul.createCoverageMap({});
  const files = await readdir("src", { recursive: true });
  for (const file of files.sort()) {
    const path = resolve("src", file);
    if (coversSource(path)) {
      map.addFileCoverage(instrument(path, await readFile(path, "utf8")).counts);
    }
  }
  for (const name of (await readdir(directory)).sort()) {
    if (name.endsWith(".json")) {
      map.merge(JSON.parse(await readFile(join(directory, name), "utf8")));
    }
  }
  const mapped = await sourceMaps.createSourceMapStore().transformCoverage(map);
  console.table(
    Object.fromEntries(
      mapped
        .files()
        .map((file) => [
          relative(".", resolve(file)),
          percentages(mapped.fileCoverageFor(file).toSummary()),
        ]),
    ),
  );
  const summary = mapped.getCoverageSummary();
  console.log("Bist coverage", percentages(summary));
  const output = resolve("coverage");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "coverage-final.json"), JSON.stringify(mapped));
  if (
    check &&
    ["lines", "branches", "functions"].some((key) => summary[key].covered !== summary[key].total)
  ) {
    console.error("Bist requires 100% line, branch and function coverage.");
    process.exitCode = 1;
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

/**
 * Format the requested measurements without changing the counts used for the gate.
 * @param summary Istanbul coverage totals for a file or the complete project.
 */
function percentages(summary) {
  return {
    lines: summary.lines.pct,
    branches: summary.branches.pct,
    functions: summary.functions.pct,
  };
}
