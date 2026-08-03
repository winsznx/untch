import assert from "node:assert/strict";
import { test } from "node:test";
import { X_LAYER_TESTNET_ID } from "@untch/shared";
import { hashSpendIntent, hashCanonicalJson, type SpendIntent } from "@untch/canon";
import { PerAgentLock, evaluateIntentSerialized, ledgerPartitionKey } from "@untch/policy-engine";
import {
  InMemoryPolicyRepo,
  parsePolicyRules,
  PolicyProvider,
  toEnginePolicy,
  type StoredPolicy,
} from "@untch/policy-store";
import type { Address, Hex } from "viem";
import {
  handleCreateSpendIntent,
  handlePreflightPayment,
  type PreflightDeps,
} from "../src/handlers";
import { InMemoryIntentStore, InMemoryLedger } from "../src/ledger-state";
import { parseFullIntent } from "../src/intent";

/**
 * Unit tests for the two buyer-facing handlers, now backed by a REAL stored policy (via an in-memory
 * PolicyRepo + PolicyProvider) instead of the removed fixture. Deterministic, NO network: they drive
 * the REAL `@untch/policy-engine` through the handlers with a fixed clock and isolated state, and
 * assert the handler surfaces the engine's decision unchanged AND that it evaluated the STORED policy.
 */

const NOW = Date.parse("2026-07-09T12:00:00Z");
const now = (): number => NOW;
const TODAY = new Date(NOW).toISOString().slice(0, 10);

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const AGENT = "0x000000000000000000000000000000000000A9E7" as Address;
const TOKEN = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736" as Address;
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const b32 = (byte: string): Hex => `0x${byte.repeat(32)}` as Hex;
const TASK_HASH = b32("11");
const PARAMS_HASH = b32("55");
const ENDPOINT = "https://api.example.com/v1/data?b=2&a=1";

const POLICY_ID = "1";
/** Baseline demo ruleset (allows market-data/security/research; $1 per-call cap; ESCALATE over cap). */
function baseRules(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    budgets: { daily: 25, token: "USDT" },
    perCallCap: 1.0,
    onPerCallCapExceeded: "ESCALATE",
    escalateAbove: 5.0,
    categories: { allow: ["market-data", "security", "research"], deny: [] },
    recipients: { allow: [], deny: [] },
    agents: { allowWorkerIds: [], denyWorkerIds: [] },
    duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
    cooldowns: { sameServiceMin: 5 },
    rateLimit: { callsPerHour: 40 },
    expiry: "2026-12-31T00:00:00Z",
    ...overrides,
  };
}

function storedPolicy(id: string, rules: Record<string, unknown>): StoredPolicy {
  const policyHash = hashCanonicalJson(rules);
  return {
    id,
    owner: OWNER,
    agentId: AGENT,
    version: 1,
    status: "ACTIVE",
    policyHash,
    expiry: Math.floor(Date.parse((rules.expiry as string)) / 1000),
    onchainRef: {
      chainId: X_LAYER_TESTNET_ID,
      registry: "0xe1d74c90801db0fa806c72eb818b7671b8233532",
      registerTx: b32("ab"),
      registerBlock: 1,
      lastTx: b32("ab"),
      lastBlock: 1,
    },
    rules: parsePolicyRules(rules),
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

/** A provider seeded with the baseline policy under POLICY_ID; extra policies can be added. */
function seededProvider(extra: StoredPolicy[] = []): { provider: PolicyProvider; hash: Hex } {
  const repo = new InMemoryPolicyRepo();
  const base = storedPolicy(POLICY_ID, baseRules());
  void repo.insert(base);
  for (const p of extra) void repo.insert(p);
  return { provider: new PolicyProvider(repo), hash: base.policyHash };
}

const BASE_HASH = hashCanonicalJson(baseRules());

/** A JSON wire intent that APPROVES under the baseline policy, bound to it by policyHash. */
function wireIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: OWNER,
    buyerAgentId: "1",
    workerAgentId: "0",
    token: TOKEN,
    maxAmount: "1000000",
    taskHash: TASK_HASH,
    acceptanceHash: b32("22"),
    schemaHash: b32("33"),
    policyHash: BASE_HASH,
    deadline: "9999999999",
    nonce: "1",
    endpoint: ENDPOINT,
    paramsHash: PARAMS_HASH,
    recipientAddress: RECIPIENT,
    category: "market-data",
    amount: 0.05,
    ...overrides,
  };
}

function freshPreflightDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    policyProvider: seededProvider().provider,
    ledger: new InMemoryLedger(now),
    intentStore: new InMemoryIntentStore(),
    now,
    lock: new PerAgentLock(),
    ...overrides,
  };
}

// ── create_spend_intent ──────────────────────────────────────────────────────

test("create_spend_intent: valid intent bound to the stored policy → 200 with canon intentHash", async () => {
  const store = new InMemoryIntentStore();
  const res = await handleCreateSpendIntent(
    { ...wireIntent(), policyId: POLICY_ID },
    { intentStore: store, policyProvider: seededProvider().provider },
  );

  assert.equal(res.status, 200);
  const body = res.body as {
    intentHash: Hex;
    canonicalIntent: { struct: Record<string, unknown> };
    policyId: string;
    onchain: { registered: boolean; status: string };
  };

  const expectedStruct: SpendIntent = {
    owner: OWNER.toLowerCase() as Address,
    buyerAgentId: 1n,
    workerAgentId: 0n,
    token: TOKEN.toLowerCase() as Address,
    maxAmount: 1_000_000n,
    taskHash: TASK_HASH,
    acceptanceHash: b32("22"),
    schemaHash: b32("33"),
    policyHash: BASE_HASH,
    deadline: 9_999_999_999n,
    nonce: 1n,
  };
  assert.equal(body.intentHash, hashSpendIntent(expectedStruct));
  assert.equal(body.policyId, POLICY_ID);
  // No writer key in unit tests → honest unwired (never a silent null lie).
  assert.equal(body.onchain.registered, false);
  assert.equal(body.onchain.status, "unwired");
  assert.ok(store.get(body.intentHash));
});

test("create_spend_intent: missing policyId → 400 POLICY_ID_REQUIRED", async () => {
  const res = await handleCreateSpendIntent(wireIntent(), {
    intentStore: new InMemoryIntentStore(),
    policyProvider: seededProvider().provider,
  });
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "POLICY_ID_REQUIRED");
});

test("create_spend_intent: policyId not in store → 404 POLICY_NOT_FOUND", async () => {
  const res = await handleCreateSpendIntent(
    { ...wireIntent(), policyId: "424242" },
    { intentStore: new InMemoryIntentStore(), policyProvider: seededProvider().provider },
  );
  assert.equal(res.status, 404);
  assert.equal((res.body as { code: string }).code, "POLICY_NOT_FOUND");
});

test("create_spend_intent: intent bound to a different policy hash → 400 POLICY_BINDING_MISMATCH", async () => {
  const res = await handleCreateSpendIntent(
    { ...wireIntent({ policyHash: b32("de") }), policyId: POLICY_ID },
    { intentStore: new InMemoryIntentStore(), policyProvider: seededProvider().provider },
  );
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "POLICY_BINDING_MISMATCH");
});

test("create_spend_intent: malformed intent → 400 §11 error envelope, nothing hashed", async () => {
  const store = new InMemoryIntentStore();
  const res = await handleCreateSpendIntent(
    { ...wireIntent({ maxAmount: 1000000, owner: "not-an-address" }), policyId: POLICY_ID },
    { intentStore: store, policyProvider: seededProvider().provider },
  );
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "INTENT_MALFORMED");
});

// ── preflight_payment: decision paths against the STORED policy ───────────────

test("preflight_payment: clean intent → APPROVED (evaluated against the stored policy)", async () => {
  const res = await handlePreflightPayment({ intent: wireIntent(), policyId: POLICY_ID }, freshPreflightDeps());
  assert.equal(res.status, 200);
  const body = res.body as { decision: string; policyId: string; receiptRef: null; sig: null; ruleTrace: unknown[] };
  assert.equal(body.decision, "APPROVED");
  assert.equal(body.policyId, POLICY_ID); // the engine reports the stored policy's id
  assert.equal(body.receiptRef, null);
  assert.equal(body.sig, null);
  assert.ok(Array.isArray(body.ruleTrace) && body.ruleTrace.length > 0);
});

test("preflight_payment: missing policyId → 400 POLICY_ID_REQUIRED", async () => {
  const res = await handlePreflightPayment({ intent: wireIntent() }, freshPreflightDeps());
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "POLICY_ID_REQUIRED");
});

test("preflight_payment: unknown policyId → BLOCKED_NO_ACTIVE_POLICY (fail-closed, I2)", async () => {
  // Intent bound to a hash with no matching stored policy; the engine gets a null policy.
  const res = await handlePreflightPayment(
    { intent: wireIntent({ policyHash: b32("de") }), policyId: "424242" },
    freshPreflightDeps(),
  );
  assert.equal(res.status, 200);
  assert.equal((res.body as { decision: string }).decision, "BLOCKED_NO_ACTIVE_POLICY");
});

test("preflight_payment: intent bound to a different policy than requested → 400 POLICY_BINDING_MISMATCH", async () => {
  const res = await handlePreflightPayment(
    { intent: wireIntent({ policyHash: b32("de") }), policyId: POLICY_ID },
    freshPreflightDeps(),
  );
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "POLICY_BINDING_MISMATCH");
});

test("preflight_payment: paused stored policy → BLOCKED_NO_ACTIVE_POLICY", async () => {
  const repo = new InMemoryPolicyRepo();
  const paused: StoredPolicy = { ...storedPolicy(POLICY_ID, baseRules()), status: "PAUSED" };
  void repo.insert(paused);
  const res = await handlePreflightPayment(
    { intent: wireIntent(), policyId: POLICY_ID },
    freshPreflightDeps({ policyProvider: new PolicyProvider(repo) }),
  );
  assert.equal((res.body as { decision: string }).decision, "BLOCKED_NO_ACTIVE_POLICY");
});

test("preflight_payment: over-daily-budget → BLOCKED_BUDGET", async () => {
  const ledger = new InMemoryLedger(now);
  ledger.seed(ledgerPartitionKey(POLICY_ID), { reservedByDay: new Map([[TODAY, 25]]) });
  const res = await handlePreflightPayment(
    { intent: wireIntent(), policyId: POLICY_ID },
    freshPreflightDeps({ ledger }),
  );
  assert.equal((res.body as { decision: string }).decision, "BLOCKED_BUDGET");
});

test("preflight_payment: repeat of a recent intent → BLOCKED_DUPLICATE", async () => {
  const ledger = new InMemoryLedger(now);
  ledger.seed(ledgerPartitionKey(POLICY_ID), {
    recentIntents: [
      { intentId: "pi_prior", taskHash: TASK_HASH, endpoint: ENDPOINT, paramsHash: PARAMS_HASH, createdAtMs: NOW - 60_000 },
    ],
  });
  const res = await handlePreflightPayment(
    { intent: wireIntent(), policyId: POLICY_ID },
    freshPreflightDeps({ ledger }),
  );
  assert.equal((res.body as { decision: string }).decision, "BLOCKED_DUPLICATE");
});

test("preflight_payment: over per-call cap with onPerCallCapExceeded=ESCALATE → ESCALATED_PER_CALL_CAP", async () => {
  const res = await handlePreflightPayment(
    { intent: wireIntent({ amount: 2.0, maxAmount: "5000000" }), policyId: POLICY_ID },
    freshPreflightDeps(),
  );
  assert.equal((res.body as { decision: string }).decision, "ESCALATED_PER_CALL_CAP");
});

// ── §7.2 escalation gateway wiring (server-side create on ESCALATED_*) ──────────

test("preflight_payment: an ESCALATED_* decision drives the escalation gateway with the guard's pollRef", async () => {
  // #given a receiptRef (so pollRef must be receiptRef.receiptId, exactly what the guard poll() computes)
  const receiptId = b32("f1") as Hex;
  const calls: Array<{ pollRef: string; reason: string; amount: number; intentHash: string }> = [];
  const escalationGateway = {
    async onEscalated(args: {
      input: { amount: number };
      decision: { decision: string; intentHash: string };
      stored: StoredPolicy;
      pollRef: string;
    }): Promise<void> {
      calls.push({
        pollRef: args.pollRef,
        reason: args.decision.decision,
        amount: args.input.amount,
        intentHash: args.decision.intentHash,
      });
    },
  };
  const receiptEnqueuer = {
    async enqueue(): Promise<{ receiptId: Hex; status: "QUEUED" }> {
      return { receiptId, status: "QUEUED" };
    },
  } as unknown as PreflightDeps["receiptEnqueuer"];

  // #when an over-cap intent escalates
  const res = await handlePreflightPayment(
    { intent: wireIntent({ amount: 2.0, maxAmount: "5000000" }), policyId: POLICY_ID },
    freshPreflightDeps({ escalationGateway, ...(receiptEnqueuer ? { receiptEnqueuer } : {}) }),
  );

  // #then the decision escalated AND the gateway was called once with pollRef == receiptId
  assert.equal((res.body as { decision: string }).decision, "ESCALATED_PER_CALL_CAP");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.pollRef, receiptId, "pollRef must equal receiptRef.receiptId (guard poll key)");
  assert.equal(calls[0]!.reason, "ESCALATED_PER_CALL_CAP");
  assert.equal(calls[0]!.amount, 2.0);
});

test("preflight_payment: a NON-escalated (APPROVED) decision never calls the escalation gateway", async () => {
  let called = 0;
  const escalationGateway = {
    async onEscalated(): Promise<void> {
      called++;
    },
  };
  const res = await handlePreflightPayment(
    { intent: wireIntent(), policyId: POLICY_ID },
    freshPreflightDeps({ escalationGateway }),
  );
  assert.equal((res.body as { decision: string }).decision, "APPROVED");
  assert.equal(called, 0, "an approval is not an escalation — the gateway must stay untouched");
});

// ── the stored policy really drives the decision (non-coincidence, like the e2e) ──

test("preflight_payment: the STORED policy's rules drive the outcome, not any default", async () => {
  // A second policy that allows ONLY 'logistics' (a category the baseline denies).
  const logisticsRules = baseRules({ categories: { allow: ["logistics"], deny: [] } });
  const logistics = storedPolicy("2", logisticsRules);
  const { provider } = seededProvider([logistics]);

  // #given an intent bound to policy 2 with category logistics → APPROVED (only policy 2 allows it).
  const approve = await handlePreflightPayment(
    { intent: wireIntent({ policyHash: logistics.policyHash, category: "logistics" }), policyId: "2" },
    freshPreflightDeps({ policyProvider: provider }),
  );
  assert.equal((approve.body as { decision: string }).decision, "APPROVED");

  // #and the SAME policy 2 blocks a market-data intent (its allow-list excludes it) → proves policy 2's
  //  own rules were used, not the baseline market-data allow-list.
  const block = await handlePreflightPayment(
    { intent: wireIntent({ policyHash: logistics.policyHash, category: "market-data" }), policyId: "2" },
    freshPreflightDeps({ policyProvider: provider }),
  );
  assert.equal((block.body as { decision: string }).decision, "BLOCKED_CATEGORY");
});

// ── the "no alteration" guarantee ─────────────────────────────────────────────

test("preflight_payment surfaces evaluateIntentSerialized's decision/reasons/trace VERBATIM", async () => {
  const wire = wireIntent();
  const { input } = parseFullIntent(wire);
  const enginePolicy = toEnginePolicy(storedPolicy(POLICY_ID, baseRules()));

  const engineDecision = await evaluateIntentSerialized(input, enginePolicy, new InMemoryLedger(now), {
    now,
    lock: new PerAgentLock(),
  });

  const res = await handlePreflightPayment({ intent: wire, policyId: POLICY_ID }, freshPreflightDeps());
  const body = res.body as { decision: string; reasons: unknown; ruleTrace: unknown; intentHash: Hex };

  assert.equal(body.decision, engineDecision.decision);
  assert.deepEqual(body.reasons, engineDecision.reasons);
  assert.deepEqual(body.ruleTrace, engineDecision.rules);
  assert.equal(body.intentHash, engineDecision.intentHash);
});

// ── create → preflight handoff by intentHash ──────────────────────────────────

test("create_spend_intent → preflight_payment by intentHash resolves + APPROVES", async () => {
  const store = new InMemoryIntentStore();
  const provider = seededProvider().provider;
  const created = await handleCreateSpendIntent(
    { ...wireIntent(), policyId: POLICY_ID },
    { intentStore: store, policyProvider: provider },
  );
  const intentHash = (created.body as { intentHash: Hex }).intentHash;

  const res = await handlePreflightPayment(
    { intentHash, policyId: POLICY_ID },
    freshPreflightDeps({ intentStore: store, policyProvider: provider }),
  );
  assert.equal((res.body as { decision: string }).decision, "APPROVED");
});

test("preflight_payment: unknown intentHash → 404 (no registry yet), honest and retryable=false", async () => {
  const res = await handlePreflightPayment({ intentHash: b32("ab"), policyId: POLICY_ID }, freshPreflightDeps());
  assert.equal(res.status, 404);
  assert.equal((res.body as { code: string }).code, "INTENT_NOT_FOUND");
});

test("preflight_payment: intentHash + inline intent that disagree → 400 INTENT_HASH_MISMATCH", async () => {
  const res = await handlePreflightPayment(
    { intentHash: b32("ab"), intent: wireIntent(), policyId: POLICY_ID },
    freshPreflightDeps(),
  );
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "INTENT_HASH_MISMATCH");
});

test("preflight_payment: neither intentHash nor intent → 400 INTENT_REQUIRED", async () => {
  const res = await handlePreflightPayment({ policyId: POLICY_ID }, freshPreflightDeps());
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "INTENT_REQUIRED");
});

// ── MULTI-TENANCY: two policies (different owners) that collide on buyerAgentId stay isolated ──
//
// Every intent below carries the ubiquitous buyerAgentId "1" — the exact value the ledger used to key
// on. Two DIFFERENT owners' policies (distinct on-chain policyIds) must therefore NOT share budget,
// duplicate detection, cooldown clocks, or the rate window. Each test drives the REAL handler + REAL
// InMemoryLedger through a shared deps bundle, so a spend/dup/cooldown/rate event under one policy is
// asserted NOT to affect the other, while each policy's OWN limit is still enforced under the new key.

const OWNER_B = "0xB0bB0000000000000000000000000000000000bB" as Address;
const POLICY_A = "9001";
const POLICY_B = "9002";

/** Shared deps carrying two policies that differ only by owner + policyId (same rules ⇒ same hash),
 *  a single shared ledger + lock so cross-policy leakage would be observable if the key were wrong. */
function collisionDeps(rules: Record<string, unknown> = baseRules()): { deps: PreflightDeps; hash: Hex } {
  const repo = new InMemoryPolicyRepo();
  void repo.insert({ ...storedPolicy(POLICY_A, rules), owner: OWNER });
  void repo.insert({ ...storedPolicy(POLICY_B, rules), owner: OWNER_B });
  return {
    deps: {
      policyProvider: new PolicyProvider(repo),
      ledger: new InMemoryLedger(now),
      intentStore: new InMemoryIntentStore(),
      now,
      lock: new PerAgentLock(),
    },
    hash: hashCanonicalJson(rules),
  };
}

const decOf = (res: { body: unknown }): string => (res.body as { decision: string }).decision;

test("multi-tenancy budget: colliding buyerAgentId — one policy's spend never touches the other's budget", async () => {
  // daily 25 each, with per-call cap + escalate threshold well above 20 so budget is the discriminator
  const { deps, hash } = collisionDeps(baseRules({ perCallCap: 1000, escalateAbove: 1000 }));
  const BIG_MAX = "1000000000"; // 1000 USDT ceiling so the intent-bound rule is not the discriminator
  // #given policy A spends 20 (APPROVED)
  const a1 = await handlePreflightPayment(
    { intent: wireIntent({ policyHash: hash, amount: 20, maxAmount: BIG_MAX, taskHash: b32("a1"), paramsHash: b32("a1"), endpoint: "https://svc-a1.example/x", nonce: "1" }), policyId: POLICY_A },
    deps,
  );
  assert.equal(decOf(a1), "APPROVED");
  // #when policy B (different owner, same buyerAgentId) spends 20 against ITS own fresh budget
  const b1 = await handlePreflightPayment(
    { intent: wireIntent({ policyHash: hash, amount: 20, maxAmount: BIG_MAX, taskHash: b32("b1"), paramsHash: b32("b1"), endpoint: "https://svc-b1.example/y", nonce: "1" }), policyId: POLICY_B },
    deps,
  );
  // #then B approves — A's 20 did not eat B's budget (a shared "1" bucket would be 40 > 25 → BLOCKED)
  assert.equal(decOf(b1), "APPROVED", "B's daily budget is independent of A's spend");
  // #and A's OWN budget is still enforced: another 20 on A (fresh service, not a duplicate) → 40 > 25
  const a2 = await handlePreflightPayment(
    { intent: wireIntent({ policyHash: hash, amount: 20, maxAmount: BIG_MAX, taskHash: b32("a2"), paramsHash: b32("a2"), endpoint: "https://svc-a2.example/z", nonce: "2" }), policyId: POLICY_A },
    deps,
  );
  assert.equal(decOf(a2), "BLOCKED_BUDGET", "A's own daily budget still enforced under the partition key");
});

test("multi-tenancy duplicate: a repeated intent under one policy does not block the twin under another", async () => {
  const { deps, hash } = collisionDeps();
  const shape = { policyHash: hash, amount: 0.05, taskHash: b32("dd"), paramsHash: b32("dd"), endpoint: "https://dup.example/p", nonce: "1" };
  // #given A submits an intent (APPROVED, recorded for dedup)
  assert.equal(decOf(await handlePreflightPayment({ intent: wireIntent(shape), policyId: POLICY_A }, deps)), "APPROVED");
  // #when B submits the SAME task/endpoint/params under its own policy
  const b = await handlePreflightPayment({ intent: wireIntent(shape), policyId: POLICY_B }, deps);
  // #then B approves — dedup state is per-policy, not shared across the colliding agent id
  assert.equal(decOf(b), "APPROVED", "duplicate detection is per-policy");
  // #and A still catches its OWN duplicate (dedup precedes cooldown in rule order)
  const aDup = await handlePreflightPayment({ intent: wireIntent(shape), policyId: POLICY_A }, deps);
  assert.equal(decOf(aDup), "BLOCKED_DUPLICATE", "A still detects its own duplicate under the partition key");
});

test("multi-tenancy cooldown: same-service cooldown under one policy does not cool down another", async () => {
  const { deps, hash } = collisionDeps();
  const host = "https://cool.example/a"; // one service host; cooldown is keyed by host
  // #given A calls the service (APPROVED, arms A's cooldown clock for that host)
  assert.equal(
    decOf(await handlePreflightPayment({ intent: wireIntent({ policyHash: hash, amount: 0.05, taskHash: b32("c1"), paramsHash: b32("c1"), endpoint: host, nonce: "1" }), policyId: POLICY_A }, deps)),
    "APPROVED",
  );
  // #when B calls the SAME service host under its own policy
  const b = await handlePreflightPayment({ intent: wireIntent({ policyHash: hash, amount: 0.05, taskHash: b32("c2"), paramsHash: b32("c2"), endpoint: host, nonce: "1" }), policyId: POLICY_B }, deps);
  // #then B approves — a shared cooldown clock would have BLOCKED_COOLDOWN
  assert.equal(decOf(b), "APPROVED", "cooldown clock is per-policy");
  // #and A hitting the same service again within cooldown IS blocked (its own clock intact)
  const a2 = await handlePreflightPayment({ intent: wireIntent({ policyHash: hash, amount: 0.05, taskHash: b32("c3"), paramsHash: b32("c3"), endpoint: host, nonce: "2" }), policyId: POLICY_A }, deps);
  assert.equal(decOf(a2), "BLOCKED_COOLDOWN", "A's own cooldown clock still enforced");
});

test("multi-tenancy rate limit: exhausting one policy's rate window does not throttle another", async () => {
  const { deps, hash } = collisionDeps(baseRules({ rateLimit: { callsPerHour: 1 } }));
  // #given A uses its single hourly call
  assert.equal(
    decOf(await handlePreflightPayment({ intent: wireIntent({ policyHash: hash, amount: 0.05, taskHash: b32("e1"), paramsHash: b32("e1"), endpoint: "https://rl-a1.example/1", nonce: "1" }), policyId: POLICY_A }, deps)),
    "APPROVED",
  );
  // #and A's next call is rate-limited (own window full)
  const a2 = await handlePreflightPayment({ intent: wireIntent({ policyHash: hash, amount: 0.05, taskHash: b32("e2"), paramsHash: b32("e2"), endpoint: "https://rl-a2.example/1", nonce: "2" }), policyId: POLICY_A }, deps);
  assert.equal(decOf(a2), "BLOCKED_RATE", "A's own rate window still enforced");
  // #when B makes its first call while A is throttled
  const b1 = await handlePreflightPayment({ intent: wireIntent({ policyHash: hash, amount: 0.05, taskHash: b32("e3"), paramsHash: b32("e3"), endpoint: "https://rl-b1.example/1", nonce: "1" }), policyId: POLICY_B }, deps);
  // #then B approves — the rate window is per-policy, not shared across the colliding agent id
  assert.equal(decOf(b1), "APPROVED", "B's rate window is independent of A's exhaustion");
});
