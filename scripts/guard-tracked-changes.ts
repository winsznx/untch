/**
 * Refuse a destructive git operation while uncommitted tracked changes exist.
 *
 *   pnpm guard:tracked                 # report, exit non-zero if anything would be destroyed
 *   pnpm guard:tracked --allow <path>  # ignore one path that is known to be disposable
 *
 * WHY THIS EXISTS
 *
 * On 2026-07-30 a `git reset --hard origin/main`, run to move onto a freshly merged main, discarded the
 * uncommitted modifications to six tracked files that had nothing to do with the branch. They were
 * recovered — every one of them had been staged at some point, so the blobs were still in the object
 * store and a full scan found them by content hash. That recovery was luck, not design. A file modified
 * in the working tree and never staged leaves no object at all, and `reset --hard` would have destroyed
 * it with nothing to find.
 *
 * The lesson is narrow: a command whose entire purpose is to discard local state should not be reached
 * for as a way to change branches. `git switch`, `git checkout` and `git merge --ff-only` all move a ref
 * and all refuse rather than overwrite. This guard exists so the refusal is available as a step in a
 * script, where the discipline can be enforced instead of remembered.
 *
 * It reads. It never writes, never stages and never resets anything.
 */

export {};

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const allowed = new Set<string>();
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--allow" && i + 1 < args.length) allowed.add(String(args[i + 1]));
}

function git(...a: readonly string[]): string {
  return execFileSync("git", [...a], { encoding: "utf8" }).trimEnd();
}

/**
 * Tracked paths that differ from HEAD, whether staged or not.
 *
 * Untracked files are deliberately NOT included: `reset --hard` leaves them alone, so listing them would
 * produce refusals for files that were never at risk and train whoever reads the output to ignore it.
 */
function dirtyTrackedPaths(): readonly string[] {
  const porcelain = git("status", "--porcelain=v1", "--untracked-files=no");
  if (porcelain === "") return [];
  return porcelain
    .split("\n")
    .map((line) => line.slice(3).trim())
    // A rename reads as "old -> new"; the new path is the one on disk.
    .map((path) => (path.includes(" -> ") ? path.split(" -> ")[1] ?? path : path))
    .filter((path) => path !== "" && !allowed.has(path));
}

const dirty = dirtyTrackedPaths();

if (dirty.length === 0) {
  console.log("\x1b[32m✓\x1b[0m no uncommitted tracked changes — a destructive reset would discard nothing");
  process.exit(0);
}

console.error(`\n\x1b[31mREFUSED\x1b[0m ${dirty.length} tracked file(s) have uncommitted changes:\n`);
for (const path of dirty) console.error(`  ${path}`);
console.error(
  "\n  A destructive reset would discard these. A file that has never been staged leaves no object\n" +
    "  behind, so there would be nothing to recover from.\n\n" +
    "  To move onto a new commit without discarding anything:\n" +
    "    git fetch origin && git switch -c <branch> origin/main\n" +
    "    git switch main && git merge --ff-only origin/main\n\n" +
    "  Both refuse rather than overwrite. If a listed path really is disposable, name it:\n" +
    `    pnpm guard:tracked ${dirty.map((p) => `--allow ${p}`).join(" ")}`,
);
process.exit(2);
