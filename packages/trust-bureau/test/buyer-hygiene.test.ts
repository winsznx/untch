import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ignoresVerificationRate,
  lateEscalationRate,
  outOfPolicyRate,
  unboundAcceptanceRate,
} from "../src/features/buyer";
import { VERIFY_SKIPPED_UNCOMMITTED } from "../src/decision-codes";
import {
  agentIdOf,
  approvedOrder,
  blockedOrder,
  escalation,
  failVerify,
  passVerify,
  verify,
  vendorIdOf,
} from "./helpers";

const V = vendorIdOf("api.vendor.example");
const A = agentIdOf(7n);

test("unbound_acceptance_rate = fraction of verifies that were SKIPPED_UNCOMMITTED", () => {
  assert.equal(unboundAcceptanceRate([]).badness, 0);
  const vs = [
    passVerify(V, A),
    verify(V, A, VERIFY_SKIPPED_UNCOMMITTED, "store-committed"),
    verify(V, A, VERIFY_SKIPPED_UNCOMMITTED, "store-committed"),
  ];
  const r = unboundAcceptanceRate(vs);
  assert.ok(Math.abs(r.badness - 2 / 3) < 1e-9);
  assert.equal(r.n, 3);
});

test("ignores_verification_rate flags a later approved spend to the same vendor after a fail", () => {
  const fail = failVerify(V, A, "store-committed"); // createdAt from the seq clock
  const laterApproved = approvedOrder(V, A, { at: "2999-01-01T00:00:00.000Z" });
  const r = ignoresVerificationRate([laterApproved], [fail]);
  assert.equal(r.badness, 1, "the fail was followed by another approved spend to the same vendor");

  const noFollowUp = ignoresVerificationRate([], [failVerify(V, A)]);
  assert.equal(noFollowUp.badness, 0);

  assert.equal(ignoresVerificationRate([approvedOrder(V, A)], []).badness, 0, "no fails ⇒ nothing to ignore");
});

test("out_of_policy_rate = fraction of decisions that were BLOCKED_*", () => {
  const orders = [approvedOrder(V, A), blockedOrder(V, A), blockedOrder(V, A), approvedOrder(V, A)];
  const r = outOfPolicyRate(orders);
  assert.equal(r.badness, 0.5);
  assert.equal(outOfPolicyRate([]).badness, 0);
});

test("late_escalation_rate counts timeouts and past-window resolutions", () => {
  const onTime = escalation("0x1", "APPROVED", {
    createdAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: "2026-01-01T00:10:00.000Z",
    codeExpiresAt: "2026-01-01T00:30:00.000Z",
  });
  const expired = escalation("0x2", "EXPIRED", { codeExpiresAt: "2026-01-01T00:30:00.000Z" });
  const lateResolve = escalation("0x3", "APPROVED", {
    createdAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: "2026-01-01T01:00:00.000Z",
    codeExpiresAt: "2026-01-01T00:30:00.000Z",
  });
  const r = lateEscalationRate([onTime, expired, lateResolve]);
  assert.ok(Math.abs(r.badness - 2 / 3) < 1e-9, "expired + past-window = 2 of 3 late");
  assert.equal(lateEscalationRate([]).badness, 0);
});
