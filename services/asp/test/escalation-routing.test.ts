import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChannelRegistry,
  DEMO_OPERATOR_ID,
  EscalationService,
  InMemoryEscalationsRepo,
  InMemoryOperatorsRepo,
  OWNER_BINDING_CHANNEL,
  combineBindings,
  interimDashboardBinding,
  type ApprovalsConfig,
  type Channel,
  type ChannelReceiver,
  type ChannelSendResult,
  type EscalationMessage,
  type InboundResponse,
} from "@untch/escalation";
import { getAddress, type Address } from "viem";
import {
  makeOwnershipVerifier,
  operatorChannelSet,
  routeEscalationToOwner,
} from "../src/escalation-routing";

/**
 * OWNER-BASED ESCALATION ROUTING (Part 2), incl. the explicit NEGATIVE case: an escalation on caller A's
 * policy notifies caller A's bound channels and NOT caller B's, and a dashboard approval by caller B of
 * caller A's escalation is refused by the §27 authority boundary. Same standard as every other negative
 * test in this build — B provably does not receive / cannot resolve A's escalation.
 */

const WALLET_A: Address = getAddress("0xAAaA000000000000000000000000000000000001");
const WALLET_B: Address = getAddress("0xBBbB000000000000000000000000000000000002");
const WALLET_C: Address = getAddress("0xCccC000000000000000000000000000000000003");

/** A Channel that just records what it was asked to send — so we can assert who got notified. */
class RecordingChannel implements Channel {
  readonly sent: EscalationMessage[] = [];
  constructor(readonly name: string) {}
  async send(message: EscalationMessage): Promise<ChannelSendResult> {
    this.sent.push(message);
    return { ok: true };
  }
  async startReceiving(): Promise<ChannelReceiver> {
    return { stop: async () => {} };
  }
}

const APPROVALS: ApprovalsConfig = {
  channels: [], // empty ⇒ the live registered channels; owner routing narrows within that
  dualChannelAbove: null,
  channelCaps: {},
  escalationTimeoutMin: 30,
};

/** Two operators, each bound to its OWN owner wallet + its OWN notification channel — full isolation. */
async function twoOperatorSetup() {
  const operators = new InMemoryOperatorsRepo();
  await operators.ensureOperator("op_a", "owner A");
  await operators.ensureBinding("op_a", OWNER_BINDING_CHANNEL, WALLET_A.toLowerCase());
  await operators.ensureBinding("op_a", "chanA", "handleA");
  await operators.ensureOperator("op_b", "owner B");
  await operators.ensureBinding("op_b", OWNER_BINDING_CHANNEL, WALLET_B.toLowerCase());
  await operators.ensureBinding("op_b", "chanB", "handleB");
  return operators;
}

test("routeEscalationToOwner: a bound owner routes to its OWN operator + channels (not the interim one)", async () => {
  const operators = await twoOperatorSetup();
  const routed = await routeEscalationToOwner({
    operators,
    owner: WALLET_A,
    policyId: "A1",
    interimOperatorId: DEMO_OPERATOR_ID,
  });
  assert.equal(routed.operatorId, "op_a");
  assert.deepEqual([...routed.restrictToChannels].sort(), [OWNER_BINDING_CHANNEL, "chanA"].sort());
  // op_a is recorded as the approver; op_b is NOT.
  assert.deepEqual(await operators.approversFor("A1"), ["op_a"]);
});

test("NEGATIVE fan-out: an escalation on A's policy notifies A's channel, NOT B's channel", async () => {
  // #given two isolated operators + a registry with both channels live
  const operators = await twoOperatorSetup();
  const chanA = new RecordingChannel("chanA");
  const chanB = new RecordingChannel("chanB");
  const registry = new ChannelRegistry();
  registry.register(chanA);
  registry.register(chanB);
  const service = new EscalationService({
    repo: new InMemoryEscalationsRepo(),
    registry,
    binding: () => true,
    clock: () => 1_000,
  });

  // #when caller A's policy escalates, routed to A's operator
  const routed = await routeEscalationToOwner({
    operators,
    owner: WALLET_A,
    policyId: "A1",
    interimOperatorId: DEMO_OPERATOR_ID,
  });
  await service.createEscalation(
    {
      pollRef: "poll-A1",
      intentId: "0xintentA",
      reason: "ESCALATED_THRESHOLD",
      policyId: "A1",
      amount: 8,
      token: "USDT",
      approvals: APPROVALS,
    },
    { restrictToChannels: routed.restrictToChannels },
  );

  // #then A's channel received the escalation and B's channel received NOTHING
  assert.equal(chanA.sent.length, 1, "A's channel should be notified");
  assert.equal(chanB.sent.length, 0, "B's channel must NOT receive A's escalation");
});

test("NEGATIVE authority: caller B cannot resolve caller A's escalation on the dashboard", async () => {
  // #given a dashboard-authorized escalation service whose ownership check reads the operator tables
  const operators = await twoOperatorSetup();
  const repo = new InMemoryEscalationsRepo();
  const dashboard = new RecordingChannel("dashboard");
  const registry = new ChannelRegistry();
  registry.register(dashboard);
  const now = 5_000;
  const service = new EscalationService({
    repo,
    registry,
    // Both wallets are bound operators (§27 pt3 passes for each); ownership decides who may resolve.
    binding: combineBindings(interimDashboardBinding(WALLET_A), interimDashboardBinding(WALLET_B)),
    identityAuthorizedChannels: new Set(["dashboard"]),
    verifyOwnership: makeOwnershipVerifier(operators),
    clock: () => now,
  });

  // #and an escalation on A's policy (A is recorded as its approver via routing)
  await routeEscalationToOwner({ operators, owner: WALLET_A, policyId: "A1", interimOperatorId: DEMO_OPERATOR_ID });
  const { record } = await service.createEscalation({
    pollRef: "poll-A1",
    intentId: "0xintentA",
    reason: "ESCALATED_THRESHOLD",
    policyId: "A1",
    amount: 8,
    token: "USDT",
    approvals: { ...APPROVALS, channels: ["dashboard"] },
  });

  const inbound = (wallet: Address): InboundResponse => ({
    channel: "dashboard",
    senderHandle: wallet,
    action: "APPROVE",
    code: "",
    escalationRef: record.id,
    receivedAtMs: now,
  });

  // #when caller B (owns a DIFFERENT policy) tries to approve A's escalation
  const bTry = await service.handleInbound(inbound(WALLET_B));
  // #then it is refused — B does not own A's policy
  assert.equal(bTry.outcome, "IGNORED_UNBOUND");
  assert.equal((await repo.getById(record.id))!.status, "PENDING", "B's attempt must not resolve it");

  // #when the real owner A approves
  const aTry = await service.handleInbound(inbound(WALLET_A));
  // #then it is honored
  assert.equal(aTry.outcome, "APPROVED");
  assert.equal((await repo.getById(record.id))!.status, "APPROVED");
});

test("makeOwnershipVerifier: only the policy's owner-operator passes; a foreign / unbound wallet fails", async () => {
  const operators = await twoOperatorSetup();
  await operators.ensurePolicyApprover("A1", "op_a");
  const verify = makeOwnershipVerifier(operators);
  const rec = { policyId: "A1" } as Parameters<ReturnType<typeof makeOwnershipVerifier>>[0];

  assert.equal(await verify(rec, WALLET_A), true, "owner A passes");
  assert.equal(await verify(rec, WALLET_B), false, "owner B (different policy) fails");
  assert.equal(await verify(rec, WALLET_C), false, "an unbound wallet fails");
});

test("interim fallback: an UNBOUND owner routes to the configured operator, but is itself made an approver", async () => {
  // #given only the interim operator is configured (its channels are the live surfaces)
  const operators = new InMemoryOperatorsRepo();
  await operators.ensureOperator(DEMO_OPERATOR_ID, "interim");
  await operators.ensureBinding(DEMO_OPERATOR_ID, "telegram", "555");

  // #when a policy owned by a not-yet-onboarded wallet escalates
  const routed = await routeEscalationToOwner({
    operators,
    owner: WALLET_C,
    policyId: "C1",
    interimOperatorId: DEMO_OPERATOR_ID,
  });

  // #then it is notified via the interim operator's channels (so the demo/live flow still fans out)
  assert.equal(routed.operatorId, DEMO_OPERATOR_ID);
  assert.deepEqual([...routed.restrictToChannels], ["telegram"]);
  // #and the owner is first-classed as its own operator AND an approver (so it can approve once onboarded)
  const approvers = (await operators.approversFor("C1")).sort();
  assert.ok(approvers.includes(DEMO_OPERATOR_ID), "interim operator can handle it now");
  assert.ok(approvers.some((id) => id.startsWith("op:0x")), "the owner is itself recorded as an approver");
  // #and resolving the owner now returns its freshly-provisioned operator (additive, not a migration)
  assert.equal(await operators.operatorForOwner(WALLET_C), `op:${WALLET_C.toLowerCase()}`);
  // #but the interim operator's channels do not leak into that new owner-operator's reachable set
  assert.deepEqual(await operatorChannelSet(operators, `op:${WALLET_C.toLowerCase()}`), new Set([OWNER_BINDING_CHANNEL]));
});
