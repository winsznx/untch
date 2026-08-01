import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGitCommand, endangered } from "../lint/git-destructive";

const split = (s: string): readonly string[] => s.split(" ").filter((x) => x !== "");

test("reset --hard is refused in every spelling that reaches the same outcome", () => {
  for (const cmd of [
    "git reset --hard",
    "reset --hard origin/main",
    "git reset --hard=HEAD~1",
    "git -C /Users/mac/untch reset --hard origin/main",
    "git reset --mixed --hard",
  ]) {
    const v = classifyGitCommand(split(cmd));
    assert.equal(v.destructive, true, cmd);
    assert.equal(v.kind, "reset-hard", cmd);
  }
});

test("a reset that refuses rather than overwrites is not this guard's business", () => {
  for (const cmd of ["git reset --soft HEAD~1", "git reset --merge", "git reset --keep origin/main", "git reset"]) {
    assert.equal(classifyGitCommand(split(cmd)).destructive, false, cmd);
  }
});

test("clean is refused whenever force is on, including inside a short-flag cluster", () => {
  for (const cmd of ["git clean -fd", "git clean -f", "git clean --force", "git clean -xdf", "git clean -dfx"]) {
    const v = classifyGitCommand(split(cmd));
    assert.equal(v.destructive, true, cmd);
    assert.equal(v.kind, "clean-force", cmd);
  }
  // A dry run deletes nothing, so refusing it would be noise.
  assert.equal(classifyGitCommand(split("git clean -nd")).destructive, false);
});

test("clean -x names ignored files in its outcome, because .env is the file that hurts", () => {
  assert.match(classifyGitCommand(split("git clean -fdx")).outcome, /ignored files such as \.env/);
});

test("restore defaults to the working tree; --staged alone touches only the index", () => {
  const worktree = classifyGitCommand(split("git restore packages/consumer-core/src/db.ts"));
  assert.equal(worktree.destructive, true);
  assert.deepEqual(worktree.paths, ["packages/consumer-core/src/db.ts"]);

  assert.equal(classifyGitCommand(split("git restore --staged package.json")).destructive, false);
  assert.equal(classifyGitCommand(split("git restore --worktree --staged package.json")).destructive, true);
});

test("checkout -- <path> is restore under its older name", () => {
  const v = classifyGitCommand(split("git checkout -- package.json"));
  assert.equal(v.destructive, true);
  assert.equal(v.kind, "checkout-overwrite");
  assert.deepEqual(v.paths, ["package.json"]);
});

test("a plain branch checkout refuses on its own; only --force removes that refusal", () => {
  assert.equal(classifyGitCommand(split("git checkout main")).destructive, false);
  assert.equal(classifyGitCommand(split("git switch main")).destructive, false);
  assert.equal(classifyGitCommand(split("git checkout -f main")).destructive, true);
  assert.equal(classifyGitCommand(split("git switch --discard-changes main")).destructive, true);
});

test("a whole-tree command endangers every protected path; a scoped one endangers only what it names", () => {
  const protectedPaths = [".gitignore", "package.json", "scripts/SUBMIT-OKX-GENESIS.md"];

  const whole = classifyGitCommand(split("git reset --hard origin/main"));
  assert.deepEqual(endangered(whole, protectedPaths), protectedPaths);

  const scoped = classifyGitCommand(split("git restore package.json"));
  assert.deepEqual(endangered(scoped, protectedPaths), ["package.json"]);

  // A named directory reaches the files beneath it — the case a path-equality check would miss.
  const dir = classifyGitCommand(split("git restore scripts"));
  assert.deepEqual(endangered(dir, protectedPaths), ["scripts/SUBMIT-OKX-GENESIS.md"]);
});

test("a non-destructive command endangers nothing even when protected paths exist", () => {
  const v = classifyGitCommand(split("git status"));
  assert.deepEqual(endangered(v, ["package.json"]), []);
});
