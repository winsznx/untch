/**
 * Disarm the Solana proof gate, and prove the container that held the authority is gone.
 *
 *   pnpm solana:proof:disarm                 # what it would do
 *   pnpm solana:proof:disarm --confirm        # do it
 *
 * WHY A COMMAND AND NOT A CHECKLIST
 *
 * The runbook already describes this procedure correctly. It was still a checklist, which means the one
 * step most likely to be skipped is the one that takes longest and produces no immediate feedback:
 *
 *   > Configuration deletion without a new serving container is not a completed disarm.
 *
 * Variables are read at process start. Deleting one changes nothing for a container that is already
 * running, and that container keeps serving until it is replaced. So a disarm that stops at the deletion
 * has removed the RECORD of the authority while leaving the authority itself in place — strictly worse
 * than not disarming, because every posture map now reports "off" while a signer sits in memory with a
 * funded treasury behind it. This command refuses to report success until a new container is serving and
 * has itself said the authority is gone.
 *
 * THE SILENT NO-OP THIS EXISTS TO CATCH
 *
 * `railway variable delete` on a name that does not exist exits zero. So does a delete that the platform
 * accepted and did not apply. Neither is distinguishable from a real deletion by exit code, which is why
 * every deletion here is followed by a re-read of the variable list and a check that the name is ABSENT.
 * A deletion is not believed because a command returned; it is believed because the variable is gone.
 *
 * NO `-y` ON ANY DELETION. That is the flag that turns "are you sure" into "done", and the value of this
 * command lies entirely in the checks between the steps. Each deletion runs as exactly
 * `railway variable delete <NAME> --service untch-asp --json` and is believed only after a re-read.
 *
 * `railway redeploy` is the one call that carries `--yes`, and it is a different thing: the CLI has an
 * interactive confirmation there that a non-interactive command cannot answer, and the step it guards is
 * the step that REMOVES authority rather than one that grants it. A redeploy that could not run would
 * leave the armed container serving, which is the outcome this whole command exists to prevent. The
 * confirmation being skipped changes nothing about what is verified afterwards: success is still decided
 * by a new container reporting its own posture, never by this call returning.
 */

export {};

import { execFileSync } from "node:child_process";

const SERVICE = "untch-asp";

/**
 * Every variable a proof arms, in the order they are removed.
 *
 * The SECRET goes first, and the ordering is the only load-bearing thing about this list. Removing the
 * flags first would leave a window in which the key is present and the switches are off; removing the key
 * first means that at no point after step one can any subsequent redeploy sign anything, whatever else is
 * still set. If the run is interrupted halfway, the half that completed is the half that matters.
 */
const ARMED_VARIABLES = [
  "CONSUMER_TREASURY_SOLANA_SECRET_KEY",
  "CONSUMER_SOLANA_EXECUTION_ENABLED",
  "CONSUMER_SOLANA_PROOF_MODE",
  "CONSUMER_PROVIDER_PURCH_ENABLED",
  "CONSUMER_CHAIN_SOLANA_5EYKT4USFV8P8NJDTREPY1VZQKQZKVDP_ENABLED",
  "CONSUMER_ASSET_SOLANA_5EYKT4USFV8P8NJDTREPY1VZQKQZKVDP_USDC_ENABLED",
  "CONSUMER_SOLANA_PROOF_INTENT_ID",
  "CONSUMER_SOLANA_PROOF_PROVIDER",
  "CONSUMER_SOLANA_PROOF_CAPABILITY",
  "CONSUMER_SOLANA_PROOF_MAX_USDC",
  "CONSUMER_SOLANA_PROOF_EXPIRES_AT",
] as const;

const confirm = process.argv.includes("--confirm");
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

const ok = (s: string): void => console.log(`  ${green("✓")} ${s}`);
const field = (k: string, v: string): void => console.log(`     ${k.padEnd(26)} ${v}`);
const step = (n: number, s: string): void => console.log(`\n${bold(`${String(n).padStart(2)}. ${s}`)}`);

function die(why: string, detail: readonly string[] = []): never {
  console.error(`\n${red("DISARM INCOMPLETE")} ${why}`);
  for (const line of detail) console.error(`  ${line}`);
  console.error(
    `\n  ${red("The authority may still be live.")} Do not record this as disarmed. Re-run, and if it fails\n` +
      "  again, remove the variables in the Railway dashboard and restart the service by hand.",
  );
  process.exit(2);
}

function railway(args: readonly string[]): string {
  return execFileSync("railway", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The service's variables, as names only. Values are never returned from here, let alone printed. */
function variableNames(): ReadonlySet<string> {
  const raw = railway(["variables", "--service", SERVICE, "--json"]);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return new Set(Object.keys(parsed));
}

/**
 * Delete one variable and verify it is gone.
 *
 * Two independent checks, because each catches something the other does not. The parsed `deleted: true`
 * catches a platform that reported a failure with a zero exit. The re-read catches a platform that
 * reported success and did not apply it. Only the second is proof; the first is what tells an operator
 * WHERE it went wrong.
 */
function deleteVariable(name: string): "deleted" | "already-absent" {
  const before = variableNames();
  if (!before.has(name)) return "already-absent";

  let raw: string;
  try {
    raw = railway(["variable", "delete", name, "--service", SERVICE, "--json"]);
  } catch (err) {
    die(`\`railway variable delete ${name}\` failed`, [String((err as Error).message).slice(0, 300)]);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    die(`the deletion of ${name} returned an unparseable body`, [raw.slice(0, 200)]);
  }
  if (parsed.deleted !== true) {
    die(`the deletion of ${name} did not report deleted: true`, [JSON.stringify(parsed).slice(0, 200)]);
  }

  const after = variableNames();
  if (after.has(name)) {
    die(
      `${name} is STILL PRESENT after a deletion that reported success`,
      ["This is the silent no-op. The platform accepted the command and did not apply it."],
    );
  }
  return "deleted";
}

interface DeploymentRow {
  readonly id?: string;
  readonly status?: string;
  readonly createdAt?: string;
}

function servingDeployment(): DeploymentRow | null {
  const raw = railway(["deployment", "list", "--service", SERVICE, "--json"]);
  const parsed = JSON.parse(raw) as DeploymentRow[] | { deployments?: DeploymentRow[] };
  const rows = Array.isArray(parsed) ? parsed : (parsed.deployments ?? []);
  return rows.find((r) => r.status === "SUCCESS") ?? rows[0] ?? null;
}

interface DeploymentInfo {
  readonly phase?: string;
  readonly commit?: string | null;
  readonly startedAt?: string;
  readonly railwayDeploymentId?: string | null;
  readonly settlementRails?: readonly string[];
  readonly proofGate?: { readonly proofMode?: string };
  readonly solana?: { readonly signer?: string; readonly execution?: string; readonly rpcMode?: string };
}

async function readPosture(
  aspUrl: string,
  token: string,
): Promise<{ readonly healthz: number; readonly info: DeploymentInfo }> {
  const health = await fetch(`${aspUrl}/healthz`);
  const res = await fetch(`${aspUrl}/internal/deployment-info`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) die(`GET /internal/deployment-info answered ${res.status}`);
  return { healthz: health.status, info: (await res.json()) as DeploymentInfo };
}

async function main(): Promise<void> {
  const aspUrl = (process.env.UNTCH_ASP_URL?.trim() || "https://asp.untch.xyz").replace(/\/+$/, "");
  const token = process.env.INTERNAL_OPS_TOKEN?.trim();
  if (!token) die("INTERNAL_OPS_TOKEN is not set, so the post-disarm posture cannot be verified");

  console.log(`\n${bold("SOLANA PROOF DISARM")}  ${confirm ? red("LIVE") : dim("dry run — pass --confirm")}`);
  field("service", SERVICE);
  field("asp", aspUrl);

  step(1, "BEFORE");
  const present = variableNames();
  const armed = ARMED_VARIABLES.filter((n) => present.has(n));
  const beforeDeployment = servingDeployment();
  const beforePosture = await readPosture(aspUrl, token as string);
  field("serving deployment", String(beforeDeployment?.id));
  field("serving commit", String(beforePosture.info.commit));
  field("container started", String(beforePosture.info.startedAt));
  field("signer", String(beforePosture.info.solana?.signer));
  field("solana execution", String(beforePosture.info.solana?.execution));
  field("proof mode", String(beforePosture.info.proofGate?.proofMode));
  field("settlement rails", (beforePosture.info.settlementRails ?? []).join(", "));
  field("armed variables", armed.length === 0 ? "none" : `${armed.length} of ${ARMED_VARIABLES.length}`);
  for (const name of armed) console.log(`     ${dim("present")} ${name}`);

  if (!confirm) {
    console.log(
      `\n  ${dim("Dry run.")} With --confirm this would delete the ${armed.length} variable(s) above, verify each\n` +
        "  is absent, force a redeploy, wait for a NEW serving container, and refuse to report success\n" +
        "  until that container itself reports the signer absent and Solana disabled.",
    );
    return;
  }

  step(2, "DELETE — one at a time, each verified absent before the next");
  const outcomes: string[] = [];
  for (const name of ARMED_VARIABLES) {
    const result = deleteVariable(name);
    outcomes.push(`${name}: ${result}`);
    console.log(`  ${result === "deleted" ? green("✓") : dim("·")} ${name} ${result}`);
  }
  const deletionCompletedAt = new Date();
  ok(`all ${ARMED_VARIABLES.length} names are absent from the service`);
  field("deletions completed", deletionCompletedAt.toISOString());

  /**
   * The step the checklist form of this procedure kept losing.
   *
   * Everything above changed configuration. Nothing above changed the process. A container started while
   * the key was present still holds it, and will keep holding it until it is replaced.
   */
  step(3, "REPLACE THE CONTAINER — deletion alone has not disarmed anything");
  try {
    railway(["redeploy", "--service", SERVICE, "--yes"]);
  } catch (err) {
    die("the redeploy could not be started, so the armed container is still serving", [
      String((err as Error).message).slice(0, 300),
    ]);
  }
  ok("a redeploy was requested");

  step(4, "WAIT FOR A NEW SERVING CONTAINER");
  const deadline = Date.now() + 10 * 60_000;
  let posture: { readonly healthz: number; readonly info: DeploymentInfo } | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    let candidate: { readonly healthz: number; readonly info: DeploymentInfo };
    try {
      candidate = await readPosture(aspUrl, token as string);
    } catch {
      // A restarting service refuses connections for a while. That is the expected middle of this step.
      console.log(`     ${dim(new Date().toISOString())} not answering yet`);
      continue;
    }
    const newId = candidate.info.railwayDeploymentId ?? null;
    const startedAt = candidate.info.startedAt ? Date.parse(candidate.info.startedAt) : NaN;
    const isNewContainer = newId !== null && newId !== (beforePosture.info.railwayDeploymentId ?? null);
    /**
     * A NEW id is not enough on its own. The start time has to be after the deletions.
     *
     * A rollback, or a redeploy that reused an image built while the variables were still set, would
     * produce a new deployment id serving a container whose environment predates the deletion. Comparing
     * the start time is what distinguishes "replaced" from "renamed".
     */
    const startedAfterDeletion = Number.isFinite(startedAt) && startedAt > deletionCompletedAt.getTime();
    console.log(
      `     ${dim(new Date().toISOString())} phase=${String(candidate.info.phase)} ` +
        `new=${isNewContainer} startedAfterDeletion=${startedAfterDeletion}`,
    );
    if (candidate.info.phase === "READY" && isNewContainer && startedAfterDeletion) {
      posture = candidate;
      break;
    }
  }
  if (posture === null) {
    die("no new READY container started after the deletions within ten minutes", [
      `the container serving before the deletions was ${String(beforePosture.info.railwayDeploymentId)}`,
      "Until a new container is serving, the deleted variables are still live in memory.",
    ]);
  }
  ok(`a new container is serving: ${String(posture.info.railwayDeploymentId)}`);

  step(5, "VERIFY THE NEW CONTAINER'S OWN POSTURE");
  const problems: string[] = [];
  if (posture.healthz !== 200) problems.push(`/healthz answered ${posture.healthz}, not 200`);
  if (posture.info.phase !== "READY") problems.push(`phase is ${String(posture.info.phase)}, not READY`);
  if (posture.info.solana?.signer !== "absent") problems.push(`signer is ${String(posture.info.solana?.signer)}`);
  if (posture.info.solana?.execution !== "disabled") {
    problems.push(`solana execution is ${String(posture.info.solana?.execution)}`);
  }
  if (posture.info.proofGate?.proofMode !== "disabled") {
    problems.push(`proof mode is ${String(posture.info.proofGate?.proofMode)}`);
  }
  if (posture.info.solana?.rpcMode !== "read-only") {
    problems.push(`the Solana RPC is ${String(posture.info.solana?.rpcMode)}, not read-only`);
  }
  const rails = posture.info.settlementRails ?? [];
  if (rails.length !== 1 || rails[0] !== "eip155:8453") {
    problems.push(`settlement rails are [${rails.join(", ")}], not Base only`);
  }

  const stillPresent = ARMED_VARIABLES.filter((n) => variableNames().has(n));
  if (stillPresent.length > 0) problems.push(`variables reappeared: ${stillPresent.join(", ")}`);

  if (problems.length > 0) die("the new container does not report a disarmed posture", problems);

  field("serving deployment", String(posture.info.railwayDeploymentId));
  field("serving commit", String(posture.info.commit));
  field("container started", String(posture.info.startedAt));
  field("signer", String(posture.info.solana?.signer));
  field("solana execution", String(posture.info.solana?.execution));
  field("proof mode", String(posture.info.proofGate?.proofMode));
  field("solana rpc", String(posture.info.solana?.rpcMode));
  field("settlement rails", rails.join(", "));

  console.log(`\n  ${green("DISARM COMPLETE")} at ${new Date().toISOString()}`);
  console.log(
    dim(
      "     Record the serving deployment id and commit above alongside this timestamp. The deletion\n" +
        "     output alone is not evidence: what makes this a disarm is that a container started after\n" +
        "     the deletions reported the signer absent itself.",
    ),
  );
  for (const line of outcomes) console.log(`     ${dim(line)}`);
}

main().catch((err: unknown) => {
  die(`the disarm command failed: ${(err as Error).message}`);
});
