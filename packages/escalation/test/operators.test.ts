import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_OPERATOR_ID, InMemoryOperatorsRepo, OWNER_BINDING_CHANNEL } from "../src/operators";

/**
 * Operator-identity (migration 004) — now GENUINELY LOAD-BEARING for escalation routing + the §27
 * dashboard authority check: owner→operator resolution (`operatorForOwner`), the operator's reachable
 * channels (`channelsForOperator`), and the additive second-approver shape. These tests pin those
 * semantics; the asp `escalation-routing` tests prove the negative routing case end-to-end.
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

test("operatorForOwner resolves the operator by its OWNER WALLET (dashboard binding), case-insensitive", async () => {
  const repo = new InMemoryOperatorsRepo();
  const walletA = "0xAAaA000000000000000000000000000000000001";
  await repo.ensureOperator("op_a", "owner A");
  await repo.ensureBinding("op_a", OWNER_BINDING_CHANNEL, walletA.toLowerCase());

  // #then the owner resolves regardless of EIP-55 casing (an EVM address is the same address)
  assert.equal(await repo.operatorForOwner(walletA), "op_a");
  assert.equal(await repo.operatorForOwner(walletA.toUpperCase().replace("0X", "0x")), "op_a");
  // #and an unbound owner resolves to nobody (the caller decides the interim fallback)
  assert.equal(await repo.operatorForOwner("0x00000000000000000000000000000000000000ff"), null);
  // #and a wallet bound on a NON-owner channel is not an owner match
  await repo.ensureBinding("op_a", "telegram", "555");
  assert.equal(await repo.operatorForOwner("555"), null);
});

test("channelsForOperator lists every surface an operator is reachable on (the routing target)", async () => {
  const repo = new InMemoryOperatorsRepo();
  await repo.ensureOperator("op_a", "owner A");
  await repo.ensureBinding("op_a", OWNER_BINDING_CHANNEL, "0xowner");
  await repo.ensureBinding("op_a", "telegram", "555");
  await repo.ensureBinding("op_b", "slack", "u_b");

  const channels = (await repo.channelsForOperator("op_a")).map((b) => b.channel).sort();
  assert.deepEqual(channels, [OWNER_BINDING_CHANNEL, "telegram"].sort());
  // op_b's slack binding is NOT part of op_a's reachable set — the isolation routing relies on
  assert.deepEqual((await repo.channelsForOperator("op_b")).map((b) => b.channel), ["slack"]);
});

test("ensureOperator is idempotent (safe to re-provision every boot)", async () => {
  const repo = new InMemoryOperatorsRepo();
  await repo.ensureOperator("op_a", "owner A");
  await repo.ensureOperator("op_a", "owner A again"); // no throw, no duplicate
  await repo.ensureBinding("op_a", OWNER_BINDING_CHANNEL, "0xowner");
  assert.equal(await repo.operatorForOwner("0xowner"), "op_a");
});
