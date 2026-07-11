import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_OPERATOR_ID, InMemoryOperatorsRepo } from "../src/operators";

/**
 * Operator-identity readiness (migration 004) — schema-readiness only, so the surface is small: the writes
 * are idempotent (safe to re-provision every boot), the (channel, handle) → operator map resolves, and a
 * second approver is additive. Nothing here is on the live §27 authority path yet (that still uses the
 * env-derived combineBindings); these tests just pin the readiness semantics.
 */

test("ensureBinding is idempotent and maps (channel, handle) → operator", async () => {
  const repo = new InMemoryOperatorsRepo();
  await repo.ensureBinding(DEMO_OPERATOR_ID, "telegram", "555");
  await repo.ensureBinding(DEMO_OPERATOR_ID, "discord", "111");
  await repo.ensureBinding(DEMO_OPERATOR_ID, "telegram", "555"); // re-provision (boot again) — no-op

  assert.equal(await repo.operatorForBinding("telegram", "555"), DEMO_OPERATOR_ID);
  assert.equal(await repo.operatorForBinding("discord", "111"), DEMO_OPERATOR_ID);
  assert.equal(await repo.operatorForBinding("slack", "999"), null, "unbound handle resolves to nobody");
});

test("ensurePolicyApprover is idempotent — one row per (policy, operator)", async () => {
  const repo = new InMemoryOperatorsRepo();
  await repo.ensurePolicyApprover("12", DEMO_OPERATOR_ID);
  await repo.ensurePolicyApprover("12", DEMO_OPERATOR_ID); // escalate again on the same policy — no dup
  assert.deepEqual(await repo.approversFor("12"), [DEMO_OPERATOR_ID]);
  assert.deepEqual(await repo.approversFor("unknown"), [], "a policy with no approver row has none");
});

test("a second approver is additive (one INSERT), not a schema change", async () => {
  const repo = new InMemoryOperatorsRepo();
  await repo.ensurePolicyApprover("12", DEMO_OPERATOR_ID);
  // The whole point of the readiness table: adding a second operator to a policy is data, not a migration.
  await repo.ensureBinding("op_second", "telegram", "777");
  await repo.ensurePolicyApprover("12", "op_second");
  assert.deepEqual((await repo.approversFor("12")).sort(), ["op_demo", "op_second"]);
  assert.equal(await repo.operatorForBinding("telegram", "777"), "op_second");
});
