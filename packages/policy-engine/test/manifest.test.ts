import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ENGINE_VERSION,
  IMPLEMENTED_RULES,
  RULE_MANIFEST_HASH,
  STUBBED_RULES,
  evaluateIntent,
} from "../src/index";
import { activePolicy, emptyLedger, now, validIntent } from "./helpers";

/**
 * Manifest: every §7.1 RULE_EVAL rule is real. STUBBED_RULES is empty. A live APPROVED
 * trace has no `implemented:false` entries.
 *
 * `hardCap.absolute` is the fourteenth, added when it emerged that `hardCap` was collected from the
 * user, written into the canonical ruleset, anchored on chain and shown as "nothing above N, approved
 * or not" while no rule read it. It sits BEFORE `perCall.cap` so a hard-cap breach blocks instead of
 * routing to a human who could approve the thing the ceiling exists to forbid.
 */

describe("rule manifest", () => {
  test("policy.active + all fourteen RULE_EVAL rules are implemented, in §7.1 order", () => {
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
      "hardCap.absolute",
      "perCall.cap",
      "budget.daily",
      "rate.limit",
      "proof.tierRequired",
      "escalate.aboveThreshold",
    ]);
    const ruleEval = IMPLEMENTED_RULES.filter((r) => r !== "policy.active");
    assert.equal(ruleEval.length, 14, "exactly 14 RULE_EVAL rules are implemented");
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

/**
 * The two rules that were committed to and not enforced.
 *
 * Both were found the same way: by running the engine against a policy actually registered on X Layer
 * mainnet, rather than against a fixture. Both had the same shape — a field the user chose, the hash
 * anchored, and the surface described, that no code read.
 */
describe("a policy hash commits to rules that are actually applied", () => {
  test("the hard cap blocks rather than escalating, so approval cannot cross it", () => {
    // #given a policy whose hard cap is below the requested amount
    const policy = activePolicy();
    const rules = { ...policy.rules, hardCap: 8, perCallCap: 8, escalateAbove: 5 };
    const capped = { ...policy, rules };

    // #when an amount above the hard cap is judged. `maxAmount` moves with it: `intent.maxAmountBound`
    // runs first and would otherwise be what decided, which would prove nothing about the hard cap.
    const base = validIntent();
    const d = evaluateIntent(
      { ...base, amount: 9, maxAmount: 9_000_000n },
      capped,
      emptyLedger(),
      { now },
    );

    // #then it is BLOCKED, and by the hard-cap rule specifically
    assert.equal(d.decision, "BLOCKED_PER_CALL_CAP");
    const decided = d.rules.filter((r) => r.result === "FAIL").map((r) => r.rule);
    assert.deepEqual(decided, ["hardCap.absolute"]);
    // It must not have reached the escalation rule: escalating a hard-cap breach would offer a human
    // the chance to approve exactly what the ceiling exists to forbid.
    assert.equal(d.rules.some((r) => r.rule === "escalate.aboveThreshold" && r.result === "FAIL"), false);
  });

  test("a policy with no hard cap is unaffected", () => {
    const policy = activePolicy();
    const { hardCap: _drop, ...withoutCap } = policy.rules as { hardCap?: number };
    const d = evaluateIntent(validIntent(), { ...policy, rules: withoutCap as typeof policy.rules }, emptyLedger(), { now });
    assert.equal(d.decision, "APPROVED");
  });

  test("the duplicate rule compares the tuple the policy configured, not a hardcoded one", () => {
    // #given a policy keyed on amount, and a prior intent at a DIFFERENT amount
    const policy = activePolicy();
    const rules = { ...policy.rules, duplicates: { ttlMin: 60, keys: ["provider", "capability", "amount", "recipient"] } };
    const keyed = { ...policy, rules };
    const intent = validIntent();
    const ledger = {
      ...emptyLedger(),
      recentIntents: [
        {
          intentId: "pi_prior",
          taskHash: intent.taskHash,
          endpoint: intent.endpoint,
          paramsHash: intent.paramsHash,
          createdAtMs: now() - 1000,
          // Same everything EXCEPT the amount.
          maxAmount: (intent.maxAmount + 1n).toString(),
          recipientAddress: intent.recipientAddress,
          category: intent.category,
        },
      ],
    };

    // #when the new intent differs only in amount
    const d = evaluateIntent(intent, keyed, ledger, { now });

    // #then it is NOT a duplicate. The old rule compared taskHash+endpoint+paramsHash and would have
    // blocked it, while its own trace label claimed the configured tuple had been applied.
    assert.notEqual(d.decision, "BLOCKED_DUPLICATE");
  });

  test("a configured duplicate key the engine cannot evaluate fails closed", () => {
    const policy = activePolicy();
    const rules = { ...policy.rules, duplicates: { ttlMin: 60, keys: ["provider", "somethingNobodyImplemented"] } };
    const d = evaluateIntent(validIntent(), { ...policy, rules }, emptyLedger(), { now });
    // Judging on a narrower tuple than the hash committed to is the defect. Refusing is the fix.
    assert.equal(d.decision, "BLOCKED_FAIL_CLOSED");
    assert.equal(d.rules.find((r) => r.result === "FAIL")?.unresolvableKey, "somethingNobodyImplemented");
  });
});

/**
 * A decision names the rules AND the code that read them.
 *
 * The policy hash commits to a ruleset. It says nothing about the evaluator, and today two rules
 * began being enforced for a policy anchored before either existed: same ruleset, same hash,
 * different verdicts. Without an evaluator identity those two evaluations are indistinguishable in
 * the record, and a dispute about a past decision has nothing to appeal to.
 */
describe("a decision identifies its evaluator", () => {
  test("every decision carries the engine version, manifest hash and rule count", () => {
    const d = evaluateIntent(validIntent(), activePolicy(), emptyLedger(), { now });
    assert.equal(d.evaluator.engineVersion, ENGINE_VERSION);
    assert.equal(d.evaluator.ruleManifestHash, RULE_MANIFEST_HASH);
    assert.equal(d.evaluator.ruleCount, IMPLEMENTED_RULES.length);
    assert.match(d.evaluator.ruleManifestHash, /^0x[0-9a-f]{64}$/);
  });

  test("the manifest hash changes when the rule list changes, and not otherwise", () => {
    // Recomputed here from the exported list, so a reordering or an added rule moves it.
    const recomputed = `0x${createHash("sha256").update(IMPLEMENTED_RULES.join("\n")).digest("hex")}`;
    assert.equal(RULE_MANIFEST_HASH, recomputed);
    const different = `0x${createHash("sha256").update([...IMPLEMENTED_RULES].reverse().join("\n")).digest("hex")}`;
    assert.notEqual(RULE_MANIFEST_HASH, different, "order is part of the identity");
  });

  test("a decision names the ruleset bytes, not only the policy row", () => {
    const policy = activePolicy();
    const withHash = { ...policy, policyHash: `0x${"ab".repeat(32)}` as const };
    const d = evaluateIntent(validIntent(), withHash, emptyLedger(), { now });
    assert.equal(d.policyHash, `0x${"ab".repeat(32)}`);
  });

  test("with no active policy the hash is null rather than a placeholder", () => {
    const d = evaluateIntent(validIntent(), null, emptyLedger(), { now });
    assert.equal(d.decision, "BLOCKED_NO_ACTIVE_POLICY");
    assert.equal(d.policyHash, null);
    // The evaluator is still named: which code decided to block is still worth knowing.
    assert.equal(d.evaluator.engineVersion, ENGINE_VERSION);
  });
});
