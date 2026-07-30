import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDrift, parseImporters, parseOverrides, parseWorkspaceGlobs } from "../lint/lockfile-sync";

/**
 * The regression suite for the deployment that failed on 2026-07-29.
 *
 * The first test in "the exact production failure" is the one that matters: it reconstructs the tree
 * that was uploaded to Railway, a committed lockfile plus a root manifest carrying one extra local
 * dependency, and asserts that this is reported as blocking. Had that assertion existed, the drift
 * would have been caught locally instead of by a remote builder, and spending authority would not have
 * been granted against code that was never running.
 *
 * The parser tests exist because the checker reads a narrow slice of a generated file. If pnpm changes
 * that shape, these fail loudly. Without them the parser could quietly stop finding anything and the
 * suite would still pass, which is the one failure mode a linter must never have.
 */

/** A throwaway workspace on disk. The checker reads real files, so the fixtures are real files. */
function scratchRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "untch-lockfile-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const WORKSPACE = `packages:\n  - "packages/*"\n`;

describe("lockfile sync — the exact production failure", () => {
  test("a root dependency the committed lockfile has never seen is blocking", () => {
    // #given the tree that was actually uploaded: a lockfile with no @babel/parser, and a root
    // manifest that has one because of uncommitted local work
    const repo = scratchRepo({
      "package.json": JSON.stringify({
        name: "untch",
        devDependencies: { tsx: "^4.19.2", "@babel/parser": "7.24.1" },
      }),
      "pnpm-workspace.yaml": WORKSPACE,
      "pnpm-lock.yaml": [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    devDependencies:",
        "      tsx:",
        "        specifier: ^4.19.2",
        "        version: 4.23.0",
        "",
        "packages: {}",
        "",
      ].join("\n"),
    });

    try {
      // #when the tree is checked
      const drift = findDrift(repo.root);

      // #then the missing dependency is reported, and reported as blocking
      const blocking = drift.filter((d) => d.severity === "blocking");
      assert.equal(blocking.length, 1, JSON.stringify(drift, null, 2));
      assert.equal(blocking[0]?.name, "@babel/parser");
      assert.equal(blocking[0]?.kind, "missing-from-lockfile");
      assert.equal(blocking[0]?.importer, ".");
      assert.equal(blocking[0]?.group, "devDependencies");
    } finally {
      repo.cleanup();
    }
  });

  test("a manifest that matches the lockfile is clean", () => {
    const repo = scratchRepo({
      "package.json": JSON.stringify({ name: "untch", devDependencies: { tsx: "^4.19.2" } }),
      "pnpm-workspace.yaml": WORKSPACE,
      "pnpm-lock.yaml": [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    devDependencies:",
        "      tsx:",
        "        specifier: ^4.19.2",
        "        version: 4.23.0",
        "",
      ].join("\n"),
    });

    try {
      assert.deepEqual(findDrift(repo.root), []);
    } finally {
      repo.cleanup();
    }
  });

  test("a changed version range is blocking", () => {
    const repo = scratchRepo({
      "package.json": JSON.stringify({ name: "untch", dependencies: { viem: "^2.60.0" } }),
      "pnpm-workspace.yaml": WORKSPACE,
      "pnpm-lock.yaml": [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      viem:",
        "        specifier: ^2.55.0",
        "        version: 2.55.0",
        "",
      ].join("\n"),
    });

    try {
      const drift = findDrift(repo.root);
      assert.equal(drift.length, 1);
      assert.equal(drift[0]?.kind, "specifier-changed");
      assert.equal(drift[0]?.severity, "blocking");
    } finally {
      repo.cleanup();
    }
  });

  test("a dependency dropped from the manifest but left in the lockfile is blocking", () => {
    const repo = scratchRepo({
      "package.json": JSON.stringify({ name: "untch", dependencies: {} }),
      "pnpm-workspace.yaml": WORKSPACE,
      "pnpm-lock.yaml": [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      viem:",
        "        specifier: ^2.55.0",
        "        version: 2.55.0",
        "",
      ].join("\n"),
    });

    try {
      const drift = findDrift(repo.root);
      assert.equal(drift.length, 1);
      assert.equal(drift[0]?.kind, "missing-from-manifest");
      assert.equal(drift[0]?.severity, "blocking");
    } finally {
      repo.cleanup();
    }
  });
});

describe("lockfile sync — overrides", () => {
  test("an overridden specifier is not reported as drift", () => {
    // #given ioredis pinned by a root override, which is the real shape of this repository
    const repo = scratchRepo({
      "package.json": JSON.stringify({
        name: "untch",
        pnpm: { overrides: { ioredis: "5.10.1" } },
      }),
      "pnpm-workspace.yaml": WORKSPACE,
      "packages/escalation/package.json": JSON.stringify({
        name: "@untch/escalation",
        dependencies: { ioredis: "^5.4.2" },
      }),
      "pnpm-lock.yaml": [
        "lockfileVersion: '9.0'",
        "",
        "overrides:",
        "  ioredis: 5.10.1",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies: {}",
        "",
        "  packages/escalation:",
        "    dependencies:",
        "      ioredis:",
        "        specifier: 5.10.1",
        "        version: 5.10.1",
        "",
      ].join("\n"),
    });

    try {
      // #then the manifest asking for ^5.4.2 against a recorded 5.10.1 is correct, not drift
      assert.deepEqual(findDrift(repo.root), []);
    } finally {
      repo.cleanup();
    }
  });

  test("an override present in the manifest but not the lockfile is blocking", () => {
    const repo = scratchRepo({
      "package.json": JSON.stringify({ name: "untch", pnpm: { overrides: { ioredis: "5.10.1" } } }),
      "pnpm-workspace.yaml": WORKSPACE,
      "pnpm-lock.yaml": ["lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    dependencies: {}", ""].join("\n"),
    });

    try {
      const drift = findDrift(repo.root);
      assert.equal(drift.length, 1);
      assert.equal(drift[0]?.importer, "(overrides)");
      assert.equal(drift[0]?.severity, "blocking");
    } finally {
      repo.cleanup();
    }
  });
});

describe("lockfile sync — a lockfile importer whose directory is gone", () => {
  test("is advisory, because a frozen install prunes it rather than failing", () => {
    // #given the real condition in this repository: apps/launch-film is gitignored, so it is absent
    // from every clean checkout while the committed lockfile still records it
    const repo = scratchRepo({
      "package.json": JSON.stringify({ name: "untch" }),
      "pnpm-workspace.yaml": WORKSPACE,
      "pnpm-lock.yaml": [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies: {}",
        "",
        "  apps/launch-film:",
        "    dependencies:",
        "      remotion:",
        "        specifier: ^4.0.0",
        "        version: 4.0.0",
        "",
      ].join("\n"),
    });

    try {
      const drift = findDrift(repo.root);
      assert.equal(drift.length, 1);
      assert.equal(drift[0]?.importer, "apps/launch-film");
      // #then it is surfaced but does not stop a deploy, which was confirmed against a real
      // `pnpm install --frozen-lockfile` on a clean export of the deployed commit
      assert.equal(drift[0]?.severity, "advisory");
    } finally {
      repo.cleanup();
    }
  });
});

describe("lockfile sync — parser shape", () => {
  test("scoped names are unquoted and specifiers keep their colons", () => {
    const importers = parseImporters(
      [
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      '@untch/canon':",
        "        specifier: workspace:*",
        "        version: link:../canon",
        "      '@types/node':",
        "        specifier: ^24.0.0",
        "        version: 24.13.3",
        "",
        "packages:",
        "  someversion:",
        "    resolution: {integrity: sha512-x}",
        "",
      ].join("\n"),
    );

    const root = importers.get(".");
    assert.ok(root);
    // A specifier containing a colon must survive intact, or every workspace dependency would
    // compare unequal and the checker would report drift everywhere.
    assert.equal(root.dependencies.get("@untch/canon"), "workspace:*");
    assert.equal(root.dependencies.get("@types/node"), "^24.0.0");
  });

  test("the version line never overwrites the specifier", () => {
    const importers = parseImporters(
      ["importers:", "", "  .:", "    dependencies:", "      viem:", "        specifier: ^2.55.0", "        version: 2.55.0(typescript@5.9.3)", ""].join("\n"),
    );
    assert.equal(importers.get(".")?.dependencies.get("viem"), "^2.55.0");
  });

  test("the block ends at the next top-level key", () => {
    const importers = parseImporters(
      ["importers:", "", "  .:", "    dependencies: {}", "", "snapshots:", "  viem@2.55.0:", "    dependencies:", "      abitype:", "        specifier: nonsense", ""].join("\n"),
    );
    assert.deepEqual([...importers.keys()], ["."]);
  });

  test("overrides are read from the top-level block only", () => {
    const overrides = parseOverrides(
      ["overrides:", "  ioredis: 5.10.1", "  postcss: ^8.5.16", "", "importers:", "  .:", "    dependencies: {}", ""].join("\n"),
    );
    assert.equal(overrides.get("ioredis"), "5.10.1");
    assert.equal(overrides.get("postcss"), "^8.5.16");
    assert.equal(overrides.size, 2);
  });

  test("workspace exclusions are honoured", () => {
    const globs = parseWorkspaceGlobs(
      ["packages:", '  - "packages/*"', '  - "apps/*"', '  - "!apps/video"', ""].join("\n"),
    );
    assert.deepEqual(globs.include, ["packages/*", "apps/*"]);
    assert.deepEqual(globs.exclude, ["apps/video"]);
  });
});

/**
 * There is deliberately NO test here that runs findDrift against the working tree.
 *
 * It would be testing the machine rather than the code. A developer with uncommitted scratch work in
 * a gitignored directory would see a red suite for a reason that has nothing to do with their change,
 * and a suite that is red for irrelevant reasons is a suite people stop reading.
 *
 * The tree itself is checked where the answer is meaningful: `pnpm lint:lockfile` runs as a CI step
 * against a clean checkout, which is exactly the tree the Railway builder sees, and again as a hard
 * gate inside `pnpm deploy:asp` against the artefact actually being uploaded.
 */
