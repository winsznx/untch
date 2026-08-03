import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateIntent, type Policy } from "@untch/policy-engine";
import {
  createPool,
  loadOperatorConfig,
  PgPolicyRepo,
  PolicyProvider,
  PolicyService,
  runMigrations,
  ViemPolicyRegistry,
} from "@untch/policy-store";
import { getAddress, keccak256, toHex, type Address } from "viem";
import { handlePreflightPayment } from "./handlers";
import { InMemoryIntentStore, InMemoryLedger } from "./ledger-state";
import { parseFullIntent } from "./intent";

/**
 * POLICY-STORE END-TO-END PROOF (task 5) — the one that matters most for this component.
 *
 * A REAL create_spend_policy: a real testnet PolicyRegistry.registerPolicy tx signed by the interim
 * demo/burner operator wallet (0x98F43e…), whose policyId is the on-chain-derived keccak(owner,nonce),
 * stored durably in the SAME Railway Postgres the receipt writer uses. Then a REAL preflight_payment
 * (the actual handler, reading the actual stored policy from Postgres) that APPROVES an intent the OLD
 * fixture policy would have BLOCKED — proving the engine used the real stored policy, not any default.
 *
 * Non-coincidence by construction: the new policy allows category "logistics", which the fixture's
 * allow-list (market-data/security/research) did NOT. The same intent is evaluated against the OLD
 * fixture rules inline and comes back BLOCKED_CATEGORY, so the APPROVE could not be a coincidence.
 *
 * Requires OPERATOR_PRIVATE_KEY (the demo wallet, funded testnet OKB) + DATABASE_URL (the Railway
 * Postgres, e.g. its public proxy URL). TESTNET ONLY — loadOperatorConfig refuses mainnet by chain.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RECEIPT_PATH = resolve(here, "..", "..", "..", "contracts", "deploy", "policy-store-testnet-receipt.json");
const DEMO_AGENT: Address = getAddress("0x000000000000000000000000000000000000A9E7");

/** The OLD fixture allow-list — inlined ONLY to prove the contrast; it is no longer the live policy. */
const FIXTURE_CATEGORIES_ALLOW = ["market-data", "security", "research"];

/** Non-fixture demo rules: allows "logistics" (fixture did not), distinct caps. Same-instant expiry
 *  in on-chain uint64 and ISO so registry + engine agree. */
function demoRules(): Record<string, unknown> {
  return {
    budgets: { daily: 50, token: "USDT" },
    perCallCap: 2.0,
    onPerCallCapExceeded: "BLOCK",
    escalateAbove: 10.0,
    categories: { allow: ["logistics"], deny: [] },
    recipients: { allow: [], deny: [] },
    agents: { allowWorkerIds: [], denyWorkerIds: [] },
    duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
    cooldowns: { sameServiceMin: 5 },
    rateLimit: { callsPerHour: 40 },
    expiry: "2026-12-31T00:00:00Z",
  };
}

function fixtureContrastPolicy(): Policy {
  const rules = { ...demoRules(), categories: { allow: FIXTURE_CATEGORIES_ALLOW, deny: [] } };
  return { id: "fixture-contrast", version: 1, status: "ACTIVE", rules: rules as unknown as Policy["rules"] };
}

function save(data: unknown): string {
  mkdirSync(dirname(RECEIPT_PATH), { recursive: true });
  writeFileSync(RECEIPT_PATH, JSON.stringify(data, null, 2) + "\n");
  return RECEIPT_PATH;
}

function fail(msg: string): never {
  console.error(`\nRESULT: FAIL — ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const cfg = loadOperatorConfig();
  const pool = createPool(cfg.databaseUrl);
  try {
    const applied = await runMigrations(pool);
    if (applied.length > 0) console.log(`[policy-e2e] migrations applied: ${applied.join(", ")}`);

    const repo = new PgPolicyRepo(pool);
    const chain = new ViemPolicyRegistry({
      chain: cfg.chain,
      rpcUrl: cfg.rpcUrl,
      registry: cfg.registry,
      operatorPrivateKey: cfg.operatorPrivateKey,
    });
    const service = new PolicyService(repo, chain);
    const provider = new PolicyProvider(repo);

    console.log("── policy-store END-TO-END PROOF (TESTNET) ─────────────────────────────────");
    console.log(`operator (INTERIM demo wallet): ${chain.ownerAddress}`);
    console.log(`PolicyRegistry               : ${cfg.registry} (chainId ${chain.chainId})`);

    // Safety: refuse to broadcast under the wrong wallet. Set EXPECT_OPERATOR to the intended operator
    // (the demo wallet 0x98F43e…) and this aborts BEFORE spending gas if the supplied key derives a
    // different address — so pointing OPERATOR_PRIVATE_KEY at the wrong key can never mint a policy
    // under an unintended owner.
    const expect = process.env.EXPECT_OPERATOR?.trim();
    if (expect) {
      if (getAddress(expect) !== chain.ownerAddress) {
        fail(
          `operator wallet ${chain.ownerAddress} != EXPECT_OPERATOR ${getAddress(expect)} — refusing to broadcast under the wrong wallet`,
        );
      }
      console.log(`operator matches EXPECT_OPERATOR ✅ (${chain.ownerAddress})`);
    }

    const predicted = await chain.nextPolicyId();
    console.log(`predicted next policyId      : ${predicted}`);

    // 1) REAL create_spend_policy — real registerPolicy tx, real stored row.
    console.log("\n[1/4] create_spend_policy — real PolicyRegistry.registerPolicy …");
    const created = await service.createPolicy({ agent: DEMO_AGENT, rules: demoRules() });
    console.log(`      policyId ${created.policyId}`);
    console.log(`      policyHash ${created.policyHash}`);
    console.log(`      tx ${created.txHash} (block ${created.blockNumber})`);
    if (created.policyId !== predicted.toString()) {
      fail(`policyId drift: predicted ${predicted}, got ${created.policyId} (nonce/id inconsistency)`);
    }

    // 2) independent on-chain readback — the stored hash equals what the registry recorded.
    const onchain = await chain.getPolicy(BigInt(created.policyId));
    const onchainOk =
      onchain.policyHash.toLowerCase() === created.policyHash.toLowerCase() &&
      getAddress(onchain.agent) === DEMO_AGENT &&
      onchain.status === 1;
    console.log(`[2/4] on-chain readback matches: ${onchainOk} (status ${onchain.status}, v${onchain.version})`);
    if (!onchainOk) fail("on-chain policy does not match the stored/registered values");

    // 3) REAL preflight_payment through the actual handler, reading the REAL stored policy from Postgres.
    console.log("[3/4] preflight_payment against the real stored policy …");
    const runSalt = String(created.blockNumber);
    const intent = {
      owner: chain.ownerAddress,
      buyerAgentId: "1",
      workerAgentId: "0",
      token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      maxAmount: "5000000",
      taskHash: keccak256(toHex(`untch-policy-e2e-task:${runSalt}`)),
      acceptanceHash: keccak256(toHex("untch-policy-e2e-acceptance")),
      schemaHash: keccak256(toHex("untch-policy-e2e-schema")),
      policyHash: created.policyHash, // bind the intent to the freshly-created policy
      deadline: "9999999999",
      nonce: runSalt,
      endpoint: "https://api.vendor.example/v1/logistics?lane=OKB",
      paramsHash: keccak256(toHex(`untch-policy-e2e-params:${runSalt}`)),
      recipientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      category: "logistics", // allowed by the NEW policy, denied by the fixture
      amount: 0.5,
    };
    const preflight = await handlePreflightPayment(
      { intent, policyId: created.policyId },
      { policyProvider: provider, ledger: new InMemoryLedger(), intentStore: new InMemoryIntentStore() },
    );
    const decision = (preflight.body as { decision?: string; policyId?: string }).decision;
    console.log(`      decision: ${decision} (policyId in decision: ${(preflight.body as { policyId?: string }).policyId})`);

    // 4) contrast against the OLD fixture rules — the SAME intent would have been BLOCKED_CATEGORY.
    const { input } = parseFullIntent(intent);
    const contrast = evaluateIntent(input, fixtureContrastPolicy(), {
      budgetUsage: { settledToday: 0, reservedActiveToday: 0, effectiveToday: 0 },
      recentIntents: [],
      lastCallByService: {},
      callsInLastHour: 0,
    });
    console.log(`[4/4] same intent under the OLD fixture rules: ${contrast.decision}`);

    const usedStoredPolicy =
      preflight.status === 200 &&
      decision === "APPROVED" &&
      contrast.decision === "BLOCKED_CATEGORY";

    const receipt = {
      proof: "policy-store §6.2/§8/§10.1 end-to-end",
      network: "X Layer testnet",
      chainId: chain.chainId,
      policyRegistry: cfg.registry,
      operatorWallet: chain.ownerAddress,
      operatorWalletNote:
        "INTERIM demo/burner wallet — TEMPORARY stand-in for the operator's own dashboard-connected wallet (§15). NOT the permanent design. See services/asp/README.md → 'Operator signing'.",
      policyId: created.policyId,
      policyIdDerivation: "uint256(keccak256(abi.encodePacked(owner, ownerNonce))) — read from the confirmed PolicyRegistered event, not an off-chain counter",
      policyHash: created.policyHash,
      registerTx: created.txHash,
      registerBlock: created.blockNumber,
      version: created.version,
      agent: created.agentId,
      rules: demoRules(),
      onchainReadbackMatches: onchainOk,
      preflightDecision: decision,
      fixtureContrastDecision: contrast.decision,
      nonCoincidence:
        "The new policy allows category 'logistics'; the fixture allow-list did not. preflight APPROVED via the real stored policy while the same intent under the fixture rules is BLOCKED_CATEGORY — the stored policy provably drove the decision.",
      storedPolicyUsed: usedStoredPolicy,
      capturedAt: new Date().toISOString(),
      demoEnvForProofScripts: { DEMO_POLICY_ID: created.policyId, DEMO_POLICY_HASH: created.policyHash },
    };
    const path = save(receipt);

    console.log("\n=== RECEIPT (JSON) ===");
    console.log(JSON.stringify(receipt, null, 2));
    console.log(`\nReceipt: ${path}`);

    if (!usedStoredPolicy) {
      fail(`stored-policy proof incomplete (preflight=${decision}, fixtureContrast=${contrast.decision})`);
    }
    console.log("\nRESULT: PASS — real create_spend_policy tx + real preflight used the real stored policy.");
    console.log(`create_spend_policy tx: ${created.txHash}`);
    console.log(`policyId: ${created.policyId}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  fail(`unexpected error: ${(err as Error).message}`);
});
