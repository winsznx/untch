import assert from "node:assert/strict";
import { test } from "node:test";
import type { Decision, SpendIntentInput } from "@untch/policy-engine";
import { keccak256, toHex } from "viem";
import { amountBaseUnits, decisionToUint8, draftFromDecision } from "../src/mapping";

/** The decision → §10.3 receipt + §8 ledger mapping (field discipline the on-chain writer relies on). */

const input: SpendIntentInput = {
  owner: "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b",
  buyerAgentId: 1n,
  workerAgentId: 0n, // A2MCP → payType 0
  token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  maxAmount: 1_000_000n,
  taskHash: keccak256(toHex("task")),
  acceptanceHash: keccak256(toHex("acceptance")),
  schemaHash: keccak256(toHex("schema")),
  policyHash: keccak256(toHex("policy")),
  deadline: 9_999_999_999n,
  nonce: 7n,
  endpoint: "https://api.vendor.example/v1/market-data?symbol=okb",
  paramsHash: keccak256(toHex("params")),
  recipientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  category: "market-data",
  amount: 0.5,
};

const decision: Decision = {
  decision: "APPROVED",
  intentHash: keccak256(toHex("intent")),
  policyId: "42",
  policyVersion: 3,
  evaluatedAt: "2026-07-10T20:44:00Z",
  reasons: [],
  rules: [],
};

test("APPROVED maps to on-chain decision code 1 (frozen — already on-chain)", () => {
  assert.equal(decisionToUint8("APPROVED"), 1);
});

test("amountBaseUnits uses the §9 6-decimal convention", () => {
  assert.equal(amountBaseUnits(0.5), 500_000n);
  assert.equal(amountBaseUnits(1), 1_000_000n);
});

test("draftFromDecision builds a §10.3-shaped receipt + a SPEND ledger entry", () => {
  const draft = draftFromDecision(input, decision);

  assert.match(draft.onchain.receiptId, /^0x[0-9a-f]{64}$/, "caller-supplied bytes32 receiptId");
  assert.equal(draft.onchain.policyId, 42n);
  assert.equal(draft.onchain.agentId, toHex(1n, { size: 32 }), "agentId = bytes32(buyerAgentId), not an address");
  assert.equal(draft.onchain.amount, 500_000n);
  assert.equal(draft.onchain.payType, 0, "A2MCP");
  assert.equal(draft.onchain.decision, 1);
  assert.equal(draft.onchain.verifyResult, 0, "no delivery verification in the preflight-only path");
  assert.equal(draft.onchain.intentHash, decision.intentHash);

  assert.equal(draft.ledger.type, "SPEND", "APPROVED → SPEND");
  assert.equal(draft.ledger.amount, "500000");
  assert.equal(draft.ledger.dayKey, "2026-07-10");
});

test("a BLOCKED decision produces a BLOCK_SAVED ledger entry", () => {
  const blocked: Decision = { ...decision, decision: "BLOCKED_BUDGET" };
  const draft = draftFromDecision(input, blocked);
  assert.equal(draft.ledger.type, "BLOCK_SAVED", "withheld spend is recorded as saved");
  assert.equal(draft.onchain.decision, decisionToUint8("BLOCKED_BUDGET"));
});

test("two identical evaluations get distinct receiptIds (salted, collision-proof PK)", () => {
  const a = draftFromDecision(input, decision);
  const b = draftFromDecision(input, decision);
  assert.notEqual(a.onchain.receiptId, b.onchain.receiptId);
});
