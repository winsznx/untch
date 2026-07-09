import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_RULES, STUBBED_RULES, evaluateIntent } from "../src/index";
import { activePolicy, emptyLedger, now, validIntent } from "./helpers";

/**
 * The manifest test. It pins EXACTLY which §7.1 rules are real and which are stubbed, so nobody
 * later mistakes this slice for the complete engine. Two independent sources must agree:
 *   1. the exported STUBBED_RULES / IMPLEMENTED_RULES constants, and
 *   2. what actually shows up in a live APPROVED trace (the `implemented:false` entries).
 *
 * This slice implements TEN of §7.1's thirteen RULE_EVAL rules (the original duplicate + budget
 * plus eight more) alongside the `policy.active` lookup, and leaves THREE stubbed.
 */

describe("rule manifest", () => {
  test("policy.active + exactly ten RULE_EVAL rules are implemented, in §7.1 order", () => {
    // #then the full real-rule list (the lookup + ten RULE_EVAL rules) is pinned, in trace order
    assert.deepEqual([...IMPLEMENTED_RULES], [
      "policy.active",
      "duplicate.taskHash_endpoint_paramsHash",
      "cooldown.sameService",
      "recipient.allowDeny",
      "agent.workerAllowDeny",
      "category.allow",
      "intent.maxAmountBound",
      "perCall.cap",
      "budget.daily",
      "rate.limit",
      "escalate.aboveThreshold",
    ]);
    // #and exactly ten of them are RULE_EVAL rules (the original 2 + 8 new); policy.active is the lookup
    const ruleEval = IMPLEMENTED_RULES.filter((r) => r !== "policy.active");
    assert.equal(ruleEval.length, 10, "exactly 10 RULE_EVAL rules are implemented");
  });

  test("exactly three §7.1 RULE_EVAL rules remain stubbed, in order; the sets are disjoint", () => {
    assert.deepEqual([...STUBBED_RULES], [
      "replay.contextBinding",
      "vendor.lcbFloor",
      "proof.tierRequired",
    ]);
    assert.equal(STUBBED_RULES.length, 3);
    const overlap = IMPLEMENTED_RULES.filter((r) => (STUBBED_RULES as readonly string[]).includes(r));
    assert.deepEqual(overlap, [], "no rule may be both implemented and stubbed");
  });

  test("a live APPROVED trace marks implemented:false on EXACTLY the STUBBED_RULES set", () => {
    // #when a clean intent approves, every stub runs and every real rule runs
    const d = evaluateIntent(validIntent(), activePolicy(), emptyLedger(), { now });
    assert.equal(d.decision, "APPROVED");
    // #then the implemented:false entries are exactly the stub manifest (same set, same order)
    const stubbedInTrace = d.rules.filter((r) => r.implemented === false).map((r) => r.rule);
    assert.deepEqual(stubbedInTrace, [...STUBBED_RULES]);
    // #and the real rules appear in the trace with no implemented flag (same set, same order)
    const realInTrace = d.rules.filter((r) => r.implemented === undefined).map((r) => r.rule);
    assert.deepEqual(realInTrace, [...IMPLEMENTED_RULES]);
  });
});
