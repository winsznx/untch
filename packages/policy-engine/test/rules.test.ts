import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { evaluateIntent, evaluateIntentSerialized } from "../src/index";
import type { Ledger, Policy, PolicyRules, RuleTraceEntry } from "../src/index";
import { activePolicy, emptyLedger, now, NOW_MS, validIntent } from "./helpers";

/**
 * Per-rule coverage for the eight rules added in this slice — cooldown, recipient allow/deny,
 * worker-agent allow/deny, category allow/deny, intent-bound, per-call cap, rate limit, and
 * escalate-above — each with a case that blocks/escalates it and a case that passes it, asserting
 * the §8.2 trace entry's shape and values. Plus order-correctness tests: an intent that violates
 * two rules must fail on the EARLIER §7.1 rule (proving short-circuit order, not just "a" failure).
 *
 * A fixed clock (`now` = §8.2's `2026-07-05T20:44:00Z`) makes cooldown remaining, rate, and
 * `evaluatedAt` deterministic.
 */

const opts = { now };

function rule(rules: readonly RuleTraceEntry[], name: string): RuleTraceEntry | undefined {
  return rules.find((r) => r.rule === name);
}

/** `activePolicy` with specific `rules` fields overridden (merged onto the generous defaults). */
function policyWith(rulesOverrides: Partial<PolicyRules>): Policy {
  const base = activePolicy();
  return { ...base, rules: { ...base.rules, ...rulesOverrides } };
}

/** Canonical host of `validIntent().endpoint` — the cooldown rule's service identity. */
const SERVICE_HOST = "api.example.com";

// ─────────────────────────────────────────────────────────────────────────────
// cooldown.sameService → BLOCKED_COOLDOWN
// ─────────────────────────────────────────────────────────────────────────────

describe("cooldown.sameService · BLOCKED_COOLDOWN (§7.1 RULE_EVAL)", () => {
  test("a same-service call inside the cooldown window ⇒ BLOCKED_COOLDOWN; trace shows remaining", () => {
    // #given the same service was called 2 min ago, cooldown is 5 min
    const ledger = emptyLedger({ lastCallByService: { [SERVICE_HOST]: NOW_MS - 2 * 60_000 } });
    // #when
    const d = evaluateIntent(validIntent(), policyWith({ cooldowns: { sameServiceMin: 5 } }), ledger, opts);
    // #then 3 min (180s) of the window remain
    assert.equal(d.decision, "BLOCKED_COOLDOWN");
    const c = rule(d.rules, "cooldown.sameService");
    assert.equal(c?.result, "FAIL");
    assert.equal(c?.cooldownRemainingSec, 180);
    assert.equal(c?.limit, 300);
  });

  test("a same-service call after the window elapsed ⇒ APPROVED", () => {
    const ledger = emptyLedger({ lastCallByService: { [SERVICE_HOST]: NOW_MS - 10 * 60_000 } });
    const d = evaluateIntent(validIntent(), policyWith({ cooldowns: { sameServiceMin: 5 } }), ledger, opts);
    assert.equal(d.decision, "APPROVED");
    assert.equal(rule(d.rules, "cooldown.sameService")?.result, "PASS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recipient.allowDeny → BLOCKED_RECIPIENT
// ─────────────────────────────────────────────────────────────────────────────

describe("recipient.allowDeny · BLOCKED_RECIPIENT (§7.1 RULE_EVAL)", () => {
  test("recipient on the deny list ⇒ BLOCKED_RECIPIENT; trace shows matchedList deny", () => {
    const recipient = validIntent().recipientAddress;
    const d = evaluateIntent(validIntent(), policyWith({ recipients: { allow: [], deny: [recipient] } }), emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_RECIPIENT");
    const r = rule(d.rules, "recipient.allowDeny");
    assert.equal(r?.result, "FAIL");
    assert.equal(r?.matchedList, "deny");
    assert.equal(r?.observed, recipient.toLowerCase());
  });

  test("recipient not on a non-empty allow list ⇒ BLOCKED_RECIPIENT; matchedList allow", () => {
    const other = "0x0000000000000000000000000000000000000001" as Address;
    const d = evaluateIntent(validIntent(), policyWith({ recipients: { allow: [other], deny: [] } }), emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_RECIPIENT");
    assert.equal(rule(d.rules, "recipient.allowDeny")?.matchedList, "allow");
  });

  test("recipient on the allow list (case-insensitive) ⇒ APPROVED", () => {
    const recipient = validIntent().recipientAddress; // mixed-case checksum; canonAddress lowercases both
    const d = evaluateIntent(validIntent(), policyWith({ recipients: { allow: [recipient], deny: [] } }), emptyLedger(), opts);
    assert.equal(d.decision, "APPROVED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// agent.workerAllowDeny → BLOCKED_AGENT
// ─────────────────────────────────────────────────────────────────────────────

describe("agent.workerAllowDeny · BLOCKED_AGENT (§7.1 RULE_EVAL)", () => {
  test("worker on the deny list ⇒ BLOCKED_AGENT; trace shows the worker id + matchedList deny", () => {
    const intent = validIntent({ workerAgentId: 7n });
    const d = evaluateIntent(intent, policyWith({ agents: { allowWorkerIds: [], denyWorkerIds: ["7"] } }), emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_AGENT");
    const a = rule(d.rules, "agent.workerAllowDeny");
    assert.equal(a?.result, "FAIL");
    assert.equal(a?.matchedList, "deny");
    assert.equal(a?.observed, "7");
  });

  test("worker not on a non-empty allow list ⇒ BLOCKED_AGENT; matchedList allow", () => {
    const intent = validIntent({ workerAgentId: 7n });
    const d = evaluateIntent(intent, policyWith({ agents: { allowWorkerIds: ["9"], denyWorkerIds: [] } }), emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_AGENT");
    assert.equal(rule(d.rules, "agent.workerAllowDeny")?.matchedList, "allow");
  });

  test("worker on the allow list ⇒ APPROVED", () => {
    const intent = validIntent({ workerAgentId: 9n });
    const d = evaluateIntent(intent, policyWith({ agents: { allowWorkerIds: ["9"], denyWorkerIds: [] } }), emptyLedger(), opts);
    assert.equal(d.decision, "APPROVED");
  });

  test("A2MCP call (workerAgentId 0) is not gated by a worker allow list ⇒ APPROVED", () => {
    const d = evaluateIntent(validIntent({ workerAgentId: 0n }), policyWith({ agents: { allowWorkerIds: ["9"], denyWorkerIds: [] } }), emptyLedger(), opts);
    assert.equal(d.decision, "APPROVED");
    assert.equal(rule(d.rules, "agent.workerAllowDeny")?.observed, "0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// category.allow → BLOCKED_CATEGORY
// ─────────────────────────────────────────────────────────────────────────────

describe("category.allow · BLOCKED_CATEGORY (§7.1 RULE_EVAL)", () => {
  test("category on the deny list ⇒ BLOCKED_CATEGORY; matchedList deny", () => {
    const d = evaluateIntent(validIntent(), policyWith({ categories: { allow: [], deny: ["market-data"] } }), emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_CATEGORY");
    const c = rule(d.rules, "category.allow");
    assert.equal(c?.matchedList, "deny");
    assert.equal(c?.observed, "market-data");
  });

  test("category not on a non-empty allow list ⇒ BLOCKED_CATEGORY; matchedList allow", () => {
    const d = evaluateIntent(validIntent(), policyWith({ categories: { allow: ["research"], deny: [] } }), emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_CATEGORY");
    assert.equal(rule(d.rules, "category.allow")?.matchedList, "allow");
  });

  test("category on the allow list (case-insensitive) ⇒ APPROVED", () => {
    const d = evaluateIntent(validIntent({ category: "Market-Data" }), policyWith({ categories: { allow: ["market-data"], deny: [] } }), emptyLedger(), opts);
    assert.equal(d.decision, "APPROVED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// intent.maxAmountBound → BLOCKED_INTENT_BOUND
// ─────────────────────────────────────────────────────────────────────────────

describe("intent.maxAmountBound · BLOCKED_INTENT_BOUND (§7.1 RULE_EVAL)", () => {
  test("amount above the intent's own maxAmount ⇒ BLOCKED_INTENT_BOUND; trace compares in display units", () => {
    // #given maxAmount 1_000_000 base units = 1.00 display; amount 2.00 exceeds it
    const intent = validIntent({ amount: 2.0, maxAmount: 1_000_000n });
    const d = evaluateIntent(intent, activePolicy(), emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_INTENT_BOUND");
    const b = rule(d.rules, "intent.maxAmountBound");
    assert.equal(b?.result, "FAIL");
    assert.equal(b?.observed, "2.00");
    assert.equal(b?.limit, "1.00");
    assert.equal(b?.token, "USDT");
    // short-circuit: nothing after intent-bound was reached
    assert.equal(rule(d.rules, "perCall.cap"), undefined);
  });

  test("amount at/under the intent's own maxAmount ⇒ APPROVED", () => {
    const intent = validIntent({ amount: 0.5, maxAmount: 1_000_000n }); // 0.50 ≤ 1.00
    const d = evaluateIntent(intent, activePolicy(), emptyLedger(), opts);
    assert.equal(d.decision, "APPROVED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// perCall.cap → BLOCKED_PER_CALL_CAP | ESCALATED_PER_CALL_CAP (per policy)
// ─────────────────────────────────────────────────────────────────────────────

describe("perCall.cap · BLOCKED/ESCALATED_PER_CALL_CAP (§7.1 RULE_EVAL)", () => {
  const overCap = validIntent({ amount: 2.0, maxAmount: 1_000_000_000n }); // high maxAmount so intent-bound passes first

  test("over cap with onPerCallCapExceeded BLOCK ⇒ BLOCKED_PER_CALL_CAP; trace shows amount vs cap", () => {
    const d = evaluateIntent(overCap, policyWith({ perCallCap: 1.0, onPerCallCapExceeded: "BLOCK" }), emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_PER_CALL_CAP");
    const p = rule(d.rules, "perCall.cap");
    assert.equal(p?.result, "FAIL");
    assert.equal(p?.observed, "2.00");
    assert.equal(p?.limit, "1.00");
    assert.equal(p?.token, "USDT");
  });

  test("over cap with onPerCallCapExceeded ESCALATE ⇒ ESCALATED_PER_CALL_CAP (result still FAIL)", () => {
    const d = evaluateIntent(overCap, policyWith({ perCallCap: 1.0, onPerCallCapExceeded: "ESCALATE" }), emptyLedger(), opts);
    assert.equal(d.decision, "ESCALATED_PER_CALL_CAP");
    assert.equal(rule(d.rules, "perCall.cap")?.result, "FAIL");
  });

  test("over cap with onPerCallCapExceeded omitted ⇒ defaults to BLOCK (conservative)", () => {
    const base = activePolicy();
    const { onPerCallCapExceeded: _omit, ...rulesNoMode } = base.rules;
    const policyNoMode: Policy = { ...base, rules: { ...rulesNoMode, perCallCap: 1.0 } };
    const d = evaluateIntent(overCap, policyNoMode, emptyLedger(), opts);
    assert.equal(d.decision, "BLOCKED_PER_CALL_CAP");
  });

  test("at/under the cap ⇒ APPROVED", () => {
    const d = evaluateIntent(validIntent({ amount: 0.5 }), policyWith({ perCallCap: 1.0 }), emptyLedger(), opts);
    assert.equal(d.decision, "APPROVED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rate.limit → BLOCKED_RATE
// ─────────────────────────────────────────────────────────────────────────────

describe("rate.limit · BLOCKED_RATE (§7.1 RULE_EVAL)", () => {
  test("this call would exceed callsPerHour ⇒ BLOCKED_RATE; trace shows projected count vs cap", () => {
    const d = evaluateIntent(validIntent(), policyWith({ rateLimit: { callsPerHour: 40 } }), emptyLedger({ callsInLastHour: 40 }), opts);
    assert.equal(d.decision, "BLOCKED_RATE");
    const r = rule(d.rules, "rate.limit");
    assert.equal(r?.result, "FAIL");
    assert.equal(r?.observed, 41); // this call is #41 in the last hour
    assert.equal(r?.limit, 40);
  });

  test("this call lands exactly on the cap (boundary) ⇒ APPROVED", () => {
    const d = evaluateIntent(validIntent(), policyWith({ rateLimit: { callsPerHour: 40 } }), emptyLedger({ callsInLastHour: 39 }), opts);
    assert.equal(d.decision, "APPROVED");
    assert.equal(rule(d.rules, "rate.limit")?.observed, 40); // the 40th call, == cap, allowed
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// escalate.aboveThreshold → ESCALATED_THRESHOLD (this package's first ESCALATED outcome family)
// ─────────────────────────────────────────────────────────────────────────────

describe("escalate.aboveThreshold · ESCALATED_THRESHOLD (§7.1 RULE_EVAL)", () => {
  test("amount above escalateAbove ⇒ ESCALATED_THRESHOLD; trace shows amount vs threshold", () => {
    const intent = validIntent({ amount: 6.0, maxAmount: 1_000_000_000n });
    const d = evaluateIntent(intent, policyWith({ escalateAbove: 5.0 }), emptyLedger(), opts);
    assert.equal(d.decision, "ESCALATED_THRESHOLD");
    const e = rule(d.rules, "escalate.aboveThreshold");
    assert.equal(e?.result, "FAIL");
    assert.equal(e?.observed, "6.00");
    assert.equal(e?.limit, "5.00");
    assert.equal(e?.token, "USDT");
  });

  test("amount at/under escalateAbove ⇒ APPROVED", () => {
    const intent = validIntent({ amount: 4.0, maxAmount: 1_000_000_000n });
    const d = evaluateIntent(intent, policyWith({ escalateAbove: 5.0 }), emptyLedger(), opts);
    assert.equal(d.decision, "APPROVED");
  });

  test("an ESCALATED outcome withholds — it does NOT commit to the ledger", async () => {
    // #given a ledger that counts commits
    let commits = 0;
    const ledger: Ledger = {
      read: () => emptyLedger(),
      commitApproved: () => {
        commits += 1;
      },
    };
    // #when an above-threshold intent is evaluated through the serialized entry point
    const intent = validIntent({ amount: 6.0, maxAmount: 1_000_000_000n });
    const d = await evaluateIntentSerialized(intent, policyWith({ escalateAbove: 5.0 }), ledger, opts);
    // #then it escalates and nothing is committed (only APPROVED commits)
    assert.equal(d.decision, "ESCALATED_THRESHOLD");
    assert.equal(commits, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ORDER CORRECTNESS — an intent that violates two rules fails on the EARLIER §7.1 rule
// ─────────────────────────────────────────────────────────────────────────────

describe("RULE_EVAL order · short-circuit picks the earlier §7.1 rule", () => {
  test("cooldown (earlier) beats budget (later): both would fail ⇒ BLOCKED_COOLDOWN, budget not reached", () => {
    // #given a call inside its service cooldown AND far over the daily budget
    const ledger = emptyLedger({
      lastCallByService: { [SERVICE_HOST]: NOW_MS - 60_000 }, // 1 min ago < 5 min cooldown
      budgetUsage: { settledToday: 0, reservedActiveToday: 100, effectiveToday: 100 }, // ≫ daily 25
    });
    const intent = validIntent({ amount: 20, maxAmount: 1_000_000_000n });
    // #when
    const d = evaluateIntent(intent, activePolicy(), ledger, opts);
    // #then cooldown (§7.1 #2) wins over budget (§7.1 #10); budget was never evaluated
    assert.equal(d.decision, "BLOCKED_COOLDOWN");
    assert.equal(rule(d.rules, "cooldown.sameService")?.result, "FAIL");
    assert.equal(rule(d.rules, "budget.daily"), undefined);
    assert.equal(rule(d.rules, "rate.limit"), undefined);
  });

  test("intent-bound (earlier) beats per-call cap and budget (later) ⇒ BLOCKED_INTENT_BOUND", () => {
    // #given amount over the intent's own max AND over per-call cap AND over budget
    const intent = validIntent({ amount: 50, maxAmount: 1_000_000n }); // 50.00 ≫ 1.00 max
    const ledger = emptyLedger({ budgetUsage: { settledToday: 0, reservedActiveToday: 100, effectiveToday: 100 }});
    const d = evaluateIntent(intent, policyWith({ perCallCap: 1.0 }), ledger, opts);
    // #then intent-bound (§7.1 #8) wins; per-call cap (#9) and budget (#10) never evaluated
    assert.equal(d.decision, "BLOCKED_INTENT_BOUND");
    assert.equal(rule(d.rules, "perCall.cap"), undefined);
    assert.equal(rule(d.rules, "budget.daily"), undefined);
  });

  test("budget (earlier) beats rate and escalate-above (later) ⇒ BLOCKED_BUDGET", () => {
    // #given over budget AND over the rate limit AND above the escalate threshold
    const ledger = emptyLedger({ budgetUsage: { settledToday: 0, reservedActiveToday: 100, effectiveToday: 100 }, callsInLastHour: 999 });
    const intent = validIntent({ amount: 20, maxAmount: 1_000_000_000n });
    const d = evaluateIntent(intent, policyWith({ escalateAbove: 5.0 }), ledger, opts);
    // #then budget (§7.1 #10) wins over rate (#11) and escalate-above (#13)
    assert.equal(d.decision, "BLOCKED_BUDGET");
    assert.equal(rule(d.rules, "rate.limit"), undefined);
    assert.equal(rule(d.rules, "escalate.aboveThreshold"), undefined);
  });
});
