import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashCanonicalJson } from "@untch/canon";
import { ledgerPartitionKey, PerAgentLock } from "@untch/policy-engine";
import {
  InMemoryPolicyRepo,
  parsePolicyRules,
  PolicyProvider,
  X_LAYER_TESTNET_ID,
  type StoredPolicy,
} from "@untch/policy-store";
import {
  encodePacked,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { handlePreflightPayment, type PreflightDeps } from "./handlers";
import { InMemoryIntentStore, InMemoryLedger } from "./ledger-state";

/**
 * MULTI-TENANCY PARTITION-ISOLATION END-TO-END PROOF.
 *
 * The fix under proof: per-caller ephemeral preflight state (budget window, rate limit,
 * duplicate/cooldown clocks, and the serialization lock) is partitioned by POLICY ID, never by the
 * raw `buyerAgentId`. Two different owners whose agents collide on the ubiquitous `buyerAgentId` "1"
 * must therefore spend against GENUINELY INDEPENDENT budgets.
 *
 * What is real here: the REAL `handlePreflightPayment` handler → REAL `@untch/policy-engine` serialized
 * evaluation (per-partition lock → read ledger → evaluate → commit) → REAL in-memory `InMemoryLedger`,
 * wired exactly as `server.ts` wires them. Two policies with DELIBERATELY IDENTICAL `buyerAgentId` "1"
 * but DISTINCT on-chain policyIds — each id derived with the exact on-chain formula
 * `uint256(keccak256(abi.encodePacked(owner, ownerNonce)))` from two different real owner addresses —
 * spend 20 SIMULTANEOUSLY against their own daily-25 budgets. The proof asserts both APPROVE (a shared
 * "1" bucket would sum to 40 > 25 and block one), each partition's committed spend is read back to
 * confirm no leakage, and each policy's OWN budget is still independently enforced.
 *
 * SCOPE (honest boundary): this proves the in-process partition boundary — exactly the surface the fix
 * changes. It does NOT re-prove x402 settlement (see `run-preflight-proof.ts`) or on-chain per-caller
 * OWNERSHIP (see `run-multi-tenant-policy-proof.ts`), which are orthogonal and proven separately.
 * Durability / cross-instance sharing of this ledger window remains a separate, already-accepted future
 * item (§7.1 distributed lock + Redis/Postgres backstop), NOT touched here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(here, "..", "..", "..", "internal", "multi-tenancy");
const NOW = Date.parse("2026-07-13T12:00:00Z");
const now = (): number => NOW;
const TODAY = new Date(NOW).toISOString().slice(0, 10);

const TOKEN = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736" as Address;
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const AGENT = getAddress("0x000000000000000000000000000000000000A9E7");
const DAILY = 25;
const SPEND = 20;
const b32 = (byte: string): Hex => `0x${byte.repeat(32)}` as Hex;

function save(name: string, data: unknown): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = resolve(EVIDENCE_DIR, name);
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n";
  writeFileSync(path, text);
  return path;
}

/** The exact on-chain identity: uint256(keccak256(abi.encodePacked(owner, ownerNonce))). */
function derivePolicyId(owner: Address, ownerNonce: bigint): string {
  return BigInt(keccak256(encodePacked(["address", "uint256"], [owner, ownerNonce]))).toString();
}

/** Two owners' shared ruleset — same rules, different owner ⇒ different policyId is the whole point. */
function rules(): Record<string, unknown> {
  return {
    budgets: { daily: DAILY, token: "USDT" },
    perCallCap: 1000,
    onPerCallCapExceeded: "BLOCK",
    escalateAbove: 1000,
    categories: { allow: ["market-data"], deny: [] },
    recipients: { allow: [], deny: [] },
    agents: { allowWorkerIds: [], denyWorkerIds: [] },
    duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
    cooldowns: { sameServiceMin: 5 },
    rateLimit: { callsPerHour: 40 },
    expiry: "2027-12-31T00:00:00Z",
  };
}

function storedPolicy(id: string, owner: Address, r: Record<string, unknown>): StoredPolicy {
  return {
    id,
    owner,
    agentId: AGENT,
    version: 1,
    status: "ACTIVE",
    policyHash: hashCanonicalJson(r),
    expiry: Math.floor(Date.parse(r.expiry as string) / 1000),
    onchainRef: {
      chainId: X_LAYER_TESTNET_ID,
      registry: "0xe1d74c90801db0fa806c72eb818b7671b8233532",
      registerTx: b32("ab"),
      registerBlock: 1,
      lastTx: b32("ab"),
      lastBlock: 1,
    },
    rules: parsePolicyRules(r),
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

/** A spend intent carrying the COLLIDING buyerAgentId "1", bound to `policyHash`, spending `amount`.
 *  `nonce` must be a uint; `tag` only labels the unique taskHash/endpoint so calls are not duplicates. */
function intent(policyHash: Hex, tag: string, nonce: number, amount: number): Record<string, unknown> {
  return {
    owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    buyerAgentId: "1", // the ubiquitous value that used to collapse tenants into one bucket
    workerAgentId: "0",
    token: TOKEN,
    maxAmount: "1000000000", // 1000 USDT ceiling — the intent-bound rule is not the discriminator
    taskHash: keccak256(`0x${Buffer.from(`task:${tag}`).toString("hex")}` as Hex),
    acceptanceHash: b32("22"),
    schemaHash: b32("33"),
    policyHash,
    deadline: "9999999999",
    nonce: String(nonce),
    endpoint: `https://${tag.toLowerCase()}.vendor.example/x`, // distinct host per call ⇒ cooldown is not the discriminator
    paramsHash: keccak256(`0x${Buffer.from(`params:${tag}`).toString("hex")}` as Hex),
    recipientAddress: RECIPIENT,
    category: "market-data",
    amount,
  };
}

function decisionOf(res: { body: unknown }): string {
  const body = res.body as { decision?: string; code?: string };
  return body.decision ?? `ERROR:${body.code ?? "unknown"}`;
}

async function main(): Promise<void> {
  // Two REAL, distinct policies (different owners ⇒ different on-chain policyId), IDENTICAL rules.
  const ownerA = getAddress("0x1111111111111111111111111111111111111111");
  const ownerB = getAddress("0x2222222222222222222222222222222222222222");
  const r = rules();
  const policyIdA = derivePolicyId(ownerA, 0n);
  const policyIdB = derivePolicyId(ownerB, 0n);
  if (policyIdA === policyIdB) throw new Error("policyId derivation collided — impossible for distinct owners");

  const policyHash = hashCanonicalJson(r) as Hex;
  const keyA = ledgerPartitionKey(policyIdA);
  const keyB = ledgerPartitionKey(policyIdB);

  const repo = new InMemoryPolicyRepo();
  await repo.insert(storedPolicy(policyIdA, ownerA, r));
  await repo.insert(storedPolicy(policyIdB, ownerB, r));

  // ONE shared ledger + lock + provider — exactly as the running server wires them, so cross-tenant
  // leakage would be observable if the partition key were wrong.
  const ledger = new InMemoryLedger(now);
  const deps: PreflightDeps = {
    policyProvider: new PolicyProvider(repo),
    ledger,
    intentStore: new InMemoryIntentStore(),
    now,
    lock: new PerAgentLock(),
  };

  console.log("[proof] partition-isolation — two policies colliding on buyerAgentId '1'");
  console.log(`[proof] owner A ${ownerA} → policyId ${policyIdA}`);
  console.log(`[proof] owner B ${ownerB} → policyId ${policyIdB}`);
  console.log(`[proof] partition keys: A=${keyA}  B=${keyB}  (distinct: ${keyA !== keyB})`);
  console.log(`[proof] each spends ${SPEND} against its OWN daily-${DAILY} budget, SIMULTANEOUSLY`);

  // #when both spend 20 at the same time through the REAL handler
  const [resA, resB] = await Promise.all([
    handlePreflightPayment({ intent: intent(policyHash, "A-spend", 1, SPEND), policyId: policyIdA }, deps),
    handlePreflightPayment({ intent: intent(policyHash, "B-spend", 1, SPEND), policyId: policyIdB }, deps),
  ]);
  const decA = decisionOf(resA);
  const decB = decisionOf(resB);

  // Read the reserved authority back from each partition (public read on the real ledger).
  // It is authority, not spend: this route decides and settles nothing.
  const spentA = ledger.read(keyA).budgetUsage.effectiveToday;
  const spentB = ledger.read(keyB).budgetUsage.effectiveToday;

  // #then each policy's OWN budget is still independently enforced — a second 20 overspends 25.
  const resAover = await handlePreflightPayment(
    { intent: intent(policyHash, "A-over", 2, SPEND), policyId: policyIdA },
    deps,
  );
  const resBover = await handlePreflightPayment(
    { intent: intent(policyHash, "B-over", 2, SPEND), policyId: policyIdB },
    deps,
  );
  const decAover = decisionOf(resAover);
  const decBover = decisionOf(resBover);

  const bothApproved = decA === "APPROVED" && decB === "APPROVED";
  const noLeak = spentA === SPEND && spentB === SPEND;
  const ownBudgetEnforced = decAover === "BLOCKED_BUDGET" && decBover === "BLOCKED_BUDGET";
  const distinctKeys = keyA !== keyB;
  const pass = bothApproved && noLeak && ownBudgetEnforced && distinctKeys;

  const proof = {
    meta: {
      title: "Multi-tenancy partition-isolation proof (policyId, not buyerAgentId)",
      capturedAt: new Date(NOW).toISOString(),
      day: TODAY,
      scope:
        "In-process REAL handler + REAL policy engine + REAL InMemoryLedger. x402 settlement and on-chain ownership are proven separately.",
    },
    policies: {
      A: { owner: ownerA, policyId: policyIdA, partitionKey: keyA, policyHash },
      B: { owner: ownerB, policyId: policyIdB, partitionKey: keyB, policyHash },
      sharedBuyerAgentId: "1",
      dailyBudget: DAILY,
    },
    simultaneousSpend: {
      each: SPEND,
      A: { decision: decA, committedSpend: spentA },
      B: { decision: decB, committedSpend: spentB },
    },
    ownBudgetStillEnforced: {
      "A second spend of 20 (40 > 25)": decAover,
      "B second spend of 20 (40 > 25)": decBover,
    },
    checks: { distinctKeys, bothApproved, noLeak, ownBudgetEnforced },
    result: pass ? "PASS" : "FAIL",
  };
  const jsonPath = save("partition-isolation-proof.json", proof);

  const transcript = [
    "# Multi-tenancy partition-isolation proof",
    "",
    `- **When:** ${proof.meta.capturedAt}`,
    "- **Fix:** per-caller ephemeral preflight state (budget / rate / duplicate / cooldown / lock) is",
    "  partitioned by **policyId**, never the raw `buyerAgentId`.",
    "- **Why policyId is the correct key:** `policies.id` (the on-chain",
    "  `uint256(keccak256(abi.encodePacked(owner, ownerNonce)))`) is the PRIMARY KEY and each policy row",
    "  governs exactly one agent via a single immutable `policies.agent_id` — so policyId already",
    "  determines the agent. Two different owners always get distinct policyIds even when their",
    "  `buyerAgentId` collides on the ubiquitous \"1\". A `(policyId, agentId)` compound key would be",
    "  redundant; policyId alone is correct and minimal.",
    "",
    "## Scenario — two owners colliding on `buyerAgentId` \"1\"",
    `- Owner A \`${ownerA}\` → policyId \`${policyIdA}\` → partition \`${keyA}\``,
    `- Owner B \`${ownerB}\` → policyId \`${policyIdB}\` → partition \`${keyB}\``,
    `- Distinct partition keys despite identical buyerAgentId: **${distinctKeys}**`,
    `- Each daily budget: ${DAILY}. Each spends ${SPEND} **simultaneously** (real Promise.all).`,
    "",
    "## Result",
    `- A decision: **${decA}** (committed spend ${spentA}) · B decision: **${decB}** (committed spend ${spentB})`,
    `- Both APPROVED (a shared \"1\" bucket would be ${SPEND * 2} > ${DAILY} → one BLOCKED): **${bothApproved}**`,
    `- No cross-tenant leak (each partition holds only its own ${SPEND}): **${noLeak}**`,
    `- Each policy's OWN budget still enforced (second 20 → BLOCKED_BUDGET): A=**${decAover}**, B=**${decBover}**`,
    "",
    `## ${pass ? "PASS" : "FAIL"}`,
    "",
    "Durability / cross-instance sharing of this in-memory window remains a separate, already-accepted",
    "future item (§7.1 distributed lock + Redis/Postgres backstop) — not in scope for this fix.",
    "",
    `Structured evidence: \`${jsonPath.split("/").slice(-1)[0]}\`.`,
    "",
  ].join("\n");
  const mdPath = save("partition-isolation-proof.md", transcript);

  console.log("");
  console.log(`[proof] A: ${decA} (spent ${spentA})   B: ${decB} (spent ${spentB})`);
  console.log(`[proof] own-budget re-check → A: ${decAover}   B: ${decBover}`);
  console.log(`[proof] checks: distinctKeys=${distinctKeys} bothApproved=${bothApproved} noLeak=${noLeak} ownBudgetEnforced=${ownBudgetEnforced}`);
  console.log("");
  if (pass) {
    console.log("RESULT: PASS — two colliding-buyerAgentId policies stay genuinely budget-independent.");
    console.log(`Evidence: ${jsonPath}`);
    console.log(`Transcript: ${mdPath}`);
    process.exit(0);
  }
  console.error("RESULT: FAIL — partition isolation not proven (see evidence).");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
