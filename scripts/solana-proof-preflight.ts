/**
 * `pnpm solana:proof:preflight` — may the Solana proof be armed yet?
 *
 * Read-only. It sets nothing, spends nothing, and has no flag that arms anything. Its whole job is to
 * refuse.
 *
 * WHY IT EXISTS
 *
 * On 2026-07-29 the Solana treasury secret and the execution flag were added to the production service
 * before confirming that the deployment carrying the one-shot proof gate had reached SUCCESS. Both new
 * deployments then failed at the build step, so an older container that knew nothing about the gate kept
 * serving while the arming variables sat in the service configuration. No transaction occurred, but the
 * reason was an unrelated build failure rather than any control.
 *
 * Every check below is one of the assumptions that was made silently that day, turned into something
 * that has to be shown. The ordering matters: the checks that prove WHICH CODE IS RUNNING come before
 * the ones that inspect the money, because a healthy treasury reading tells an operator nothing if the
 * code being asked about is not the code that is live.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not arm, and it does not offer to. Arming is a human action taken after this passes, in the
 * documented order, with the deployment already confirmed as serving. A preflight that could also arm
 * would eventually be run with a flag that skips the checks.
 */

export {};

import { execFileSync } from "node:child_process";

const SERVICE = "untch-asp";

/** The wallet the rotated proof is expected to use. Set once funded, and asserted here thereafter. */
const EXPECTED_PROOF_TREASURY = process.env.CONSUMER_SOLANA_PROOF_TREASURY_ADDRESS?.trim() || null;

const EXPECTED_COMMIT = process.env.UNTCH_EXPECTED_COMMIT?.trim() || null;
const ASP_BASE_URL = process.env.ASP_PUBLIC_URL?.trim() || "https://asp.untch.xyz";
const OPS_TOKEN = process.env.INTERNAL_OPS_TOKEN?.trim() || null;

const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** The eight variables that must all be ABSENT before arming, because arming is what sets them. */
const ARMING_VARS = [
  "CONSUMER_TREASURY_SOLANA_SECRET_KEY",
  "CONSUMER_SOLANA_EXECUTION_ENABLED",
  "CONSUMER_SOLANA_PROOF_MODE",
  "CONSUMER_SOLANA_PROOF_INTENT_ID",
  "CONSUMER_SOLANA_PROOF_PROVIDER",
  "CONSUMER_SOLANA_PROOF_CAPABILITY",
  "CONSUMER_SOLANA_PROOF_MAX_USDC",
  "CONSUMER_SOLANA_PROOF_EXPIRES_AT",
] as const;

let failed = 0;
let skipped = 0;

const ok = (label: string, detail = ""): void => console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `: ${detail}` : ""}`);
const bad = (label: string, detail = ""): void => {
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `: ${detail}` : ""}`);
  failed += 1;
};
const skip = (label: string, why: string): void => {
  console.log(`  \x1b[33m-\x1b[0m ${label}: SKIPPED (${why})`);
  skipped += 1;
};

const section = (title: string): void => console.log(`\n\x1b[1m${title}\x1b[0m`);

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "rpc error");
  return body.result;
}

/**
 * Railway variables, read through the CLI.
 *
 * The incident produced a specific operational rule that this encodes: a variable mutation is NOT
 * confirmed by a command's exit status, so the state is re-read and asserted rather than assumed.
 * `railway variables --unset` in particular reported success without removing anything.
 */
function railwayVariableNames(): Set<string> | null {
  try {
    const raw = execFileSync("railway", ["variables", "--service", SERVICE, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return new Set(Object.keys(parsed));
  } catch {
    return null;
  }
}

interface DeploymentInfoResponse {
  readonly phase?: string;
  readonly commit?: string | null;
  readonly commitShort?: string | null;
  readonly attested?: boolean;
  readonly migrationVersion?: string | null;
  readonly settlementRails?: readonly string[];
  readonly proofGate?: { code?: string; schema?: string; proofMode?: string };
  readonly solana?: { signer?: string; execution?: string; rpcHost?: string | null; rpcMode?: string };
}

async function fetchDeploymentInfo(): Promise<DeploymentInfoResponse | null> {
  if (!OPS_TOKEN) return null;
  try {
    const res = await fetch(`${ASP_BASE_URL}/internal/deployment-info`, {
      headers: { authorization: `Bearer ${OPS_TOKEN}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as DeploymentInfoResponse;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log("\n\x1b[1mSolana proof arming preflight\x1b[0m");
  console.log("  read-only. This command arms nothing.");

  // ── Which code is serving ────────────────────────────────────────────────────────────────────
  section("1. the deployment that is actually serving");

  const info = await fetchDeploymentInfo();
  if (!info) {
    if (!OPS_TOKEN) {
      bad("deployment-info reachable", "INTERNAL_OPS_TOKEN is unset locally, so the serving commit cannot be proven");
    } else {
      bad("deployment-info reachable", `no authenticated response from ${ASP_BASE_URL}`);
    }
  } else {
    if (info.phase === "READY") ok("phase", "READY");
    else bad("phase", `${info.phase ?? "unknown"} (the deployment is not serving)`);

    if (info.attested === true && info.commit) {
      ok("build attested", `commit ${info.commitShort ?? info.commit.slice(0, 7)}`);
    } else {
      bad("build attested", "the serving process reports no build attestation, so its commit is unknown");
    }

    if (!EXPECTED_COMMIT) {
      bad("serving commit matches expectation", "UNTCH_EXPECTED_COMMIT is unset, so there is nothing to compare against");
    } else if (info.commit && info.commit.startsWith(EXPECTED_COMMIT)) {
      ok("serving commit matches expectation", EXPECTED_COMMIT.slice(0, 7));
    } else {
      bad(
        "serving commit matches expectation",
        `expected ${EXPECTED_COMMIT.slice(0, 7)}, serving ${info.commit?.slice(0, 7) ?? "unknown"}`,
      );
    }

    if (info.migrationVersion === "011_solana_proof_gate.sql") {
      ok("migration applied", info.migrationVersion);
    } else {
      bad("migration applied", `expected 011_solana_proof_gate.sql, saw ${info.migrationVersion ?? "unknown"}`);
    }

    if (info.proofGate?.code === "present") ok("proof-gate code", "present");
    else bad("proof-gate code", info.proofGate?.code ?? "unknown");

    if (info.proofGate?.schema === "ready") ok("proof-gate schema", "ready");
    else bad("proof-gate schema", info.proofGate?.schema ?? "unknown");

    /**
     * These three must be OFF at preflight time, not on.
     *
     * The preflight runs BEFORE arming. An instance that already has a signer or an execution flag is
     * either mid-proof or was armed without this gate, and in both cases the honest answer is to stop
     * rather than to re-arm on top of an unknown state.
     */
    if (info.proofGate?.proofMode === "disabled") ok("proof mode", "disabled (correct before arming)");
    else bad("proof mode", `${info.proofGate?.proofMode ?? "unknown"} (must be disabled before arming)`);

    if (info.solana?.signer === "absent") ok("Solana signer", "absent (correct before arming)");
    else bad("Solana signer", `${info.solana?.signer ?? "unknown"} (must be absent before arming)`);

    if (info.solana?.execution === "disabled") ok("Solana execution", "disabled (correct before arming)");
    else bad("Solana execution", `${info.solana?.execution ?? "unknown"} (must be disabled before arming)`);

    const rails = info.settlementRails ?? [];
    if (rails.includes("eip155:8453")) ok("Base rail", "healthy and available");
    else bad("Base rail", `expected eip155:8453 among rails, saw ${rails.length > 0 ? rails.join(", ") : "none"}`);
  }

  // ── Railway configuration ────────────────────────────────────────────────────────────────────
  section("2. Railway service configuration");

  const names = railwayVariableNames();
  if (!names) {
    skip("arming variables absent", "the Railway CLI did not return variables (not linked, or not signed in)");
  } else {
    const present = ARMING_VARS.filter((v) => names.has(v));
    if (present.length === 0) ok("arming variables absent", `all ${ARMING_VARS.length} confirmed absent`);
    else bad("arming variables absent", `still configured: ${present.join(", ")}`);

    if (names.has("CONSUMER_SOLANA_RPC_URL")) ok("read-only RPC configured", "CONSUMER_SOLANA_RPC_URL present");
    else bad("read-only RPC configured", "CONSUMER_SOLANA_RPC_URL is absent, so reconciliation cannot read");

    if (names.has("INTERNAL_OPS_TOKEN")) ok("operator token configured", "INTERNAL_OPS_TOKEN present");
    else bad("operator token configured", "INTERNAL_OPS_TOKEN is absent, so deployment-info cannot be served");
  }

  // ── The RPC, and the money ───────────────────────────────────────────────────────────────────
  section("3. Solana RPC and the proof treasury");

  const rpcUrl = process.env.CONSUMER_SOLANA_RPC_URL?.trim();
  if (!rpcUrl) {
    bad("RPC reachable", "CONSUMER_SOLANA_RPC_URL is not set locally");
  } else {
    const host = rpcUrl.replace(/^https?:\/\//, "").split("/")[0] ?? "(unparseable)";
    console.log(`     host                     ${host}`);
    console.log("     credentials              redacted (the key is in the path and is never logged)");

    if (rpcUrl.includes("api.mainnet-beta.solana.com")) {
      bad("dedicated RPC", "this is the PUBLIC mainnet-beta endpoint");
    } else {
      ok("dedicated RPC", "not the public mainnet-beta endpoint");
    }

    try {
      const health = await rpc(rpcUrl, "getHealth", []);
      if (health === "ok") ok("getHealth", "ok");
      else bad("getHealth", String(health));
    } catch (e) {
      bad("getHealth", (e as Error).message);
    }

    try {
      const genesis = (await rpc(rpcUrl, "getGenesisHash", [])) as string;
      if (genesis === MAINNET_GENESIS) ok("getGenesisHash", "Solana mainnet");
      else bad("getGenesisHash", `${genesis} is NOT Solana mainnet`);
    } catch (e) {
      bad("getGenesisHash", (e as Error).message);
    }

    try {
      const bh = (await rpc(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }])) as {
        value?: { blockhash?: string };
      };
      if (bh.value?.blockhash) ok("getLatestBlockhash", "returned");
      else bad("getLatestBlockhash", "no blockhash returned");
    } catch (e) {
      bad("getLatestBlockhash", (e as Error).message);
    }

    ok("canonical USDC mint configured", `${SOLANA_USDC_MINT.slice(0, 6)}...${SOLANA_USDC_MINT.slice(-4)}`);

    /**
     * The rotated wallet, asserted rather than discovered.
     *
     * The old treasury key is treated as compromised and must never be restored, so a preflight that
     * merely found "some funded Solana account" would happily pass against the very key being retired.
     * The expected address is therefore an input, and a mismatch fails.
     */
    if (!EXPECTED_PROOF_TREASURY) {
      bad(
        "proof treasury matches expectation",
        "CONSUMER_SOLANA_PROOF_TREASURY_ADDRESS is unset, so the rotated wallet cannot be confirmed",
      );
    } else {
      console.log(`     expected treasury        ${EXPECTED_PROOF_TREASURY}`);
      try {
        const accounts = (await rpc(rpcUrl, "getTokenAccountsByOwner", [
          EXPECTED_PROOF_TREASURY,
          { mint: SOLANA_USDC_MINT },
          { encoding: "jsonParsed" },
        ])) as {
          value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmountString?: string } } } } } }[];
        };
        const first = accounts.value?.[0];
        const amount = first?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString;
        if (amount === undefined) {
          bad("proof treasury USDC", "no USDC token account found for the expected wallet (fund it first)");
        } else {
          ok("proof treasury USDC", `${amount} USDC`);
        }
      } catch (e) {
        bad("proof treasury USDC", (e as Error).message);
      }

      try {
        const lamports = (await rpc(rpcUrl, "getBalance", [EXPECTED_PROOF_TREASURY])) as { value?: number };
        const sol = (lamports.value ?? 0) / 1_000_000_000;
        if (sol > 0) ok("proof treasury SOL", `${sol} SOL (fees)`);
        else bad("proof treasury SOL", "zero SOL, so it cannot pay its own fees if required");
      } catch (e) {
        bad("proof treasury SOL", (e as Error).message);
      }
    }
  }

  // ── The durable gate ─────────────────────────────────────────────────────────────────────────
  section("4. the durable proof gate");

  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) {
    skip("no conflicting live gate", "DATABASE_URL is unset locally");
    skip("intended intent id is unused", "DATABASE_URL is unset locally");
  } else {
    try {
      const { PgConsumerStore, createPool } = (await import("../packages/consumer-core/src/index")) as typeof import("../packages/consumer-core/src/index");
      const pool = createPool(dbUrl);
      try {
        const store = new PgConsumerStore(pool);
        const gates = await store.listSolanaProofGates(50);
        const live = gates.filter((g) => g.state === "ARMED" || g.state === "CLAIMED");
        if (live.length === 0) ok("no conflicting live gate", `${gates.length} historical gate(s), none live`);
        else bad("no conflicting live gate", `${live.length} gate(s) in ${live.map((g) => g.state).join("/")}`);

        const review = gates.filter((g) => g.state === "MANUAL_REVIEW");
        if (review.length === 0) ok("no gate awaiting manual review");
        else bad("no gate awaiting manual review", `${review.length} gate(s) in MANUAL_REVIEW`);

        const intended = process.env.CONSUMER_SOLANA_PROOF_INTENT_ID?.trim();
        if (!intended) {
          skip("intended intent id is unused", "CONSUMER_SOLANA_PROOF_INTENT_ID is unset locally");
        } else if (gates.some((g) => g.scope.intentId === intended)) {
          bad("intended intent id is unused", `a gate already exists for ${intended}`);
        } else {
          ok("intended intent id is unused", intended);
        }
      } finally {
        await pool.end();
      }
    } catch (e) {
      bad("durable gate readable", (e as Error).message);
    }
  }

  // ── Verdict ──────────────────────────────────────────────────────────────────────────────────
  console.log("");
  if (failed > 0) {
    console.log(`\x1b[31mPREFLIGHT: FAIL\x1b[0m  ${failed} check(s) failed${skipped > 0 ? `, ${skipped} skipped` : ""}`);
    console.log("Do not arm the proof. Do not set any Solana variable.\n");
    process.exit(1);
  }
  if (skipped > 0) {
    console.log(`\x1b[33mPREFLIGHT: INCOMPLETE\x1b[0m  ${skipped} check(s) could not run.`);
    console.log("An unproven check is not a passed check. Resolve them before arming.\n");
    process.exit(2);
  }
  console.log("\x1b[32mPREFLIGHT: PASS\x1b[0m  arming may proceed, in the documented order.\n");
}

main().catch((e) => {
  console.error(`preflight error: ${(e as Error).message}`);
  process.exit(1);
});
