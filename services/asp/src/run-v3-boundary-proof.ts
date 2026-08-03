/**
 * The V3 direct-account decision path, exercised across the real production boundary and rolled back.
 *
 * WHAT THIS RUNS, AND WHY IT IS NOT A SECOND IMPLEMENTATION
 *
 * It builds the SAME `PublicPreflightDeps` and `PreflightDeps` `server.ts` builds, registers the SAME
 * `/internal/consumer/preflight-validate` route the deployment registers, listens on a real socket,
 * and POSTs real JSON over real HTTP. Inside that route, `handlePublicPreflight` — the exact function
 * the $0.05 route calls — resolves the account, selects the policy, maps the intent, runs the policy
 * engine, canonicalises the quote, assembles the V3 evidence and executes the INSERTs against the
 * real CHECK constraints. Then the transaction rolls back.
 *
 * There is no code path here the paid route does not also run, which is the only property that makes
 * a non-billable proof worth anything.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * Deploy, pay, sign, message anybody, or touch production. It creates its own throwaway database from
 * TEST_DATABASE_URL, applies every migration, and seeds one account, one wallet binding and one
 * policy. The route is wired with `DecisionOnlyDeps`, which cannot NAME an escalation gateway, a
 * receipt enqueuer, an intent registry or an oracle signer — so there is nothing to disable and
 * nothing to forget to disable. A rollback cannot un-send a Telegram message; the fix is that no
 * gateway is reachable, not that one is asked to stay quiet.
 *
 * THE COUNT ASSERTION
 *
 * Every row in every table is counted before and after. Identical counts is the claim; a rolled-back
 * transaction that nonetheless left a receipt row, an escalation or an outbox entry has happened in
 * this codebase before (PR #61), which is why it is asserted rather than described.
 *
 *   TEST_DATABASE_URL=postgres://… pnpm --filter @untch/asp v3:boundary
 */

import { createServer } from "node:http";
import express from "express";
import { keccak256, toHex, type Address, type Hex } from "viem";
import {
  PgAccountStore,
  accountRefHash,
  asset,
  createPool as createConsumerPool,
  newWalletBindingId,
  runMigrations as runConsumerMigrations,
  walletAuthorityRef,
  type Pool,
} from "@untch/consumer-core";
import {
  PgPolicyRepo,
  PolicyProvider,
  createPool as createPolicyPool,
  runMigrations as runPolicyMigrations,
  type StoredPolicy,
} from "@untch/policy-store";
import { findOwnedService } from "@untch/owned-work";
import { hashCanonicalJson } from "@untch/canon";
import { registerPreflightValidateRoute, OPERATOR_PREFLIGHT_VALIDATE_ROUTE } from "./consumer/preflight-validate-route";
import type { PublicPreflightDeps } from "./public-dto/preflight";
import { InMemoryIntentStore } from "./ledger-state";
import { narrowToDecisionOnly } from "./route-profiles";
import { decisionStateCounts } from "@untch/consumer-core";
import { ledgerPartitionKey } from "@untch/policy-engine";

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_proof_v3_boundary";
const OPS_TOKEN = "v3-boundary-proof-operator-token";
const CHAIN_ID = 196;
const REGISTRY = "0x0000000000000000000000000000000000000000";

/** The wallet that owns the policy. A fixed, meaningless address: nothing here signs anything. */
const WALLET: Address = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";

/**
 * One deadline for the whole run.
 *
 * A fresh `Date.now() + 1h` per request would give the two passes different quote digests for the
 * same logical request, and the point of the second pass is that it is IDENTICAL. The deadline is an
 * input the caller controls, so holding it fixed is what makes "identical request" mean something.
 */
const DEADLINE = new Date(Date.now() + 3_600_000).toISOString();

function fail(message: string): never {
  console.error(`\nRESULT: FAIL — ${message}`);
  process.exit(1);
}

function check(condition: boolean, label: string): boolean {
  console.log(`      ${condition ? "✅" : "❌"} ${label}`);
  return condition;
}

function ownDatabaseUrl(): string {
  const url = new URL(TEST_DB as string);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

/**
 * The ruleset the three amounts are judged against.
 *
 * Chosen so each expected outcome comes from a DIFFERENT rule rather than from three points on one
 * threshold: 4.00 passes everything, 6.00 crosses `escalateAbove`, and 9.00 breaches `perCallCap`
 * with `onPerCallCapExceeded: BLOCK`. A proof where all three outcomes came from one comparison would
 * be proving the comparison, not the path.
 */
function proofRules(): StoredPolicy["rules"] {
  return {
    budgets: { daily: 100, token: "USDT0" },
    perCallCap: 8.0,
    onPerCallCapExceeded: "BLOCK",
    escalateAbove: 5.0,
    categories: { allow: [], deny: [] },
    recipients: { allow: [], deny: [] },
    agents: { allowWorkerIds: [], denyWorkerIds: [] },
    duplicates: { ttlMin: 0, keys: ["taskHash", "endpoint", "paramsHash"] },
    cooldowns: { sameServiceMin: 0 },
    rateLimit: { callsPerHour: 100 },
    expiry: "2027-12-31T00:00:00Z",
  } as unknown as StoredPolicy["rules"];
}

/** Count every row in every table, so "nothing was persisted" is a number rather than a sentence. */
async function tableCounts(pool: Pool): Promise<Record<string, number>> {
  const { rows: tables } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${t.table_name}"`);
    counts[t.table_name] = Number(rows[0]!.n);
  }
  return counts;
}

interface ProofCase {
  readonly amount: string;
  readonly expectedOutcome: string;
  readonly expectedEngineDecision: string;
}

const CASES: readonly ProofCase[] = [
  { amount: "4.00", expectedOutcome: "APPROVED_AUTOMATIC", expectedEngineDecision: "APPROVED" },
  { amount: "6.00", expectedOutcome: "ESCALATED", expectedEngineDecision: "ESCALATED_THRESHOLD" },
  { amount: "9.00", expectedOutcome: "BLOCKED", expectedEngineDecision: "BLOCKED_PER_CALL_CAP" },
];

async function main(): Promise<void> {
  if (!TEST_DB) fail("TEST_DATABASE_URL is unset — this proof needs a throwaway Postgres and will not touch production");

  console.log("── V3 DIRECT-ACCOUNT BOUNDARY PROOF (non-billable, always rolled back) ─────");
  console.log(`database : ${OWN_DATABASE} (throwaway, created here)`);
  console.log("payment  : none. This route is behind the operator token and never settles.");

  const admin = createConsumerPool(TEST_DB);
  try {
    await admin.query(`CREATE DATABASE ${OWN_DATABASE}`).catch((err: unknown) => {
      if ((err as { code?: string }).code !== "42P04") throw err;
    });
  } finally {
    await admin.end();
  }

  const url = ownDatabaseUrl();
  const pool = createConsumerPool(url);
  const policyPool = createPolicyPool(url);
  let server: ReturnType<typeof createServer> | null = null;

  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runPolicyMigrations(policyPool);
    await runConsumerMigrations(pool);
    console.log("\n[1/6] migrations applied (policy-store + consumer-core, including 024 and 025)");

    // ── the account, its proven wallet, and the policy that wallet owns ──────
    const accounts = new PgAccountStore(pool);
    const account = await accounts.createAccount({ by: "v3-boundary-proof" });
    const bindingId = newWalletBindingId();
    const verifiedAt = "2026-08-03T00:00:00.000Z";
    await accounts.linkWallet({
      bindingId,
      accountId: account.accountId,
      chainKind: "evm",
      address: WALLET,
      role: "primary",
      proofKind: "siwe",
      proofRef: "v3-boundary-proof-nonce",
      verifiedAt,
      walletProvider: "okx-agentic-wallet",
      scopes: ["identity", "policy-authority"],
      by: "siwe",
    });
    // The validate route mints its session from the account's PRIMARY binding, the same way the live
    // account journey does after a successful SIWE. Without this the account has a proven wallet and
    // no primary, which the route correctly refuses.
    await accounts.setPrimaryWallet({ accountId: account.accountId, bindingId, by: "v3-boundary-proof" });

    const policyRepo = new PgPolicyRepo(policyPool);
    const rules = proofRules();
    const policyId = "990001";
    const policy: StoredPolicy = {
      id: policyId,
      owner: WALLET,
      agentId: WALLET,
      version: 1,
      status: "ACTIVE",
      policyHash: hashCanonicalJson(rules as unknown as Record<string, unknown>),
      expiry: Math.floor(Date.parse("2027-12-31T00:00:00Z") / 1000),
      onchainRef: { chainId: CHAIN_ID, txHash: keccak256(toHex("v3-boundary-proof")), blockNumber: 1 },
      rules,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as StoredPolicy;
    await policyRepo.insert(policy);
    /**
     * `registered`, not `adopted`. The distinction is the one the direct path depends on: this
     * account's own proven wallet is the policy's on-chain owner, which is what makes `SpendIntent.
     * owner` name exactly one account. An `adopted` link would be delegation, and the resolver refuses
     * a direct request on a delegated policy — correctly, and this proof would then prove nothing.
     */
    await accounts.linkPolicy({
      accountId: account.accountId,
      policyId,
      linkedBy: "registered",
      by: "v3-boundary-proof",
    });
    await accounts.setDefaultPolicy({ accountId: account.accountId, policyId, by: "v3-boundary-proof" });

    const expectedAuthority = walletAuthorityRef({
      chainKind: "evm",
      address: WALLET,
      walletBindingId: bindingId,
      proofKind: "siwe",
      verifiedAt,
    });
    console.log(`[2/6] account ${account.accountId} · wallet ${WALLET} · policy ${policyId}`);
    console.log(`      accountRefHash     ${accountRefHash(account.accountId)}`);
    console.log(`      walletAuthorityRef ${expectedAuthority}`);

    // ── the production deps, built exactly as server.ts builds them ──────────
    const settlementAsset = asset("xlayer.usdt0");
    const provider = new PolicyProvider(policyRepo);
    const publicDeps: PublicPreflightDeps = {
      accounts,
      policies: provider,
      ownedService: (p: string, c: string) => findOwnedService(p, c),
      network: {
        token: settlementAsset.address as Address,
        symbol: settlementAsset.symbol,
        decimals: settlementAsset.decimals,
      },
      sessionSecret: "v3-boundary-proof-session-secret",
      executionEnabled: false,
      chainId: CHAIN_ID,
      registry: REGISTRY,
      // Supplied by the route, which always rolls back. Null here so nothing can commit by accident.
      evidenceTx: null,
    };

    const app = express();
    app.use(express.json());
    process.env.INTERNAL_OPS_TOKEN = OPS_TOKEN;
    registerPreflightValidateRoute(app, {
      pool,
      accounts,
      publicDeps,
      decisionDeps: () =>
        narrowToDecisionOnly({
          policyProvider: provider,
          intentStore: new InMemoryIntentStore(),
          scoreDataSource: null,
        }),
      secret: publicDeps.sessionSecret,
    });

    server = createServer(app);
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });
    console.log(`[3/6] real Express route on http://127.0.0.1:${port}${OPERATOR_PREFLIGHT_VALIDATE_ROUTE}`);

    const before = await tableCounts(pool);

    /**
     * The decision-state counts, which are the numbers that mattered on 2026-08-03.
     *
     * A rolled-back validation used to leave the duplicate window, the daily spend and the rate
     * counter changed — in process memory, where the rollback could not reach. These four numbers are
     * what "the validation changed nothing that could change a later decision" means concretely.
     */
    const decisionCounts = async (): Promise<Record<string, string>> => {
      const client = await pool.connect();
      try {
        const c = await decisionStateCounts(client as never, ledgerPartitionKey(policyId));
        return {
          recentIntents: String(c.recentIntents),
          rateTicks: String(c.rateTicks),
          replayMarkers: String(c.replayMarkers),
          serviceCalls: String(c.serviceCalls),
          dailySpend: c.dailySpend,
        };
      } finally {
        client.release();
      }
    };

    const post = async (amount: string, idempotencyKey: string): Promise<Record<string, unknown>> => {
      const response = await fetch(`http://127.0.0.1:${port}${OPERATOR_PREFLIGHT_VALIDATE_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${OPS_TOKEN}` },
        body: JSON.stringify({
          accountId: account.accountId,
          request: {
            provider: "untch",
            capability: "owned_work.demo",
            task: `V3 boundary proof at ${amount}`,
            maxSpend: amount,
            currency: settlementAsset.symbol,
            deadline: DEADLINE,
            // NO buyerAgentId. That absence IS the direct account path.
            idempotencyKey,
          },
        }),
      });
      const parsed = (await response.json()) as Record<string, unknown>;
      return { ...parsed, __status: response.status };
    };

    // ── the three decisions ─────────────────────────────────────────────────
    console.log("\n[4/6] three decisions, over real HTTP, each rolled back\n");
    const results: Record<string, unknown>[] = [];
    let allOk = true;

    for (const c of CASES) {
      const body = await post(c.amount, `v3-boundary-${c.amount}`);
      const response = { status: body.__status as number };
      const requester = (body.requester ?? {}) as Record<string, unknown>;
      const evidence = (body.evidence ?? {}) as Record<string, unknown>;
      const validation = (body.validation ?? {}) as Record<string, unknown>;
      const raw = (requester.raw ?? {}) as Record<string, unknown>;
      const serialised = JSON.stringify(body);

      console.log(`  ${c.amount} → ${String(body.outcome)} / ${String(body.engineDecision)}`);
      if (response.status !== 200) {
        // The whole body, because a refusal here is a wiring fault and the message is the diagnosis.
        console.log(`      HTTP ${response.status}: ${JSON.stringify(body)}`);
      }

      const ok = [
        check(response.status === 200, "HTTP 200"),
        check(body.outcome === c.expectedOutcome, `outcome ${c.expectedOutcome}`),
        check(body.engineDecision === c.expectedEngineDecision, `engine ${c.expectedEngineDecision}`),
        check(evidence.metadataSchemaVersion === 3, "metadataSchemaVersion 3"),
        check(evidence.completeness === "V3_COMPLETE", "completeness V3_COMPLETE"),
        check(evidence.requesterPrincipalKind === "untch_account", "requesterPrincipalKind untch_account"),
        check(evidence.requesterPrincipalNamespace === "untch-account", "requesterPrincipalNamespace untch-account"),
        check(evidence.onchainBuyerAgentId === "0", "onchainBuyerAgentId 0"),
        check(evidence.buyerAgentId === null, "buyerAgentId absent"),
        check(evidence.buyerAgentIdSemantics === "no_marketplace_buyer", "buyerAgentIdSemantics no_marketplace_buyer"),
        check(evidence.marketplace === null, "no marketplace identity"),
        check(evidence.sellerAspId === "6086", "sellerAspId 6086"),
        check(evidence.workerAgentId === "6086", "workerAgentId 6086"),
        check(evidence.serviceId === "owned_work.demo", "serviceId owned_work.demo"),
        check(evidence.policyId === policyId, `exact policyId ${policyId}`),
        check(
          evidence.policySelectionSemantics === "exact_offchain_policy_id_legacy_onchain_policy_hash",
          "policySelectionSemantics discloses the on-chain limitation",
        ),
        check(evidence.accountRefHash === accountRefHash(account.accountId), "accountRefHash present publicly"),
        check(evidence.walletAuthorityRef === expectedAuthority, "walletAuthorityRef present and correct"),
        check(evidence.rawAccountIdPresent === false, "raw accountId absent from the public projection"),
        check(evidence.walletBindingIdPresent === false, "walletBindingId absent from the public projection"),
        /**
         * WHERE THE RAW accountId IS ALLOWED TO BE, STATED PRECISELY.
         *
         * This response goes to an authenticated caller who IS the account, so the top-level
         * `account` block and the `derived` provenance legitimately name it — that is the PRIVATE
         * view, and hiding an account's own id from itself would be theatre.
         *
         * What must never carry it is anything a stranger reads: the `evidence` projection, which is
         * what a receipt page and a verifier are handed, and the `requester` block, which is what a
         * public surface renders. Asserted separately rather than as one blanket "not anywhere",
         * because a blanket assertion would have to be relaxed for the legitimate case and would then
         * stop catching the illegitimate one.
         */
        check(!JSON.stringify(evidence).includes(account.accountId), "raw accountId absent from the public evidence projection"),
        check(!JSON.stringify(requester).includes(account.accountId), "raw accountId absent from the public requester block"),
        check(!serialised.includes(bindingId), "walletBindingId absent from the whole response, private view included"),
        check(
          !JSON.stringify(evidence).includes(WALLET.toLowerCase().slice(2)) ||
            evidence.policyOwner === WALLET.toLowerCase(),
          "the only address in the public evidence is the policy owner, which is a published on-chain fact",
        ),
        check(requester.requester === "Untch account", 'rendered as "Untch account"'),
        check(requester.marketplaceBuyer === "None", 'marketplace buyer rendered as "None"'),
        check(
          !/Buyer agent 0|Agent ID 0|ERC-8004 agent 0|Marketplace identity 0|Unknown agent/.test(serialised),
          "no forbidden rendering of the zero anywhere in the response",
        ),
        check(raw.legacyAgentIdSemantics === "NO_MARKETPLACE_BUYER_V3", "raw projection labels the zero"),
        check(typeof evidence.metadataCommitment === "string", "metadata commitment returned"),
        check(typeof evidence.requesterCommitment === "string", "requester commitment returned"),
        check(body.paid === false, "paid: false"),
        check(validation.billed === false, "validation.billed false"),
        check(validation.persisted === false, "validation.persisted false"),
        check(validation.writesExecutedThenRolledBack === true, "the INSERTs ran against real constraints, then rolled back"),
      ].every(Boolean);

      allOk = allOk && ok;
      results.push({
        amount: c.amount,
        outcome: body.outcome,
        engineDecision: body.engineDecision,
        quoteDigest: evidence.quoteDigest,
        policySnapshotHash: evidence.policySnapshotHash,
        metadataCommitment: evidence.metadataCommitment,
        requesterCommitment: evidence.requesterCommitment,
        accountRefHash: evidence.accountRefHash,
        walletAuthorityRef: evidence.walletAuthorityRef,
        allChecksPassed: ok,
      });
      console.log("");
    }

    // ── the cross-case properties ───────────────────────────────────────────
    console.log("[5/6] across the three decisions\n");
    const snapshots = new Set(results.map((r) => String(r.policySnapshotHash)));
    const digests = new Set(results.map((r) => String(r.quoteDigest)));
    const authorities = new Set(results.map((r) => String(r.walletAuthorityRef)));
    allOk =
      [
        check(snapshots.size === 1, "one policy, one snapshot hash — three reads of an unchanged policy are one state"),
        check(digests.size === 3, "three distinct quote digests — different amounts are different obligations"),
        check(authorities.size === 1, "one wallet authority across all three"),
      ].every(Boolean) && allOk;

    /**
     * ── THE SECOND PASS ───────────────────────────────────────────────────
     *
     * The same three requests again. Before this pass existed, the first run's APPROVED 4.00 committed
     * a duplicate marker into process memory that the rollback could not remove, so the second run's
     * 4.00 came back BLOCKED_DUPLICATE. Identical results across two passes is the property that was
     * missing, and running it twice is the only way to observe it.
     */
    console.log("\n[5b/6] the same three decisions again — identical, or the isolation is not real\n");
    const decisionStateAfterFirstPass = await decisionCounts();
    const secondPass: string[] = [];
    for (const c of CASES) {
      const body = await post(c.amount, `v3-boundary-${c.amount}`);
      secondPass.push(String(body.engineDecision));
      console.log(`  ${c.amount} → ${String(body.outcome)} / ${String(body.engineDecision)}`);
    }
    const firstPass = results.map((r) => String(r.engineDecision));
    allOk =
      [
        check(JSON.stringify(secondPass) === JSON.stringify(firstPass),
          `second pass identical to the first (${firstPass.join(", ")})`),
        check(secondPass[0] !== "BLOCKED_DUPLICATE",
          "the 4.00 second pass is NOT BLOCKED_DUPLICATE — the 2026-08-03 defect, reproduced as a test"),
      ].every(Boolean) && allOk;

    /**
     * An IMMEDIATE readiness capture, which is exactly the request that failed in production.
     */
    console.log("\n[5c/6] immediate readiness capture at 4.00\n");
    const readiness = await post("4.00", `v3-readiness-${DEADLINE}`);
    allOk =
      [
        check(readiness.outcome === "APPROVED_AUTOMATIC",
          `readiness 4.00 → ${String(readiness.outcome)} / ${String(readiness.engineDecision)}`),
        check(readiness.engineDecision !== "BLOCKED_DUPLICATE",
          "readiness is not blocked by the validations that preceded it"),
      ].every(Boolean) && allOk;

    const decisionStateAfterAll = await decisionCounts();
    allOk =
      check(
        JSON.stringify(decisionStateAfterAll) === JSON.stringify(decisionStateAfterFirstPass) &&
          decisionStateAfterAll.recentIntents === "0" &&
          decisionStateAfterAll.rateTicks === "0" &&
          decisionStateAfterAll.replayMarkers === "0" &&
          decisionStateAfterAll.dailySpend === "0",
        `decision state unchanged and empty after seven rolled-back evaluations (${JSON.stringify(decisionStateAfterAll)})`,
      ) && allOk;

    // ── nothing was written ─────────────────────────────────────────────────
    console.log("\n[6/6] the database, before and after\n");
    const after = await tableCounts(pool);
    const drifted = Object.keys(after).filter((t) => after[t] !== before[t]);
    for (const t of drifted) {
      console.log(`      ❌ ${t}: ${before[t]} → ${after[t]}`);
    }
    allOk =
      check(drifted.length === 0, `every table has the same row count as before (${Object.keys(after).length} tables checked)`) &&
      allOk;

    const artifact = {
      proof: "v3-direct-account-boundary",
      at: new Date().toISOString(),
      billed: false,
      persisted: false,
      paymentsMade: 0,
      accountRefHash: accountRefHash(account.accountId),
      walletAuthorityRef: expectedAuthority,
      policyId,
      policyHash: policy.policyHash,
      cases: results,
      secondPass,
      readiness: { outcome: readiness.outcome, engineDecision: readiness.engineDecision },
      decisionStateAfterFirstPass,
      decisionStateAfterAll,
      tablesChecked: Object.keys(after).length,
      tablesWithDrift: drifted,
    };
    console.log("\n" + JSON.stringify(artifact, null, 2));

    if (!allOk) fail("one or more assertions did not hold — see the ❌ lines above");
    console.log("\nRESULT: PASS — V3 direct-account evidence produced across the real boundary, nothing persisted, nothing paid.");
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await pool.end().catch(() => undefined);
    await policyPool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  fail((err as Error).stack ?? (err as Error).message);
});
