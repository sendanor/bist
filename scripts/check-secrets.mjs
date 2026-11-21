import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { secretKinds } from "./secret-patterns.mjs";

const run = promisify(execFile);

/**
 * Run a Git inspection command in the project repository.
 * @param args The Git subcommand and its ordered arguments.
 */
async function git(...args) {
  try {
    const { stdout } = await run("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    throw new Error(`Git ${args[0]} failed while checking for credentials.`);
  }
}

/**
 * Read the NUL-delimited list of paths selected by Git.
 * @param args The Git command arguments that select candidate paths.
 */
async function candidatePaths(...args) {
  return (await git(...args)).split("\0").filter(Boolean);
}

/**
 * Record secret findings without exposing matched values.
 * @param path The path to cite in a finding.
 * @param source The source label identifying where the contents came from.
 * @param text The full file contents to scan.
 */
function check(path, source, text) {
  const name = basename(path);
  const kinds = secretKinds(text);
  if (
    (/^\.env(?:\.|$)/u.test(name) && !/\.example$/u.test(name)) ||
    /^(?:id_(?:rsa|ed25519|ecdsa)|credentials\.json)$|\.(?:p12|pfx|key)$/iu.test(name)
  ) {
    kinds.push("local credential file");
  }
  for (const kind of kinds) {
    console.error(`${path} (${source}): possible ${kind}. Value omitted.`);
    process.exitCode = 1;
  }
}

const worktree = await candidatePaths(
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
);
for (const path of [...new Set(worktree)].sort()) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (info?.isFile()) {
    check(path, "working tree", await readFile(path, "utf8"));
  }
}
for (const path of await candidatePaths(
  "diff",
  "--cached",
  "--diff-filter=ACMR",
  "--name-only",
  "-z",
)) {
  check(path, "Git index", await git("show", ":" + path));
}

if (process.argv.includes("--history")) {
  const checked = new Set();
  for (const ref of (await git("rev-list", "--all")).trim().split("\n").filter(Boolean)) {
    for (const entry of await candidatePaths("ls-tree", "-rz", ref)) {
      const tab = entry.indexOf("\t");
      const [, type, id] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      const identity = JSON.stringify([id, path]);
      if (type === "blob" && !checked.has(identity)) {
        check(path, "local history " + ref.slice(0, 12), await git("cat-file", "blob", id));
        checked.add(identity);
      }
    }
  }
}
