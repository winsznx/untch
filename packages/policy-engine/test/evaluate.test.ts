import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { hashSpendIntent } from "@untch/canon";
import { evaluateIntent } from "../src/index";
import type { RuleTraceEntry } from "../src/index";
import type { Address, Hex } from "viem";
import { activePolicy, emptyLedger, now, NOW_MS, priorIntent, validIntent } from "./helpers";

/**
 * Terminal-state coverage for the pure `evaluateIntent` (§7.1). Every outcome this slice can
 * emit is exercised, and each decision's trace is asserted against §8.2's shape. A fixed clock
 * makes duplicate-TTL, expiry, and `evaluatedAt` deterministic.
 */

const opts = { now };

/** Find a rule entry by name in a trace. */
function rule(rules: readonly RuleTraceEntry[], name: string): RuleTraceEntry | undefined {
  return rules.find((r) => r.rule === name);
}

describe("evaluateIntent · §8.2 decision-trace shape", () => {
  test("Decision carries exactly the §8.2 top-level fields + reasons", () => {
    // #when
    const d = evaluateIntent(validIntent(), activePolicy(), emptyLedger(), opts);
    // #then
    assert.deepEqual(Object.keys(d).sort(), [
      "decision",
      "evaluatedAt",
      "intentHash",
      "policyId",
      "policyVersion",
      "reasons",
      "rules",
    ]);
    assert.equal(d.policyId, "12");
    assert.equal(d.policyVersion, 3);
    assert.equal(d.evaluatedAt, "2026-07-05T20:44:00Z");
  });

  test("intentHash is @untch/canon's hashSpendIntent over the §8.1 struct (reuse, not reimplementation)", () => {
    // #given
    const intent = validIntent();
    // #when
    const d = evaluateIntent(intent, activePolicy(), emptyLedger(), opts);
    // #then
    const expected = hashSpendIntent({
      owner: intent.owner,
      buyerAgentId: intent.buyerAgentId,
      workerAgentId: intent.workerAgentId,
      token: intent.token,
      maxAmount: intent.maxAmount,
      taskHash: intent.taskHash,
      acceptanceHash: intent.acceptanceHash,
      schemaHash: intent.schemaHash,
      policyHash: intent.policyHash,
      deadline: intent.deadline,
      nonce: intent.nonce,
    });
    assert.equal(d.intentHash, expected);
  });
});

describe("evaluateIntent · REJECTED_MALFORMED (§7.1 INTENT_CANONICAL)", () => {
  test("non-hex owner ⇒ REJECTED_MALFORMED, reasons set, no rules evaluated", () => {
    const d = evaluateIntent(validIntent({ owner: "0xNOTHEX" as Address }), activePolicy(), emptyLedger(), opts);
    assert.equal(d.decision, "REJECTED_MALFORMED");
    assert.ok(d.reasons.length > 0);
    assert.equal(d.rules.length, 0);
  });

  test("bad bytes32 taskHash ⇒ REJECTED_MALFORMED", () => {
    const d = evaluateIntent(validIntent({ taskHash: "0x1234" as Hex }), activePolicy(), emptyLedger(), opts);
    assert.equal(d.decision, "REJECTED_MALFORMED");
  });

  test("negative amount ⇒ REJECTED_MALFORMED (fail closed, never a silent approve)", () => {
    const d = evaluateIntent(validIntent({ amount: -1 }), activePolicy(), emptyLedger(), opts);
    assert.equal(d.decision, "REJECTED_MALFORMED");
  });
});

describe("evaluateIntent · BLOCKED_NO_ACTIVE_POLICY (§7.1 POLICY_LOOKUP)", () => {
  test("missing policy ⇒ BLOCKED_NO_ACTIVE_POLICY, policy.active observed MISSING", () => {
    const d = evaluateIntent(validIntent(), null, emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_NO_ACTIVE_POLICY");
    assert.equal(rule(d.rules, "policy.active")?.result, "FAIL");
    assert.equal(rule(d.rules, "policy.active")?.observed, "MISSING");
  });

  test("paused policy ⇒ BLOCKED_NO_ACTIVE_POLICY, observed PAUSED", () => {
    const d = evaluateIntent(validIntent(), activePolicy({ status: "PAUSED" }), emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_NO_ACTIVE_POLICY");
    assert.equal(rule(d.rules, "policy.active")?.observed, "PAUSED");
  });

  test("expired policy ⇒ BLOCKED_NO_ACTIVE_POLICY, observed EXPIRED", () => {
    const expired = activePolicy();
    const policy = { ...expired, rules: { ...expired.rules, expiry: "2020-01-01T00:00:00Z" } };
    const d = evaluateIntent(validIntent(), policy, emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_NO_ACTIVE_POLICY");
    assert.equal(rule(d.rules, "policy.active")?.observed, "EXPIRED");
  });

  test("unparseable expiry ⇒ inactive (fail closed), never fail-open to ACTIVE", () => {
    const p = activePolicy();
    const policy = { ...p, rules: { ...p.rules, expiry: "not-a-date" } };
    const d = evaluateIntent(validIntent(), policy, emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_NO_ACTIVE_POLICY");
  });
});

describe("evaluateIntent · BLOCKED_DUPLICATE (§7.1 RULE_EVAL)", () => {
  test("prior intent with same tuple inside TTL ⇒ BLOCKED_DUPLICATE; trace shows the prior", () => {
    // #given a matching prior intent created 10 min ago, TTL 60 min
    const ledger = emptyLedger({ recentIntents: [priorIntent(10)] });
    // #when
    const d = evaluateIntent(validIntent(), activePolicy(), ledger, opts);
    // #then
    assert.equal(d.decision, "BLOCKED_DUPLICATE");
    const dup = rule(d.rules, "duplicate.taskHash_endpoint_paramsHash");
    assert.equal(dup?.result, "FAIL");
    assert.equal(dup?.priorIntentId, "pi_abc123");
    // 60m TTL, 10m elapsed ⇒ ~50m = 3000s remaining
    assert.equal(dup?.ttlRemainingSec, 3000);
    // short-circuit: budget must not have been reached
    assert.equal(rule(d.rules, "budget.daily"), undefined);
  });

  test("prior intent OUTSIDE TTL does not block ⇒ proceeds to APPROVED", () => {
    const ledger = emptyLedger({ recentIntents: [priorIntent(61)] });
    const d = evaluateIntent(validIntent(), activePolicy(), ledger, opts);
    assert.equal(d.decision, "APPROVED");
  });

  test("URL formatting differences do not defeat the match (canon canonUrl)", () => {
    // prior stored with reordered query + uppercase host; same logical endpoint
    const prior = priorIntent(5, { endpoint: "https://API.EXAMPLE.com/v1/data?a=1&b=2" });
    const d = evaluateIntent(validIntent(), activePolicy(), emptyLedger({ recentIntents: [prior] }), opts);
    assert.equal(d.decision, "BLOCKED_DUPLICATE");
  });
});

describe("evaluateIntent · BLOCKED_BUDGET (§7.1 RULE_EVAL)", () => {
  test("spentToday + amount over daily ⇒ BLOCKED_BUDGET; trace shows observed vs limit (§8.2 shape)", () => {
    // #given 24.98 already spent, this call 0.05 ⇒ projected 25.03 > 25.00
    const ledger = emptyLedger({ spentTodayByAgent: 24.98 });
    // #when
    const d = evaluateIntent(validIntent(), activePolicy(), ledger, opts);
    // #then
    assert.equal(d.decision, "BLOCKED_BUDGET");
    const b = rule(d.rules, "budget.daily");
    assert.equal(b?.result, "FAIL");
    assert.equal(b?.observed, "25.03");
    assert.equal(b?.limit, "25.00");
    assert.equal(b?.token, "USDT");
  });

  test("projected total exactly equal to the limit is allowed (boundary) ⇒ APPROVED", () => {
    // 24.95 + 0.05 = 25.00, not > 25.00
    const d = evaluateIntent(validIntent(), activePolicy(), emptyLedger({ spentTodayByAgent: 24.95 }), opts);
    assert.equal(d.decision, "APPROVED");
    assert.equal(rule(d.rules, "budget.daily")?.observed, "25.00");
  });
});

describe("evaluateIntent · BLOCKED_FAIL_CLOSED (§7.1 STATE_ASSEMBLY, I2)", () => {
  test("malformed ledger state (recentIntents not an array) ⇒ BLOCKED_FAIL_CLOSED", () => {
    const bad = { spentTodayByAgent: 0, recentIntents: undefined } as unknown as ReturnType<typeof emptyLedger>;
    const d = evaluateIntent(validIntent(), activePolicy(), bad, opts);
    assert.equal(d.decision, "BLOCKED_FAIL_CLOSED");
  });

  test("negative spentTodayByAgent ⇒ BLOCKED_FAIL_CLOSED", () => {
    const d = evaluateIntent(validIntent(), activePolicy(), emptyLedger({ spentTodayByAgent: -5 }), opts);
    assert.equal(d.decision, "BLOCKED_FAIL_CLOSED");
  });
});

describe("evaluateIntent · APPROVED (all implemented rules pass)", () => {
  test("clean intent ⇒ APPROVED; trace shows every real + stub rule; stubs tagged implemented:false", () => {
    // #when
    const d = evaluateIntent(validIntent(), activePolicy(), emptyLedger(), opts);
    // #then
    assert.equal(d.decision, "APPROVED");
    // real rules present, PASS, and NOT flagged implemented:false
    for (const name of ["policy.active", "duplicate.taskHash_endpoint_paramsHash", "budget.daily"]) {
      const r = rule(d.rules, name);
      assert.equal(r?.result, "PASS", `${name} should PASS`);
      assert.equal(r?.implemented, undefined, `${name} is real, must not carry implemented:false`);
    }
    // every stub present, PASS, implemented:false
    const stubs = d.rules.filter((r) => r.implemented === false);
    assert.ok(stubs.length >= 1);
    for (const s of stubs) assert.equal(s.result, "PASS");
    assert.equal(NOW_MS > 0, true);
  });
});
