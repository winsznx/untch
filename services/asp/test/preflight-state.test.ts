import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryScoreDataSource } from "@untch/trust-bureau";
import type { Hex } from "viem";
import {
  assemblePreflightInjects,
  vendorIdOf,
  wrapLedgerWithInjects,
} from "../src/preflight-state";
import { InMemoryLedger } from "../src/ledger-state";
import type { SpendIntentInput } from "@untch/policy-engine";

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
  endpoint: "https://api.vendor.example/v1/data",
  paramsHash: ("0x" + "55".repeat(32)) as Hex,
  recipientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  category: "market-data",
  amount: 0.05,
} as SpendIntentInput;

test("vendorIdOf is stable host hash", () => {
  const a = vendorIdOf("https://api.vendor.example/v1/data?x=1");
  const b = vendorIdOf("https://api.vendor.example/other");
  assert.equal(a, b);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test("assemblePreflightInjects reads challengeBinding from body", async () => {
  const injects = await assemblePreflightInjects(
    intent,
    {
      challengeBinding: {
        expected: { recipient: "0xabc", token: "0xdef", amount: "1", resourceUrl: "https://x", endpoint: "https://x", method: "GET" },
        presented: { recipient: "0xabc", token: "0xdef", amount: "1", resourceUrl: "https://x", endpoint: "https://x", method: "GET" },
      },
    },
    null,
  );
  assert.ok(injects.challengeBinding);
  assert.equal(injects.availableProofTier, 0);
});

test("assemblePreflightInjects uses body vendorScore override", async () => {
  const injects = await assemblePreflightInjects(
    intent,
    { vendorScore: { lcb: 0.8, score: 0.9, sigma: 0.05, available: true } },
    null,
  );
  assert.equal(injects.vendorScore?.available, true);
  assert.equal(injects.vendorScore?.lcb, 0.8);
});

test("assemblePreflightInjects loads bureau latestSnapshot", async () => {
  const ds = new MemoryScoreDataSource();
  const vid = vendorIdOf(intent.endpoint);
  await ds.saveSnapshot({
    subject: "VENDOR",
    subjectId: vid,
    epoch: 1,
    score: 70,
    sigma: 5,
    lcb: 60,
    band: "A",
    features: [],
    anchoredRoot: null,
    computedAt: new Date().toISOString(),
  });
  const injects = await assemblePreflightInjects(intent, {}, ds);
  assert.equal(injects.vendorScore?.available, true);
  assert.equal(injects.vendorScore?.lcb, 60);
});

test("wrapLedgerWithInjects merges into read()", async () => {
  const base = new InMemoryLedger();
  const wrapped = wrapLedgerWithInjects(base, {
    availableProofTier: 0,
    vendorScore: {
      vendorId: "0x1",
      lcb: 0.5,
      score: 0.6,
      sigma: 0.1,
      computedAtMs: Date.now(),
      available: true,
    },
  });
  const state = await wrapped.read("policy:1");
  assert.equal(state.availableProofTier, 0);
  assert.equal(state.vendorScore?.lcb, 0.5);
  assert.equal(state.spentTodayByAgent, 0);
});
