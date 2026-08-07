/**
 * The only supported way to deploy the ASP Worker.
 *
 * WHY THIS EXISTS
 *
 * `wrangler deploy` on its own produces a Worker that serves perfectly and is UNARMED. The attestation
 * is compiled into the bundle by `gen:attestation`, and without that step `bundledAttestation()`
 * returns null, `armingState` records `UNATTESTED`, and the payment gate refuses every request that
 * carries an authorization. The 402 challenges still go out, discovery still passes, health still says
 * `ready: true` — so the service looks completely fine while no buyer can actually pay.
 *
 * That is not hypothetical. Several bare `wrangler deploy` runs during the Cloudflare cutover shipped
 * unattested bundles, and the only visible trace was an empty sales table. The failure is silent by
 * construction, which is precisely why the safe sequence must be a script rather than a note in a
 * README.
 *
 * WHAT IT GUARANTEES
 *
 * 1. The attestation is generated from a clean tree immediately before the upload, so the commit it
 *    names is the commit in the bundle.
 * 2. The generated file is restored to its checked-in `null` afterwards, whatever happens. A real
 *    attestation committed to a branch would describe one deployment forever and reintroduce exactly
 *    the staleness the mechanism was built to prevent.
 * 3. The deployed Worker is asked what it is. A deploy that reports `attested: false` or refusals is
 *    reported as a FAILED deploy, because a Worker that cannot settle has not finished deploying.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ASP = join(ROOT, "services", "asp");

const env = process.argv.includes("--preview") ? "" : "production";
const run = (cmd: string, args: string[], cwd: string): string =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });

let generated = false;
try {
  run("pnpm", ["gen:attestation"], ROOT);
  generated = true;

  console.log(`deploying to ${env || "preview"}…`);
  const out = run(
    "pnpm",
    ["exec", "wrangler", "deploy", "--env", env, "--config", "workers/wrangler.jsonc"],
    ASP,
  );
  console.log(out.split("\n").slice(-4).join("\n"));
} finally {
  /**
   * Restored even when the deploy throws. A failed deploy that leaves a real attestation in the tree
   * would let the NEXT command — a test run, a commit, someone else's deploy — pick up a claim about a
   * deployment that never shipped.
   */
  if (generated) run("pnpm", ["gen:attestation", "--reset"], ROOT);
}

if (env !== "production") process.exit(0);

/**
 * Ask the deployment what it is, rather than trusting that the upload implied it.
 *
 * This is the same principle the attestation itself encodes: the running process is the only
 * authority on which code is running.
 */
const BASE = process.env.ASP_PUBLIC_URL ?? "https://asp.untch.xyz";
const deadline = Date.now() + 90_000;
let health: Record<string, never> | undefined;

while (Date.now() < deadline) {
  const res = await fetch(`${BASE}/readyz`, { cache: "no-store" });
  health = (await res.json()) as never;
  if ((health as { attested?: boolean }).attested) break;
  await new Promise((r) => setTimeout(r, 5_000));
}

const h = health as unknown as {
  attested?: boolean;
  commitShort?: string;
  armingRefusals?: string[];
  posture?: { financiallyArmed?: boolean };
};

if (!h?.attested) {
  console.error(
    "DEPLOY FAILED: the live Worker reports attested=false.\n" +
      "It will serve 402 challenges and refuse every settlement. Do not treat this as deployed.",
  );
  process.exit(1);
}

const refusals = h.armingRefusals ?? [];
console.log(
  `deployed ${h.commitShort} — attested, financiallyArmed=${h.posture?.financiallyArmed}` +
    (refusals.length ? `, refusals=${refusals.join(",")}` : ""),
);
if (refusals.length) process.exit(1);
