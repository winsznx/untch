import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelRegistry } from "../src/channel";
import { DashboardChannel } from "../src/dashboard";
import { InMemoryEscalationsRepo } from "../src/repo-memory";
import { EscalationService } from "../src/service";
import { interimDashboardBinding } from "../src/binding";
import type { EscalationRecord } from "../src/types";
import { approvals, escalationRequest, fakeClock } from "./helpers";

/**
 * The dashboard as an IDENTITY-AUTHORIZED channel: the §27 pt4 single-use code is replaced by an ownership
 * check, because a seller-created escalation's plaintext code is never available to the dashboard (only its
 * hash is stored) and the SIWE session already proves identity more strongly. Authority = (channel binding:
 * the session wallet is a dashboard operator) AND (ownership: the session wallet owns THIS escalation's
 * policy). These run against the SAME EscalationService + repo Telegram/Discord/Slack use — the dashboard
 * resolves the real shared record, not a parallel one.
 *
 * The negative case is the point: a wallet bound to the dashboard but NOT the owner of a given escalation's
 * policy must fail the §27 authority boundary — proven here, not assumed from read-scoping.
 */

const OWNER = "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b";
const OTHER = "0x1111111111111111111111111111111111111111";

// The escalation's policy "12" is owned by OWNER; any other policy id is unowned.
const POLICY_OWNERS: Record<string, string> = { "12": OWNER.toLowerCase() };
const verifyOwnership = async (rec: EscalationRecord, senderHandle: string): Promise<boolean> =>
  POLICY_OWNERS[rec.policyId] === senderHandle.trim().toLowerCase();

function makeIdentityHarness(sessionWallet: string) {
  const repo = new InMemoryEscalationsRepo();
  const registry = new ChannelRegistry();
  const clock = fakeClock();
  const dashboard = new DashboardChannel({ clock: clock.now });
  registry.register(dashboard);
  let idSeq = 0;
  let codeSeq = 0;
  const service = new EscalationService({
    repo,
    registry,
    binding: interimDashboardBinding(sessionWallet),
    identityAuthorizedChannels: new Set(["dashboard"]),
    verifyOwnership,
    clock: clock.now,
    genId: () => `esc_${(++idSeq).toString(16).padStart(12, "0")}`,
    genCode: () => (++codeSeq).toString(16).padStart(24, "0"),
    scheduleTimeout: async () => {},
    defaultTimeoutMin: 30,
    maxTimeoutMin: 1440,
  });
  return { service, repo, dashboard, clock };
}

const dashApprovals = () => approvals({ channels: ["dashboard"], escalationTimeoutMin: 30 });

test("identity path: the policy OWNER approves from the dashboard with NO code → the shared record is APPROVED", async () => {
  const h = makeIdentityHarness(OWNER); // signed-in session == the policy owner
  const { record } = await h.service.createEscalation(escalationRequest({ approvals: dashApprovals(), policyId: "12" }));
  assert.equal(record.status, "PENDING");

  // No code is supplied — authority is the SIWE session identity + policy ownership.
  const res = await h.service.handleInbound(
    h.dashboard.toInbound({ senderHandle: OWNER, action: "APPROVE", escalationRef: record.id }),
  );

  assert.equal(res.outcome, "APPROVED");
  assert.equal(res.status, "APPROVED");
  const after = await h.repo.getById(record.id);
  assert.equal(after?.status, "APPROVED");
  assert.deepEqual(after?.resolvedBy, { channel: "dashboard", handle: OWNER });
});

test("§27 NEGATIVE: a wallet bound to the dashboard but NOT the owner of this escalation is IGNORED — record stays PENDING", async () => {
  // The session wallet (OTHER) is itself bound to the dashboard channel, but escalation policy "12" is
  // owned by OWNER, not OTHER. This must fail the §27 authority boundary, not resolve.
  const h = makeIdentityHarness(OTHER);
  const { record } = await h.service.createEscalation(escalationRequest({ approvals: dashApprovals(), policyId: "12" }));

  const res = await h.service.handleInbound(
    h.dashboard.toInbound({ senderHandle: OTHER, action: "APPROVE", escalationRef: record.id }),
  );

  assert.equal(res.outcome, "IGNORED_UNBOUND");
  const after = await h.repo.getById(record.id);
  assert.equal(after?.status, "PENDING", "a non-owner approval must NOT resolve the escalation");
});

test("§27 NEGATIVE: a sender not bound to the dashboard channel at all is IGNORED_UNBOUND (binding boundary)", async () => {
  // Session binding is OWNER, but the inbound sender is a different wallet → fails the channel binding.
  const h = makeIdentityHarness(OWNER);
  const { record } = await h.service.createEscalation(escalationRequest({ approvals: dashApprovals(), policyId: "12" }));

  const res = await h.service.handleInbound(
    h.dashboard.toInbound({ senderHandle: OTHER, action: "APPROVE", escalationRef: record.id }),
  );
  assert.equal(res.outcome, "IGNORED_UNBOUND");
  assert.equal((await h.repo.getById(record.id))?.status, "PENDING");
});

test("identity path: a second dashboard approval after APPROVED is idempotently IGNORED_ALREADY_RESOLVED", async () => {
  const h = makeIdentityHarness(OWNER);
  const { record } = await h.service.createEscalation(escalationRequest({ approvals: dashApprovals(), policyId: "12" }));
  await h.service.handleInbound(h.dashboard.toInbound({ senderHandle: OWNER, action: "APPROVE", escalationRef: record.id }));
  const again = await h.service.handleInbound(
    h.dashboard.toInbound({ senderHandle: OWNER, action: "APPROVE", escalationRef: record.id }),
  );
  assert.equal(again.outcome, "IGNORED_ALREADY_RESOLVED");
});

test("identity path: the OWNER can DENY from the dashboard → the shared record is DENIED", async () => {
  const h = makeIdentityHarness(OWNER);
  const { record } = await h.service.createEscalation(escalationRequest({ approvals: dashApprovals(), policyId: "12" }));
  const res = await h.service.handleInbound(
    h.dashboard.toInbound({ senderHandle: OWNER, action: "DENY", escalationRef: record.id }),
  );
  assert.equal(res.outcome, "DENIED");
  assert.equal((await h.repo.getById(record.id))?.status, "DENIED");
});
