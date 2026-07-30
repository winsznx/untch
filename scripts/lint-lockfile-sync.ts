/**
 * `pnpm lint:lockfile` — the CLI over scripts/lint/lockfile-sync.ts.
 *
 * Separate from the rules module for the same reason the public-copy linter is: the module can then be
 * imported by tests without a `process.exit` happening as an import side effect.
 *
 * Run this before any upload to Railway. It answers, locally and offline, the question the remote
 * builder would otherwise answer minutes later at the cost of a failed deployment.
 *
 * Only blocking findings set a non-zero exit. Advisory ones are printed and moved past, because a gate
 * that refuses work pnpm would have accepted is a gate someone eventually learns to bypass.
 */

import { findDrift, describeDrift } from "./lint/lockfile-sync";

function main(): void {
  const drift = findDrift(process.cwd());
  const blocking = drift.filter((d) => d.severity === "blocking");
  const advisory = drift.filter((d) => d.severity === "advisory");

  if (advisory.length > 0) {
    console.log(`\n\x1b[33m${advisory.length} advisory lockfile note(s)\x1b[0m  (a frozen install accepts these)\n`);
    for (const d of advisory) console.log(`  ${describeDrift(d)}`);
    console.log("");
  }

  if (blocking.length === 0) {
    console.log("\x1b[32m✓\x1b[0m lockfile: every workspace manifest agrees with pnpm-lock.yaml");
    return;
  }

  console.error(`\n\x1b[31m${blocking.length} manifest/lockfile disagreement(s)\x1b[0m\n`);
  for (const d of blocking) console.error(`  ${describeDrift(d)}`);

  console.error("\n  Railway builds with `pnpm install --frozen-lockfile`, which refuses this.");
  console.error("  A deployment uploaded in this state fails at the install step, before any");
  console.error("  container exists, so no migration runs and the previous deployment keeps serving.\n");
  console.error("  If the manifest change is intended, run `pnpm install` and commit the lockfile.");
  console.error("  If it is local-only scratch work, keep it out of the tree that gets uploaded.\n");
  process.exit(1);
}

main();
