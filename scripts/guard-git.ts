/**
 * `pnpm guard:git -- <git args>` — refuse a destructive git operation while protected work exists.
 *
 *   pnpm guard:git -- reset --hard origin/main
 *   pnpm guard:git -- clean -fd
 *   pnpm guard:git -- restore packages/consumer-core/src/db.ts
 *
 * Exit 0 means "this command destroys nothing that only the working tree holds" — it does NOT run the
 * command. Exit 2 is a refusal, and names what would be lost.
 *
 * WHAT PROTECTED MEANS, PER COMMAND
 *
 * `reset --hard` leaves untracked files alone, so listing them as at-risk would produce refusals for
 * files that were never in danger and teach the reader to ignore the output. `clean -f` is the
 * opposite: untracked files are the ONLY thing it deletes, and they are the files with no object in
 * the store to recover from. So the protected set is derived from the verdict rather than being one
 * fixed list, and each command is judged against what it can actually reach.
 *
 * THE LIMIT, STATED PLAINLY
 *
 * This intercepts nothing. `git reset --hard` typed at a prompt does not pass through here, and this
 * file has no way to make it. It is a step a script can take before doing something destructive, and a
 * precondition a workflow can require. Claiming more than that would be the more dangerous error: an
 * operator who believes the shell is guarded stops being careful in the one place the guard is absent.
 */

export {};

import { execFileSync } from "node:child_process";
import { classifyGitCommand, endangered } from "./lint/git-destructive";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const command = sep === -1 ? argv : argv.slice(sep + 1);

if (command.length === 0) {
  console.error(
    "usage: pnpm guard:git -- <git args>\n\n" +
      "  Judges the command and exits non-zero if it would destroy uncommitted work.\n" +
      "  It never runs the command.",
  );
  process.exit(64);
}

function git(...a: readonly string[]): string {
  return execFileSync("git", [...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

/** Tracked paths differing from HEAD, staged or not. What `reset --hard` and `restore` would overwrite. */
function dirtyTracked(): readonly string[] {
  const out = git("status", "--porcelain=v1", "--untracked-files=no");
  if (out === "") return [];
  return out
    .split("\n")
    .map((line) => line.slice(3).trim())
    .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] ?? p : p))
    .filter((p) => p !== "");
}

/** Untracked, non-ignored paths. What `clean -f` would delete, and what has no object to recover from. */
function untracked(): readonly string[] {
  const out = git("ls-files", "--others", "--exclude-standard");
  return out === "" ? [] : out.split("\n").filter((p) => p !== "");
}

const verdict = classifyGitCommand(command);

if (!verdict.destructive) {
  console.log(
    `\x1b[32m✓\x1b[0m \`git ${command.join(" ")}\` is not a working-tree-destroying operation.\n` +
      "  (This guard judged the command. It did not run it, and it does not intercept the shell.)",
  );
  process.exit(0);
}

// `clean` is the one command whose damage is entirely to untracked files; every other rule here
// overwrites tracked ones. Judging both sets for every command would name files that were never at risk.
const atRisk = verdict.kind === "clean-force" ? untracked() : dirtyTracked();
const lost = endangered(verdict, atRisk);

if (lost.length === 0) {
  console.log(
    `\x1b[33m!\x1b[0m \`git ${command.join(" ")}\` is destructive, but there is nothing here for it to destroy.\n` +
      `  It ${verdict.outcome}\n` +
      "  No protected path is in its reach right now.",
  );
  process.exit(0);
}

console.error(`\n\x1b[31mREFUSED\x1b[0m  git ${command.join(" ")}\n`);
console.error(`  It ${verdict.outcome}\n`);
console.error(`  ${lost.length} protected path(s) are in its reach:\n`);
for (const p of lost) console.error(`    ${p}`);
if (verdict.alternative) console.error(`\n  Non-destructive alternative:\n    ${verdict.alternative}`);
console.error(
  "\n  If a listed path really is disposable, commit it, stash it, or copy it out first — then the\n" +
    "  guard has nothing to refuse over and the refusal was the cheap part.\n",
);
process.exit(2);
