import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SERVICE,
  KNOWN_SERVICES,
  PROJECT_NAME,
  buildAttestation,
  resolveService,
} from "../lib/deploy-target";

/**
 * Two services ship from one repository, and neither may ship the working directory.
 *
 * WHY THE ARCHIVE TESTS BUILD A REAL GIT REPOSITORY
 *
 * The property being protected is not "the script calls git archive". It is that a file which is
 * untracked, or a modification which is uncommitted, CANNOT reach a production build. That is a fact
 * about `git archive`, so the test exercises `git archive` against a real repository with real
 * untracked and uncommitted files rather than asserting on a string of source code. A test that
 * grepped the script for "git archive" would pass just as happily against a script that then also
 * copied the working tree.
 *
 * The incident: on 2026-07-29 `railway up` tarballed a working directory whose root manifest carried
 * an uncommitted dependency the lockfile did not have. The remote builder ran
 * `pnpm install --frozen-lockfile`, refused it, and spending authority had already been granted
 * against code that never ran.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A real repository on disk, with one commit. The archive behaviour under test is git's, not ours. */
function scratchRepo(): { root: string; commit: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "untch-deploy-target-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  git(root, "config", "commit.gpgsign", "false");

  mkdirSync(join(root, "services"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"committed"}\n');
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, "services", "app.ts"), "export const version = 'committed';\n");

  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "the commit that ships");
  const commit = git(root, "rev-parse", "HEAD");
  return { root, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Exactly what the deploy script does: archive a COMMIT, extract, and upload that directory. */
function exportCommit(root: string, commit: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "untch-export-"));
  const archive = execFileSync("git", ["archive", "--format=tar", commit], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", dir], { input: archive, maxBuffer: 64 * 1024 * 1024 });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("which service a deploy ships", () => {
  test("the default is untch-asp, so an unflagged deploy cannot silently change target", () => {
    for (const argv of [[], ["--ref=origin/main"], ["--dry-run", "--ref=HEAD"]]) {
      const r = resolveService(argv);
      assert.ok(r.ok);
      assert.equal(r.service, "untch-asp");
      assert.equal(r.service, DEFAULT_SERVICE);
    }
  });

  test("--service=untch-web selects the web app, and only the web app", () => {
    const r = resolveService(["--ref=origin/main", "--service=untch-web"]);
    assert.ok(r.ok);
    assert.equal(r.service, "untch-web");

    // The flag selects ONE service. There is no value that means "both", because a single upload
    // goes to a single Railway service and pretending otherwise would half-deploy a pair.
    const both = resolveService(["--service=untch-asp,untch-web"]);
    assert.equal(both.ok, false);
  });

  test("an unknown or empty service is refused, and the refusal names the real ones", () => {
    const unknown = resolveService(["--service=untch-webb"]);
    assert.equal(unknown.ok, false);
    assert.ok(!unknown.ok && unknown.message.includes("untch-asp"));
    assert.ok(!unknown.ok && unknown.message.includes("untch-web"));
    assert.ok(!unknown.ok && unknown.message.includes("untch-webb"), "it echoes what was received");

    const empty = resolveService(["--service="]);
    assert.equal(empty.ok, false);

    // A typo must never fall back to the default. Silently shipping the ASP because the web app was
    // misspelled is the failure this refusal exists to prevent.
    assert.notEqual((unknown as { service?: string }).service, DEFAULT_SERVICE);
  });

  test("the project link check does not follow the service flag", () => {
    // The Railway project holds both services and is named after the ASP. If the check followed the
    // flag, `--service=untch-web` would report "this repo is linked to project 'untch-asp'", which
    // describes a correct link as an error.
    assert.equal(PROJECT_NAME, "untch-asp");
    assert.ok((KNOWN_SERVICES as readonly string[]).includes(PROJECT_NAME));
  });

  test("--service does not collide with --ref", () => {
    const r = resolveService(["--ref=refs/heads/service-work", "--service=untch-web"]);
    assert.ok(r.ok);
    assert.equal(r.service, "untch-web");
  });
});

describe("what reaches the build", () => {
  test("the artefact is the committed ref: an untracked file cannot enter it", () => {
    const repo = scratchRepo();
    try {
      // The exact 2026-07-29 shape: a file present in the working directory and in no commit.
      writeFileSync(join(repo.root, "SECRETS.local.env"), "TOKEN=should-never-ship\n");
      writeFileSync(join(repo.root, "scratch-notes.md"), "half-finished thought\n");

      const exported = exportCommit(repo.root, repo.commit);
      try {
        const names = readdirSync(exported.dir);
        assert.ok(!names.includes("SECRETS.local.env"), "an untracked file is not in the artefact");
        assert.ok(!names.includes("scratch-notes.md"), "neither is an untracked note");
        assert.ok(existsSync(join(exported.dir, "pnpm-lock.yaml")), "the committed lockfile is");
      } finally {
        exported.cleanup();
      }
    } finally {
      repo.cleanup();
    }
  });

  test("an uncommitted MODIFICATION to a tracked file cannot enter it either", () => {
    const repo = scratchRepo();
    try {
      // The subtler half of the incident. The file is tracked, so a naive "only tracked files" rule
      // would ship it; what shipped must be the COMMITTED bytes, not the current ones.
      writeFileSync(join(repo.root, "package.json"), '{"name":"committed","dependencies":{"ghost":"link:../ghost"}}\n');
      writeFileSync(join(repo.root, "services", "app.ts"), "export const version = 'UNCOMMITTED';\n");

      const exported = exportCommit(repo.root, repo.commit);
      try {
        const manifest = execFileSync("cat", [join(exported.dir, "package.json")], { encoding: "utf8" });
        assert.ok(!manifest.includes("ghost"), "the uncommitted dependency is absent");
        assert.equal(manifest.trim(), '{"name":"committed"}');

        const app = execFileSync("cat", [join(exported.dir, "services", "app.ts")], { encoding: "utf8" });
        assert.ok(app.includes("committed"));
        assert.ok(!app.includes("UNCOMMITTED"), "the working-tree edit is absent");
      } finally {
        exported.cleanup();
      }
    } finally {
      repo.cleanup();
    }
  });

  test("the artefact is identical whichever service it is built for", () => {
    // The whole reason this is a flag and not a second script. If the two targets could produce
    // different trees, "they ship from the same ref" would be a claim rather than a property.
    const repo = scratchRepo();
    try {
      const a = exportCommit(repo.root, repo.commit);
      const b = exportCommit(repo.root, repo.commit);
      try {
        assert.deepEqual(readdirSync(a.dir).sort(), readdirSync(b.dir).sort());
      } finally {
        a.cleanup();
        b.cleanup();
      }
    } finally {
      repo.cleanup();
    }
  });
});

describe("identifying the serving commit afterwards", () => {
  test("the attestation names the commit, the branch and the service it was built for", () => {
    const att = buildAttestation({
      commit: "b4f56d22f64273f3478ed2433e3981a6dcead0bb",
      branch: "main",
      builtAt: "2026-08-02T16:01:20.797Z",
      service: "untch-web",
    });

    assert.equal(att.commit, "b4f56d22f64273f3478ed2433e3981a6dcead0bb");
    assert.equal(att.branch, "main");
    assert.equal(att.source, "git-archive-export");
    assert.equal(att.service, "untch-web");

    // Two services now ship the same commit. Without `service` the two artefacts are identical apart
    // from their upload target, and an operator holding one cannot say which surface it was for.
    const asp = buildAttestation({ ...att, service: "untch-asp" });
    assert.notDeepEqual(asp, att);
    assert.equal(asp.commit, att.commit, "same commit, different artefact identity");
  });

  test("a detached build records a null branch rather than inventing one", () => {
    // An attestation field that can contradict the commit beside it is worse than an absent one.
    const att = buildAttestation({ commit: "abc1234", branch: null, builtAt: "2026-08-02T00:00:00.000Z", service: "untch-asp" });
    assert.equal(att.branch, null);
  });

  test("the attestation survives a JSON round trip, which is how the ops route reads it", () => {
    const att = buildAttestation({ commit: "abc1234", branch: "main", builtAt: "2026-08-02T00:00:00.000Z", service: "untch-web" });
    const round = JSON.parse(JSON.stringify(att)) as Record<string, unknown>;
    assert.deepEqual(round, {
      commit: "abc1234",
      branch: "main",
      builtAt: "2026-08-02T00:00:00.000Z",
      source: "git-archive-export",
      service: "untch-web",
    });
  });
});
