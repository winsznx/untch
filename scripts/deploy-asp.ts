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

const SERVICE = "untch-asp";
const ATTESTATION_FILENAME = ".untch-build-attestation.json";

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

  console.log("\n\x1b[1mUntch ASP deploy\x1b[0m");

  // ── 1. Resolve the commit, and require that it is a real one ──────────────────────────────────
  let commit: string;
  try {
    commit = git("rev-parse", "--verify", `${ref}^{commit}`);
  } catch {
    return fail(`'${ref}' is not a commit in this repository`);
  }

  const branch = (() => {
    try {
      const name = git("rev-parse", "--abbrev-ref", "HEAD");
      return name === "HEAD" ? null : name;
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
    const attestation = {
      commit,
      branch,
      builtAt: new Date().toISOString(),
      source: "git-archive-export",
    };
    writeFileSync(join(exportDir, ATTESTATION_FILENAME), `${JSON.stringify(attestation, null, 2)}\n`);
    console.log(`  attestation        ${ATTESTATION_FILENAME} (commit ${commit.slice(0, 7)})`);

    if (dryRun) {
      console.log("\n\x1b[33mDRY RUN\x1b[0m  everything above passed. Nothing was uploaded.\n");
      return;
    }

    // ── 7. Upload ──────────────────────────────────────────────────────────────────────────────
    console.log(`\n  uploading to service ${SERVICE} ...\n`);
    execFileSync("railway", ["up", exportDir, "--service", SERVICE, "--detach"], { stdio: "inherit" });

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
