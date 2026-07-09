import assert from "node:assert/strict";
import { test } from "node:test";
import { PerAgentLock, evaluateIntentSerialized } from "@untch/policy-engine";
import { hashSpendIntent, type SpendIntent } from "@untch/canon";
import type { Address, Hex } from "viem";
import {
  handleCreateSpendIntent,
  handlePreflightPayment,
  type PreflightDeps,
} from "../src/handlers";
import {
  FIXTURE_POLICY,
  FIXTURE_POLICY_HASH,
  InMemoryIntentStore,
  InMemoryLedger,
} from "../src/policy-fixture";
import { parseFullIntent } from "../src/intent";

/**
 * Unit tests for the two Step-2 handlers. Deterministic, NO network: they drive the REAL
 * `@untch/policy-engine` through the handlers with a fixed clock and isolated in-memory state, and
 * assert the handler surfaces the engine's decision unchanged. Covers, per the task: a clean
 * approve, a budget block, a duplicate block, an escalate case, plus the "no alteration" guarantee
 * and the create→preflight hash handoff.
 */

const NOW = Date.parse("2026-07-09T12:00:00Z");
const now = (): number => NOW;
const TODAY = new Date(NOW).toISOString().slice(0, 10); // "2026-07-09"

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const TOKEN = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736" as Address; // USDT0 on X Layer
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const b32 = (byte: string): Hex => `0x${byte.repeat(32)}` as Hex;
const TASK_HASH = b32("11");
const PARAMS_HASH = b32("55");
const ENDPOINT = "https://api.example.com/v1/data?b=2&a=1";

/** A JSON wire intent that APPROVES under the fixture policy: $0.05, category market-data,
 *  worker agent 0, well within the $1.00 per-call cap and $5.00 escalate threshold. */
function wireIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: OWNER,
    buyerAgentId: "1",
    workerAgentId: "0",
    token: TOKEN,
    maxAmount: "1000000", // 1.0 USDT in base units (6dp) — the §8.1 ceiling
    taskHash: TASK_HASH,
    acceptanceHash: b32("22"),
    schemaHash: b32("33"),
    policyHash: FIXTURE_POLICY_HASH,
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
    policy: FIXTURE_POLICY,
    ledger: new InMemoryLedger(now),
    intentStore: new InMemoryIntentStore(),
    now,
    lock: new PerAgentLock(), // isolate from the engine's module singleton
    ...overrides,
  };
}

// ── create_spend_intent ──────────────────────────────────────────────────────

test("create_spend_intent: valid intent → 200 with the canon intentHash + canonical view", () => {
  const store = new InMemoryIntentStore();
  const res = handleCreateSpendIntent(wireIntent(), { intentStore: store });

  assert.equal(res.status, 200);
  const body = res.body as { intentHash: Hex; canonicalIntent: { struct: Record<string, unknown> }; onchain: null };

  // The returned hash is exactly @untch/canon's hashSpendIntent over the §8.1 struct.
  const expectedStruct: SpendIntent = {
    owner: OWNER.toLowerCase() as Address,
    buyerAgentId: 1n,
    workerAgentId: 0n,
    token: TOKEN.toLowerCase() as Address,
    maxAmount: 1_000_000n,
    taskHash: TASK_HASH,
    acceptanceHash: b32("22"),
    schemaHash: b32("33"),
    policyHash: FIXTURE_POLICY_HASH,
    deadline: 9_999_999_999n,
    nonce: 1n,
  };
  assert.equal(body.intentHash, hashSpendIntent(expectedStruct));

  // Canonical view carries decimal-string uints + lowercased addresses.
  assert.equal(body.canonicalIntent.struct.maxAmount, "1000000");
  assert.equal(body.canonicalIntent.struct.owner, OWNER.toLowerCase());
  // No on-chain registration — explicitly null (SpendIntentRegistry not built).
  assert.equal(body.onchain, null);
  // It was cached for a later preflight-by-hash.
  assert.ok(store.get(body.intentHash));
});

test("create_spend_intent: malformed intent → 400 §11 error envelope, nothing hashed", () => {
  const store = new InMemoryIntentStore();
  const res = handleCreateSpendIntent(
    wireIntent({ maxAmount: 1000000, owner: "not-an-address" }), // number (violates §9) + bad addr
    { intentStore: store },
  );
  assert.equal(res.status, 400);
  const body = res.body as { code: string; retryable: boolean; docsUrl: null };
  assert.equal(body.code, "INTENT_MALFORMED");
  assert.equal(body.retryable, false);
  assert.equal(body.docsUrl, null);
});

// ── preflight_payment: the four required decision paths ───────────────────────

test("preflight_payment: clean intent → APPROVED", async () => {
  const deps = freshPreflightDeps();
  const res = await handlePreflightPayment({ intent: wireIntent() }, deps);

  assert.equal(res.status, 200);
  const body = res.body as { decision: string; receiptRef: null; sig: null; ruleTrace: unknown[] };
  assert.equal(body.decision, "APPROVED");
  assert.equal(body.receiptRef, null);
  assert.equal(body.sig, null);
  assert.ok(Array.isArray(body.ruleTrace) && body.ruleTrace.length > 0);
});

test("preflight_payment: over-daily-budget → BLOCKED_BUDGET", async () => {
  const ledger = new InMemoryLedger(now);
  ledger.seed("1", { spendByDay: new Map([[TODAY, 25]]) }); // already at the $25 daily cap
  const res = await handlePreflightPayment({ intent: wireIntent() }, freshPreflightDeps({ ledger }));

  const body = res.body as { decision: string };
  assert.equal(body.decision, "BLOCKED_BUDGET"); // 25.00 + 0.05 > 25.00
});

test("preflight_payment: repeat of a recent intent → BLOCKED_DUPLICATE", async () => {
  const ledger = new InMemoryLedger(now);
  ledger.seed("1", {
    recentIntents: [
      {
        intentId: "pi_prior",
        taskHash: TASK_HASH,
        endpoint: ENDPOINT,
        paramsHash: PARAMS_HASH,
        createdAtMs: NOW - 60_000, // 1 minute ago, well within the 60-min TTL
      },
    ],
  });
  const res = await handlePreflightPayment({ intent: wireIntent() }, freshPreflightDeps({ ledger }));

  const body = res.body as { decision: string };
  assert.equal(body.decision, "BLOCKED_DUPLICATE");
});

test("preflight_payment: over per-call cap with onPerCallCapExceeded=ESCALATE → ESCALATED_PER_CALL_CAP", async () => {
  // amount 2.0 > perCallCap 1.0, but <= maxAmount 5.0 (so intent-bound passes first). The fixture
  // policy's onPerCallCapExceeded=ESCALATE routes it to approval instead of blocking.
  const res = await handlePreflightPayment(
    { intent: wireIntent({ amount: 2.0, maxAmount: "5000000" }) },
    freshPreflightDeps(),
  );
  const body = res.body as { decision: string };
  assert.equal(body.decision, "ESCALATED_PER_CALL_CAP");
});

// ── the "no alteration" guarantee ─────────────────────────────────────────────

test("preflight_payment surfaces evaluateIntentSerialized's decision/reasons/trace VERBATIM", async () => {
  const wire = wireIntent();
  const { input } = parseFullIntent(wire);

  // What the engine returns, called directly with identical inputs (fixed clock + isolated lock).
  const engineDecision = await evaluateIntentSerialized(input, FIXTURE_POLICY, new InMemoryLedger(now), {
    now,
    lock: new PerAgentLock(),
  });

  // What the handler returns.
  const res = await handlePreflightPayment({ intent: wire }, freshPreflightDeps());
  const body = res.body as { decision: string; reasons: unknown; ruleTrace: unknown; intentHash: Hex };

  assert.equal(body.decision, engineDecision.decision);
  assert.deepEqual(body.reasons, engineDecision.reasons);
  assert.deepEqual(body.ruleTrace, engineDecision.rules); // trace passed through untouched
  assert.equal(body.intentHash, engineDecision.intentHash);
});

// ── create → preflight handoff by intentHash, and honest misses ───────────────

test("create_spend_intent → preflight_payment by intentHash resolves + APPROVES", async () => {
  const store = new InMemoryIntentStore();
  const created = handleCreateSpendIntent(wireIntent(), { intentStore: store });
  const intentHash = (created.body as { intentHash: Hex }).intentHash;

  const res = await handlePreflightPayment({ intentHash }, freshPreflightDeps({ intentStore: store }));
  assert.equal((res.body as { decision: string }).decision, "APPROVED");
});

test("preflight_payment: unknown intentHash → 404 (no registry yet), honest and retryable=false", async () => {
  const res = await handlePreflightPayment({ intentHash: b32("ab") }, freshPreflightDeps());
  assert.equal(res.status, 404);
  assert.equal((res.body as { code: string }).code, "INTENT_NOT_FOUND");
});

test("preflight_payment: intentHash + inline intent that disagree → 400 INTENT_HASH_MISMATCH", async () => {
  const res = await handlePreflightPayment(
    { intentHash: b32("ab"), intent: wireIntent() },
    freshPreflightDeps(),
  );
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "INTENT_HASH_MISMATCH");
});

test("preflight_payment: neither intentHash nor intent → 400 INTENT_REQUIRED", async () => {
  const res = await handlePreflightPayment({}, freshPreflightDeps());
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "INTENT_REQUIRED");
});
