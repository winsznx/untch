import assert from "node:assert/strict";
import { test } from "node:test";
import { hashCanonicalJson } from "@untch/canon";
import { VERIFY_RESULT_CODE, type AcceptanceCriteria } from "@untch/proof-engine";
import {
  InMemoryPolicyRepo,
  parsePolicyRules,
  PolicyProvider,
  type StoredPolicy,
} from "@untch/policy-store";
import type { Address, Hex } from "viem";
import { handleCreateSpendIntent, handleVerifyDelivery, type VerifyDeps } from "../src/handlers";
import { InMemoryIntentStore } from "../src/ledger-state";

/**
 * Unit tests for verify_delivery — the priced $0.10 tool. Deterministic, NO network: they drive the
 * REAL `@untch/proof-engine` T0 through the handler against a REAL stored policy + in-memory intent
 * store, and assert the handler surfaces the proof engine's verdict unchanged. The real receipt
 * enqueue + on-chain anchor is covered by the e2e proof (run-verify-e2e-proof.ts), same testing
 * boundary the preflight handler tests use.
 */

const NOW = Date.parse("2026-07-11T12:00:00Z");
const now = (): number => NOW;

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const AGENT = "0x000000000000000000000000000000000000A9E7" as Address;
const TOKEN = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736" as Address;
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const b32 = (byte: string): Hex => `0x${byte.repeat(32)}` as Hex;
const ZERO = b32("00");
const POLICY_ID = "1";

function baseRules(): Record<string, unknown> {
  return {
    budgets: { daily: 25, token: "USDT" },
    perCallCap: 1.0,
    onPerCallCapExceeded: "ESCALATE",
    escalateAbove: 5.0,
    categories: { allow: ["market-data"], deny: [] },
    recipients: { allow: [], deny: [] },
    agents: { allowWorkerIds: [], denyWorkerIds: [] },
    duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
    cooldowns: { sameServiceMin: 5 },
    rateLimit: { callsPerHour: 40 },
    expiry: "2026-12-31T00:00:00Z",
  };
}
const BASE_HASH = hashCanonicalJson(baseRules());

function storedPolicy(): StoredPolicy {
  const rules = baseRules();
  return {
    id: POLICY_ID,
    owner: OWNER,
    agentId: AGENT,
    version: 1,
    status: "ACTIVE",
    policyHash: BASE_HASH,
    expiry: Math.floor(Date.parse(rules.expiry as string) / 1000),
    onchainRef: {
      chainId: 1952,
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

function provider(): PolicyProvider {
  const repo = new InMemoryPolicyRepo();
  void repo.insert(storedPolicy());
  return new PolicyProvider(repo);
}

function deps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
  return { policyProvider: provider(), intentStore: new InMemoryIntentStore(), now, ...overrides };
}

function criteria(): AcceptanceCriteria {
  return {
    schema: {
      type: "object",
      required: ["symbol", "price"],
      properties: { symbol: { type: "string" }, price: { type: "number" } },
      additionalProperties: true,
    },
    requiredFields: ["symbol", "price"],
    fieldConstraints: [{ field: "symbol", regex: "[A-Z0-9]{2,10}" }],
  };
}

/** A wire intent bound to the base policy; `acceptanceHash` defaults to the committed criteria hash. */
function wireIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: OWNER,
    buyerAgentId: "1",
    workerAgentId: "0",
    token: TOKEN,
    maxAmount: "1000000",
    taskHash: b32("11"),
    acceptanceHash: hashCanonicalJson(criteria()),
    schemaHash: b32("33"),
    policyHash: BASE_HASH,
    deadline: "9999999999",
    nonce: "1",
    endpoint: "https://api.vendor.example/v1/market-data?symbol=OKB",
    paramsHash: b32("55"),
    recipientAddress: RECIPIENT,
    category: "market-data",
    amount: 0.5,
    ...overrides,
  };
}

const goodDelivery = { payload: { symbol: "OKB", price: 48.15 } };

test("verify_delivery: conformant delivery vs committed criteria → 200 VERIFY_PASSED, verifyResult=PASS", async () => {
  const res = await handleVerifyDelivery(
    { intent: wireIntent(), policyId: POLICY_ID, acceptanceCriteria: criteria(), delivery: goodDelivery },
    deps(),
  );
  assert.equal(res.status, 200);
  const body = res.body as { final: string; verifyResult: number; proofTier: number; recommendation: string; receiptRef: unknown };
  assert.equal(body.final, "VERIFY_PASSED");
  assert.equal(body.verifyResult, VERIFY_RESULT_CODE.PASS);
  assert.equal(body.proofTier, 0);
  assert.equal(body.recommendation, "RELEASE");
  assert.equal(body.receiptRef, null, "no receipt writer wired → honest null, not a fabricated ref");
});

test("verify_delivery: schema-violating delivery → VERIFY_FAILED, verifyResult=FAIL, diffs surfaced", async () => {
  const res = await handleVerifyDelivery(
    {
      intent: wireIntent(),
      policyId: POLICY_ID,
      acceptanceCriteria: criteria(),
      delivery: { payload: { symbol: "okb" } }, // lowercase + missing price
    },
    deps(),
  );
  const body = res.body as { final: string; verifyResult: number; recommendation: string; diffs: unknown[] };
  assert.equal(body.final, "VERIFY_FAILED");
  assert.equal(body.verifyResult, VERIFY_RESULT_CODE.FAIL);
  assert.equal(body.recommendation, "WITHHOLD");
  assert.ok(body.diffs.length > 0);
});

test("verify_delivery: no acceptanceHash committed → VERIFY_SKIPPED_UNCOMMITTED (buyer-hygiene), never a pass", async () => {
  const res = await handleVerifyDelivery(
    { intent: wireIntent({ acceptanceHash: ZERO }), policyId: POLICY_ID, delivery: goodDelivery },
    deps(),
  );
  const body = res.body as { final: string; verifyResult: number; hygieneEvent: boolean };
  assert.equal(body.final, "VERIFY_SKIPPED_UNCOMMITTED");
  assert.equal(body.verifyResult, VERIFY_RESULT_CODE.SKIPPED_UNCOMMITTED);
  assert.equal(body.hygieneEvent, true);
  assert.notEqual(body.verifyResult, VERIFY_RESULT_CODE.PASS);
});

test("verify_delivery: a swapped criteria doc that doesn't bind → VERIFY_FAILED on criteriaBinding", async () => {
  const res = await handleVerifyDelivery(
    {
      intent: wireIntent(), // commits hashCanonicalJson(criteria())
      policyId: POLICY_ID,
      acceptanceCriteria: { requiredFields: ["anything"] }, // different doc
      delivery: { payload: { anything: 1 } },
    },
    deps(),
  );
  const body = res.body as { final: string; diffs: { check: string }[] };
  assert.equal(body.final, "VERIFY_FAILED");
  assert.ok(body.diffs.some((d) => d.check === "criteriaBinding"));
});

test("verify_delivery: resolve by intentHash from a prior create_spend_intent on the same instance", async () => {
  const store = new InMemoryIntentStore();
  const p = provider();
  const created = await handleCreateSpendIntent(
    { ...wireIntent(), policyId: POLICY_ID },
    { intentStore: store, policyProvider: p },
  );
  const { intentHash } = created.body as { intentHash: Hex };

  const res = await handleVerifyDelivery(
    { intentHash, policyId: POLICY_ID, acceptanceCriteria: criteria(), delivery: goodDelivery },
    { policyProvider: p, intentStore: store, now },
  );
  const body = res.body as { final: string; intentHash: Hex };
  assert.equal(body.final, "VERIFY_PASSED");
  assert.equal(body.intentHash, intentHash);
});

test("verify_delivery: missing policyId → 400 POLICY_ID_REQUIRED", async () => {
  const res = await handleVerifyDelivery(
    { intent: wireIntent(), acceptanceCriteria: criteria(), delivery: goodDelivery },
    deps(),
  );
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "POLICY_ID_REQUIRED");
});

test("verify_delivery: intent bound to a different policy hash → 400 POLICY_BINDING_MISMATCH", async () => {
  const res = await handleVerifyDelivery(
    { intent: wireIntent({ policyHash: b32("99") }), policyId: POLICY_ID, acceptanceCriteria: criteria(), delivery: goodDelivery },
    deps(),
  );
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "POLICY_BINDING_MISMATCH");
});

test("verify_delivery: no payload and no payloadHash → 400 DELIVERY_REQUIRED", async () => {
  const res = await handleVerifyDelivery(
    { intent: wireIntent(), policyId: POLICY_ID, acceptanceCriteria: criteria() },
    deps(),
  );
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "DELIVERY_REQUIRED");
});
