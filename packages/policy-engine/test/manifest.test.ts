import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_RULES, STUBBED_RULES, evaluateIntent } from "../src/index";
import { activePolicy, emptyLedger, now, validIntent } from "./helpers";

/**
 * Manifest: every §7.1 RULE_EVAL rule is real. STUBBED_RULES is empty. A live APPROVED
 * trace has no `implemented:false` entries.
 */

describe("rule manifest", () => {
  test("policy.active + all thirteen RULE_EVAL rules are implemented, in §7.1 order", () => {
    assert.deepEqual([...IMPLEMENTED_RULES], [
      "policy.active",
      "duplicate.taskHash_endpoint_paramsHash",
      "cooldown.sameService",
      "replay.contextBinding",
      "recipient.allowDeny",
      "agent.workerAllowDeny",
      "category.allow",
      "vendor.lcbFloor",
      "intent.maxAmountBound",
      "perCall.cap",
      "budget.daily",
      "rate.limit",
      "proof.tierRequired",
      "escalate.aboveThreshold",
    ]);
    const ruleEval = IMPLEMENTED_RULES.filter((r) => r !== "policy.active");
    assert.equal(ruleEval.length, 13, "exactly 13 RULE_EVAL rules are implemented");
  });

  test("no RULE_EVAL stubs remain", () => {
    assert.deepEqual([...STUBBED_RULES], []);
    assert.equal(STUBBED_RULES.length, 0);
  });

  test("a live APPROVED trace has no implemented:false entries and all real rules", () => {
    const d = evaluateIntent(validIntent(), activePolicy(), emptyLedger(), { now });
    assert.equal(d.decision, "APPROVED");
    const stubbedInTrace = d.rules.filter((r) => r.implemented === false).map((r) => r.rule);
    assert.deepEqual(stubbedInTrace, []);
    const realInTrace = d.rules.filter((r) => r.implemented === undefined).map((r) => r.rule);
    assert.deepEqual(realInTrace, [...IMPLEMENTED_RULES]);
  });
});
