import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CONSUMER_INTENT_STATES,
  EXPIRABLE_STATES,
  InvalidStateTransitionError,
  POST_PAYMENT_STATES,
  TERMINAL_STATES,
  assertTransition,
  canTransition,
  isPostPayment,
  isTerminal,
  successorsOf,
  type ConsumerIntentState,
} from "../src/index";

/**
 * These are PROPERTY tests over the whole transition map, not spot checks. A spot check proves the
 * one edge it names; the properties below prove that no edge anywhere in the map — including one
 * added next year — can violate the rule.
 */

describe("state machine — the money-safety properties", () => {
  test("PROPERTY: FAILED_BEFORE_PAYMENT is unreachable from every post-payment state", () => {
    // The single most important invariant in the Consumer Pack. Once a payment may have left the
    // treasury, a lifecycle that can still claim "failed before payment" would let a refund be
    // issued for a purchase that actually happened.
    for (const state of POST_PAYMENT_STATES) {
      assert.equal(
        canTransition(state, "FAILED_BEFORE_PAYMENT"),
        false,
        `${state} must not be able to reach FAILED_BEFORE_PAYMENT`,
      );
    }
  });

  test("PROPERTY: no post-payment state can reach FAILED_BEFORE_PAYMENT even transitively", () => {
    // Stronger than the direct-edge check: walk the full reachable set from each post-payment state.
    for (const start of POST_PAYMENT_STATES) {
      const seen = new Set<ConsumerIntentState>();
      const queue: ConsumerIntentState[] = [start];
      while (queue.length > 0) {
        const cur = queue.pop();
        if (cur === undefined || seen.has(cur)) continue;
        seen.add(cur);
        for (const next of successorsOf(cur)) queue.push(next);
      }
      assert.equal(
        seen.has("FAILED_BEFORE_PAYMENT"),
        false,
        `FAILED_BEFORE_PAYMENT is transitively reachable from ${start} via ${[...seen].join(" → ")}`,
      );
    }
  });

  test("PROPERTY: MANUAL_REVIEW can never re-arm the automated payment path", () => {
    // A human may settle an ambiguous outcome. A human may not push it back into the executor,
    // because the executor would happily pay a second time.
    for (const next of successorsOf("MANUAL_REVIEW")) {
      assert.ok(
        next !== "EXECUTION_QUEUED" && next !== "PROVIDER_PAYMENT_PENDING",
        `MANUAL_REVIEW must not lead back to ${next}`,
      );
    }
  });

  test("PROPERTY: an ambiguous in-flight payment resolves only to PAID, FAILED_AFTER_PAYMENT or MANUAL_REVIEW", () => {
    assert.deepEqual(
      [...successorsOf("PROVIDER_PAYMENT_PENDING")].sort(),
      ["FAILED_AFTER_PAYMENT", "MANUAL_REVIEW", "PROVIDER_PAID"],
    );
  });

  test("PROPERTY: terminal states have no successors, and non-terminal states have at least one", () => {
    for (const state of CONSUMER_INTENT_STATES) {
      const successors = successorsOf(state);
      if (TERMINAL_STATES.has(state)) {
        assert.equal(successors.length, 0, `${state} is terminal but has successors`);
      } else {
        assert.ok(successors.length > 0, `${state} is non-terminal but is a dead end`);
      }
    }
  });

  test("PROPERTY: every successor is itself a declared state (no typos in the map)", () => {
    const all = new Set<string>(CONSUMER_INTENT_STATES);
    for (const state of CONSUMER_INTENT_STATES) {
      for (const next of successorsOf(state)) {
        assert.ok(all.has(next), `${state} → ${next} names a state that does not exist`);
      }
    }
  });

  test("PROPERTY: no state transitions to itself", () => {
    for (const state of CONSUMER_INTENT_STATES) {
      assert.equal(canTransition(state, state), false, `${state} must not self-transition`);
    }
  });

  test("PROPERTY: the only backward edge is FUNDED → AWAITING_FUNDING (chain reorg)", () => {
    const order = new Map(CONSUMER_INTENT_STATES.map((s, i) => [s, i]));
    const happyPath: ConsumerIntentState[] = [
      "CREATED", "DISCOVERING", "QUOTED", "POLICY_CHECKING", "AWAITING_APPROVAL", "APPROVED",
      "AWAITING_FUNDING", "FUNDED", "EXECUTION_QUEUED", "PROVIDER_PAYMENT_PENDING", "PROVIDER_PAID",
      "PROVIDER_ACKNOWLEDGED", "DELIVERY_PENDING", "DELIVERY_VERIFIED", "COMPLETED",
    ];
    const onPath = new Set(happyPath);
    const backward: string[] = [];
    for (const state of happyPath) {
      for (const next of successorsOf(state)) {
        if (!onPath.has(next)) continue;
        const from = order.get(state);
        const to = order.get(next);
        if (from !== undefined && to !== undefined && to < from) backward.push(`${state} → ${next}`);
      }
    }
    assert.deepEqual(backward, ["FUNDED → AWAITING_FUNDING"]);
  });

  test("PROPERTY: expirable states are all pre-execution", () => {
    // Once execution is armed, a timeout is an operational event for the worker, never a silent
    // expiry that could race a payment already in flight.
    for (const state of EXPIRABLE_STATES) {
      assert.equal(isPostPayment(state), false, `${state} is expirable but post-payment`);
      assert.notEqual(state, "EXECUTION_QUEUED");
    }
  });

  test("PROPERTY: every expirable state can actually reach EXPIRED", () => {
    for (const state of EXPIRABLE_STATES) {
      assert.ok(canTransition(state, "EXPIRED"), `${state} is swept for expiry but cannot become EXPIRED`);
    }
  });
});

describe("state machine — the happy path and its refusals", () => {
  test("the full happy path is legal end to end", () => {
    const path: ConsumerIntentState[] = [
      "CREATED", "DISCOVERING", "QUOTED", "POLICY_CHECKING", "AWAITING_APPROVAL", "APPROVED",
      "AWAITING_FUNDING", "FUNDED", "EXECUTION_QUEUED", "PROVIDER_PAYMENT_PENDING", "PROVIDER_PAID",
      "PROVIDER_ACKNOWLEDGED", "DELIVERY_PENDING", "DELIVERY_VERIFIED", "COMPLETED",
    ];
    for (let i = 0; i + 1 < path.length; i += 1) {
      const from = path[i];
      const to = path[i + 1];
      assert.ok(from !== undefined && to !== undefined);
      assertTransition(from, to);
    }
  });

  test("skipping funding is refused", () => {
    assert.throws(() => assertTransition("APPROVED", "EXECUTION_QUEUED"), InvalidStateTransitionError);
  });

  test("skipping the policy check is refused", () => {
    assert.throws(() => assertTransition("QUOTED", "APPROVED"), InvalidStateTransitionError);
  });

  test("a BLOCKED intent is final", () => {
    assert.ok(isTerminal("BLOCKED"));
    assert.throws(() => assertTransition("BLOCKED", "APPROVED"), InvalidStateTransitionError);
  });

  test("a COMPLETED intent cannot be refunded by a transition", () => {
    assert.throws(() => assertTransition("COMPLETED", "REFUND_PENDING"), InvalidStateTransitionError);
  });

  test("the error message names the legal successors", () => {
    try {
      assertTransition("QUOTED", "COMPLETED");
      assert.fail("expected a throw");
    } catch (e) {
      assert.ok(e instanceof InvalidStateTransitionError);
      assert.match(e.message, /legal: POLICY_CHECKING/);
    }
  });
});
