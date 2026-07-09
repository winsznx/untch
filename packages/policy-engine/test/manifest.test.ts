import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_RULES, STUBBED_RULES, evaluateIntent } from "../src/index";
import { activePolicy, emptyLedger, now, validIntent } from "./helpers";

/**
 * The manifest test. It pins EXACTLY which §7.1 rules are real and which are stubbed, so nobody
 * later mistakes this slice for the complete engine. Two independent sources must agree:
 *   1. the exported STUBBED_RULES / IMPLEMENTED_RULES constants, and
 *   2. what actually shows up in a live APPROVED trace (the `implemented:false` entries).
 */

describe("rule manifest", () => {
  test("exactly three rules are implemented; the rest are stubbed; the sets are disjoint", () => {
    assert.deepEqual([...IMPLEMENTED_RULES], [
      "policy.active",
      "duplicate.taskHash_endpoint_paramsHash",
      "budget.daily",
    ]);
    assert.equal(STUBBED_RULES.length, 11);
    const overlap = IMPLEMENTED_RULES.filter((r) => (STUBBED_RULES as readonly string[]).includes(r));
    assert.deepEqual(overlap, [], "no rule may be both implemented and stubbed");
  });

  test("STUBBED_RULES enumerates every other §7.1 RULE_EVAL rule, in order", () => {
    assert.deepEqual([...STUBBED_RULES], [
      "cooldown.sameService",
      "replay.contextBinding",
      "recipient.allowDeny",
      "agent.workerAllowDeny",
      "category.allow",
      "vendor.lcbFloor",
      "intent.maxAmountBound",
      "perCall.cap",
      "rate.limit",
      "proof.tierRequired",
      "escalate.aboveThreshold",
    ]);
  });

  test("a live APPROVED trace marks implemented:false on EXACTLY the STUBBED_RULES set", () => {
    // #when a clean intent approves, every stub runs and every real rule runs
    const d = evaluateIntent(validIntent(), activePolicy(), emptyLedger(), { now });
    // #then the implemented:false entries are exactly the stub manifest (same set, same order)
    const stubbedInTrace = d.rules.filter((r) => r.implemented === false).map((r) => r.rule);
    assert.deepEqual(stubbedInTrace, [...STUBBED_RULES]);
    // #and the real rules appear in the trace with no implemented flag
    const realInTrace = d.rules.filter((r) => r.implemented === undefined).map((r) => r.rule);
    assert.deepEqual(realInTrace, [...IMPLEMENTED_RULES]);
  });
});
