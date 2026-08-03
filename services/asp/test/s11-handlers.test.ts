import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleDetectDuplicate,
  handleGetLedger,
  handleRedactPaymentMetadata,
} from "../src/s11-handlers";
import { InMemoryLedger } from "../src/ledger-state";
import type { Decision, SpendIntentInput } from "@untch/policy-engine";
import type { Hex } from "viem";

const intent = {
  owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  buyerAgentId: 1n,
  workerAgentId: 0n,
  token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  maxAmount: 1_000_000n,
  taskHash: ("0x" + "11".repeat(32)) as Hex,
  acceptanceHash: ("0x" + "22".repeat(32)) as Hex,
  schemaHash: ("0x" + "33".repeat(32)) as Hex,
  policyHash: ("0x" + "44".repeat(32)) as Hex,
  deadline: 9_999_999_999n,
  nonce: 1n,
  endpoint: "https://api.example.com/v1/data",
  paramsHash: ("0x" + "55".repeat(32)) as Hex,
  recipientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  category: "market-data",
  amount: 1,
} as SpendIntentInput;

const decision = {
  decision: "APPROVED",
  intentHash: ("0x" + "aa".repeat(32)) as Hex,
  policyId: "1",
  policyVersion: 1,
  evaluatedAt: "2026-07-16T00:00:00Z",
  reasons: [],
  rules: [],
} as Decision;

test("redact strips email and api key and returns hash", () => {
  const r = handleRedactPaymentMetadata({
    metadata: { note: "contact me@example.com with sk_live_abcdefghijklmnopqrstuv", n: 1 },
  });
  assert.equal(r.status, 200);
  const body = r.body as { redacted: { note: string }; metadataHash: string };
  assert.ok(!body.redacted.note.includes("me@example.com"));
  assert.ok(body.redacted.note.includes("[REDACTED]"));
  assert.match(body.metadataHash, /^0x[0-9a-f]{64}$/i);
});

test("detect_duplicate finds committed intent in ledger window", () => {
  const ledger = new InMemoryLedger();
  ledger.commitApproved("policy:1", intent, decision);
  const hit = handleDetectDuplicate(
    {
      policyId: "1",
      taskHash: intent.taskHash,
      endpoint: intent.endpoint,
      paramsHash: intent.paramsHash,
    },
    ledger,
    60,
  );
  assert.equal(hit.status, 200);
  assert.equal((hit.body as { duplicate: boolean }).duplicate, true);

  const miss = handleDetectDuplicate(
    {
      policyId: "1",
      taskHash: ("0x" + "99".repeat(32)) as Hex,
      endpoint: intent.endpoint,
      paramsHash: intent.paramsHash,
    },
    ledger,
    60,
  );
  assert.equal((miss.body as { duplicate: boolean }).duplicate, false);
});

test("get_ledger returns window for policy partition", () => {
  const ledger = new InMemoryLedger();
  ledger.commitApproved("policy:42", intent, decision);
  const r = handleGetLedger({ policyId: "42" }, ledger);
  assert.equal(r.status, 200);
  const body = r.body as {
    reservedAuthorityToday: number; settledSpendToday: number; effectiveBudgetUsageToday: number;
    recentIntents: unknown[];
  };
  // An approved decision RESERVES authority. It settles nothing, so the two numbers differ and the
  // window says so rather than collapsing both into one field called spend.
  assert.equal(body.reservedAuthorityToday, 1);
  assert.equal(body.settledSpendToday, 0);
  assert.equal(body.effectiveBudgetUsageToday, 1);
  assert.equal(body.recentIntents.length, 1);
});
