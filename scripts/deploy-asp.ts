/**
 * `pnpm deploy:asp` — upload a COMMITTED commit to Railway, never the working directory.
 *
 * WHAT WENT WRONG WITHOUT THIS
 *
 * `railway up` tarballs the current directory. That is a reasonable default and a dangerous one for a
 * repository where local scratch work lives beside the product, because the artefact that reaches
 * production is then "the reviewed commit, plus whatever happened to be uncommitted".
 *
 * On 2026-07-29 that meant a root manifest carrying an uncommitted dependency travelling with a lockfile
 * that had never seen it. Railway builds with `--frozen-lockfile`, so the build died before a container
 * existed. Two deployments failed, an older container without the new spending gate kept serving, and
 * spending authority had already been granted on the belief that the new code was live.
 *
 * The lockfile mismatch was luck. The same mechanism could have shipped unreviewed code with no error
 * at all, which is the failure this script exists to make impossible rather than unlikely.
 *
 * WHAT IT DOES
 *
 * Exports a named commit with `git archive`, writes a build attestation into that export, re-runs the
 * manifest/lockfile check against the exported tree, and uploads the export. The working directory is
 * never the deploy source, so uncommitted state cannot reach production even by accident.
 *
 * It does not arm anything, and it deliberately cannot. Arming is a separate, later, human step gated by
 * `pnpm solana:proof:preflight`.
 */

export {};

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDrift, describeDrift } from "./lint/lockfile-sync";
import { PROJECT_NAME, buildAttestation, resolveService, type KnownService } from "./lib/deploy-target";

const ENVIRONMENT = "production";
const ATTESTATION_FILENAME = ".untch-build-attestation.json";

/**
 * Which Railway project to upload to, resolved from THIS repository's link.
 *
 * `railway up <path>` resolves the project from the directory it is given, and the export is a plain
 * directory with no Railway link, so it fails with "prefix not found". Passing the project explicitly is
 * the fix, and reading it from the repo's own link rather than hardcoding an id keeps the two from
 * drifting apart.
 */
function linkedProjectId(): string {
  const raw = execFileSync("railway", ["status", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(raw) as { id?: string; name?: string };
  if (!parsed.id) throw new Error("railway status returned no project id");
  if (parsed.name !== PROJECT_NAME) {
    // The project and the service share a name here. A mismatch means this repo is linked somewhere
    // unexpected, and uploading production code to a project nobody intended is worth refusing over.
    throw new Error(`this repo is linked to project '${parsed.name}', expected '${PROJECT_NAME}'`);
  }
  return parsed.id;
}

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fail(message: string, detail?: string): never {
  console.error(`\n\x1b[31mDEPLOY REFUSED\x1b[0m  ${message}\n`);
  if (detail) console.error(`${detail}\n`);
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const refArg = args.find((a) => a.startsWith("--ref="));
  const ref = refArg ? refArg.slice("--ref=".length) : "HEAD";

  /**
   * Resolved through the script's own refusal path, not by throwing at import.
   *
   * Everything else in this file that can go wrong prints DEPLOY REFUSED and says what to do; a
   * mistyped service name should not be the one case that produces a raw stack trace instead.
   */
  const target = resolveService(args);
  if (!target.ok) return fail(target.message);
  const SERVICE: KnownService = target.service;

  console.log(`\n\x1b[1mUntch deploy → ${SERVICE}\x1b[0m`);

  // ── 1. Resolve the commit, and require that it is a real one ──────────────────────────────────
  let commit: string;
  try {
    commit = git("rev-parse", "--verify", `${ref}^{commit}`);
  } catch {
    return fail(`'${ref}' is not a commit in this repository`);
  }

  /**
   * The branch that CONTAINS the deployed commit, not whatever is checked out.
   *
   * The first real deploy through this script exposed the difference. It ran from a feature branch with
   * `--ref=origin/main`, and the attestation recorded the local branch name while the commit was main's
   * tip. The commit was right, so nothing was actually mis-deployed, but an operator reading
   * `branch: fix/...` next to a commit that is main would reasonably conclude the wrong code had
   * shipped. An attestation field that can contradict the commit beside it is worse than no field.
   *
   * Remote branches are preferred because those are the ones other people can resolve.
   */
  const branch = (() => {
    try {
      const remotes = git("branch", "--remotes", "--contains", commit)
        .split("\n")
        .map((l) => l.trim().replace(/^origin\//, ""))
        .filter((l) => l !== "" && !l.includes("->"));
      if (remotes.includes("main")) return "main";
      if (remotes[0] !== undefined) return remotes[0];
      const local = git("rev-parse", "--abbrev-ref", "HEAD");
      return local === "HEAD" ? null : local;
    } catch {
      return null;
    }
  })();

  console.log(`  ref                ${ref}`);
  console.log(`  commit             ${commit}`);
  console.log(`  branch             ${branch ?? "(detached)"}`);

  /**
   * ── 2. The commit must exist on the remote ──────────────────────────────────────────────────
   *
   * A commit that only exists on this machine cannot be reviewed, cannot be checked out by anyone
   * else, and cannot be recovered if the machine is lost. Attesting a deployment to a SHA nobody else
   * can resolve is attestation in name only.
   */
  git("fetch", "origin", "--quiet");
  const onRemote = (() => {
    try {
      const branches = git("branch", "--remotes", "--contains", commit);
      return branches.trim() !== "";
    } catch {
      return false;
    }
  })();
  if (!onRemote) {
    return fail(
      `commit ${commit.slice(0, 7)} is not on any remote branch`,
      "  Push it first. A deployment attested to an unpushed commit names code that only exists here.",
    );
  }
  console.log("  pushed             yes");

  /**
   * ── 3. Report, but do not block on, a dirty working tree ────────────────────────────────────
   *
   * Uncommitted changes are irrelevant to what gets uploaded now, because the upload comes from an
   * export of the commit rather than from this directory. That is precisely the property being bought.
   * It is still worth printing, so the operator is never surprised that their in-progress edits are
   * absent from what they just shipped.
   */
  const dirty = git("status", "--porcelain");
  if (dirty !== "") {
    const count = dirty.split("\n").filter((l) => l.trim() !== "").length;
    console.log(`  workingTree        ${count} uncommitted path(s), EXCLUDED from this deploy`);
  } else {
    console.log("  workingTree        clean");
  }

  // ── 4. Export the commit ─────────────────────────────────────────────────────────────────────
  const exportDir = mkdtempSync(join(tmpdir(), "untch-deploy-"));
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", commit], {
      maxBuffer: 512 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", exportDir], { input: archive, maxBuffer: 512 * 1024 * 1024 });
    console.log(`  export             ${exportDir}`);

    if (!existsSync(join(exportDir, "pnpm-lock.yaml"))) {
      return fail("the export has no pnpm-lock.yaml, which cannot be right");
    }

    /**
     * ── 5. The gate that would have caught the failed deployment ─────────────────────────────
     *
     * Run against the EXPORT, not the working tree. The export is the artefact, and the artefact is the
     * only thing whose consistency matters. Checking the working tree here would ask a question about
     * a directory that is not being uploaded.
     */
    const drift = findDrift(exportDir);
    const blocking = drift.filter((d) => d.severity === "blocking");
    const advisory = drift.filter((d) => d.severity === "advisory");

    for (const d of advisory) console.log(`  \x1b[33mnote\x1b[0m               ${describeDrift(d).split("\n")[0]}`);

    if (blocking.length > 0) {
      return fail(
        `${blocking.length} manifest/lockfile disagreement(s) in the exported commit`,
        blocking.map((d) => `  ${describeDrift(d)}`).join("\n") +
          "\n\n  Railway builds this with `pnpm install --frozen-lockfile`, which would refuse it." +
          "\n  Fix the commit, push, and deploy again.",
      );
    }
    console.log("  lockfile           consistent");

    /**
     * ── 6. Write the attestation INTO the artefact ────────────────────────────────────────────
     *
     * Not a Railway variable. A variable outlives the deployment it was set for, so a variable naming
     * a commit whose build failed is exactly the lie that caused the incident. A file inside the
     * uploaded tree travels with the code and cannot describe a different build.
     *
     * Nothing personal goes in here. It is readable by anyone who can reach the ops endpoint, and the
     * commit, branch and timestamp are all that is needed to answer "is the expected code serving".
     */
    const attestation = buildAttestation({
      commit,
      branch,
      builtAt: new Date().toISOString(),
      service: SERVICE,
    });
    writeFileSync(join(exportDir, ATTESTATION_FILENAME), `${JSON.stringify(attestation, null, 2)}\n`);
    console.log(`  attestation        ${ATTESTATION_FILENAME} (commit ${commit.slice(0, 7)})`);

    if (dryRun) {
      console.log("\n\x1b[33mDRY RUN\x1b[0m  everything above passed. Nothing was uploaded.\n");
      return;
    }

    // ── 7. Upload ──────────────────────────────────────────────────────────────────────────────
    const projectId = linkedProjectId();
    console.log(`\n  uploading to ${SERVICE} (project ${projectId}, env ${ENVIRONMENT}) ...\n`);
    /**
     * Run FROM the export directory, with no path argument.
     *
     * `railway up <path>` computes the upload prefix relative to the current working directory and
     * fails with "prefix not found" when handed a path outside it. Setting cwd instead of passing the
     * path is what makes an out-of-tree export uploadable at all.
     */
    execFileSync(
      "railway",
      ["up", "--service", SERVICE, "--project", projectId, "--environment", ENVIRONMENT, "--detach"],
      { stdio: "inherit", cwd: exportDir },
    );

    console.log("\n\x1b[32mUPLOADED\x1b[0m");
    console.log("  This is NOT a successful deployment yet. Verify, in this order:");
    console.log("    1. the deployment reaches SUCCESS");
    console.log(`    2. it is the deployment SERVING traffic, not merely the newest`);
    console.log(`    3. GET /internal/deployment-info reports commit ${commit.slice(0, 7)}`);
    console.log("    4. proof mode is disabled, and the Solana signer is absent");
    console.log("\n  Do not set any Solana variable until `pnpm solana:proof:preflight` passes.\n");
  } finally {
    rmSync(exportDir, { recursive: true, force: true });
  }
}

main();
