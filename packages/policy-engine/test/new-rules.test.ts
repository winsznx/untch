import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { evaluateIntent } from "../src/index";
import { activePolicy, emptyLedger, now, validIntent } from "./helpers";

describe("replay.contextBinding", () => {
  test("PASSes with NO_CHALLENGE when no inject and requireChallenge false", () => {
    const d = evaluateIntent(validIntent(), activePolicy(), emptyLedger(), { now });
    const entry = d.rules.find((r) => r.rule === "replay.contextBinding");
    assert.equal(entry?.result, "PASS");
    assert.equal(entry?.note, "NO_CHALLENGE");
  });

  test("BLOCKS when requireChallenge and no inject", () => {
    const base = activePolicy();
    const policy = { ...base, rules: { ...base.rules, requireChallenge: true } };
    const d = evaluateIntent(validIntent(), policy, emptyLedger(), { now });
    assert.equal(d.decision, "BLOCKED_REPLAY");
  });

  test("BLOCKS on nonce mismatch", () => {
    const state = {
      ...emptyLedger(),
      challengeBinding: {
        expected: {
          recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
          amount: "1000000",
          resourceUrl: "https://api.example.com/v1/data",
          endpoint: "https://api.example.com/v1/data",
          method: "GET",
          nonce: "n1",
        },
        presented: {
          recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
          amount: "1000000",
          resourceUrl: "https://api.example.com/v1/data",
          endpoint: "https://api.example.com/v1/data",
          method: "GET",
          nonce: "n2",
        },
      },
    };
    const d = evaluateIntent(validIntent(), activePolicy(), state, { now });
    assert.equal(d.decision, "BLOCKED_REPLAY");
  });
});

describe("vendor.lcbFloor", () => {
  test("PASSes with NO_VENDOR_FLOOR when vendors not configured", () => {
    const d = evaluateIntent(validIntent(), activePolicy(), emptyLedger(), { now });
    const entry = d.rules.find((r) => r.rule === "vendor.lcbFloor");
    assert.equal(entry?.result, "PASS");
    assert.equal(entry?.note, "NO_VENDOR_FLOOR");
  });

  test("BLOCKS when LCB below floor", () => {
    const base = activePolicy();
    const policy = {
      ...base,
      rules: {
        ...base.rules,
        vendors: { minScoreLCB: 0.5, onBelowFloor: "BLOCK" as const, onScoreUnavailable: "BLOCK" as const },
      },
    };
    const state = {
      ...emptyLedger(),
      vendorScore: {
        vendorId: "0xabc",
        lcb: 0.2,
        score: 0.4,
        sigma: 0.1,
        computedAtMs: now(),
        available: true,
      },
    };
    const d = evaluateIntent(validIntent(), policy, state, { now });
    assert.equal(d.decision, "BLOCKED_VENDOR_RISK");
  });

  test("PASSes when LCB meets floor", () => {
    const base = activePolicy();
    const policy = {
      ...base,
      rules: { ...base.rules, vendors: { minScoreLCB: 0.3, onBelowFloor: "BLOCK" as const } },
    };
    const state = {
      ...emptyLedger(),
      vendorScore: {
        vendorId: "0xabc",
        lcb: 0.55,
        score: 0.7,
        sigma: 0.05,
        computedAtMs: now(),
        available: true,
      },
    };
    const d = evaluateIntent(validIntent(), policy, state, { now });
    assert.equal(d.decision, "APPROVED");
  });
});

describe("proof.tierRequired", () => {
  test("ESCALATES when policy requires T1 and only T0 available", () => {
    const base = activePolicy();
    const policy = {
      ...base,
      rules: { ...base.rules, proof: { defaultTier: 1, requireTierAbove: [] } },
    };
    const d = evaluateIntent(validIntent(), policy, emptyLedger(), { now });
    assert.equal(d.decision, "ESCALATED_PROOF_TIER");
  });

  test("PASSes when required tier is 0", () => {
    const d = evaluateIntent(validIntent(), activePolicy(), emptyLedger(), { now });
    const entry = d.rules.find((r) => r.rule === "proof.tierRequired");
    assert.equal(entry?.result, "PASS");
    assert.equal(d.decision, "APPROVED");
  });
});
