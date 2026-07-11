import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelRegistry } from "../src/channel";
import type { EscalationMessage } from "../src/channel";
import { DashboardChannel } from "../src/dashboard";
import { InMemoryEscalationsRepo } from "../src/repo-memory";
import { EscalationService, type FailedControlEvent } from "../src/service";
import { interimDashboardBinding } from "../src/binding";
import type { InboundResponse } from "../src/types";
import { approvals, escalationRequest, fakeClock } from "./helpers";

/**
 * The dashboard `Channel` — the fourth real implementation of the same seam, authorized by SIWE session
 * identity (the operator's verified wallet is the bound handle). These tests prove it is a compliant
 * Channel (send + startReceiving) whose `toInbound` normalization runs through the SAME §27
 * authority-boundary check as every other channel: a bound wallet with a valid code approves; an unbound
 * wallet is IGNORED_UNBOUND; a bad code is IGNORED_BAD_CODE. Case-insensitivity of the EVM-address binding
 * is exercised end-to-end (configured with one checksum casing, approved from another).
 */

// The one demo operator's wallet, in EIP-55 mixed-case checksum form as it would be configured.
const CONFIGURED_WALLET = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
// The SAME address as presented by the session in a different (all-lowercase) checksum casing.
const SESSION_WALLET_LOWER = "0xabcdef0123456789abcdef0123456789abcdef01";
const UNBOUND_WALLET = "0x00000000000000000000000000000000deadbeef";

const message: EscalationMessage = {
  escalationId: "esc_abc",
  intentId: "0xintent",
  reason: "ESCALATED_THRESHOLD",
  amount: 8,
  token: "USDT",
  policyId: "12",
  code: "deadbeefcode",
  expiresAt: new Date(1000 + 30 * 60_000).toISOString(),
};

interface DashboardHarness {
  readonly service: EscalationService;
  readonly repo: InMemoryEscalationsRepo;
  readonly dashboard: DashboardChannel;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly failed: FailedControlEvent[];
}

/** A service wired with ONLY the dashboard channel + its case-insensitive wallet binding. */
function makeDashboardHarness(): DashboardHarness {
  const repo = new InMemoryEscalationsRepo();
  const registry = new ChannelRegistry();
  const clock = fakeClock();
  const dashboard = new DashboardChannel({ clock: clock.now });
  registry.register(dashboard);
  const failed: FailedControlEvent[] = [];
  let idSeq = 0;
  let codeSeq = 0;

  const service = new EscalationService({
    repo,
    registry,
    binding: interimDashboardBinding(CONFIGURED_WALLET),
    clock: clock.now,
    genId: () => `esc_${(++idSeq).toString(16).padStart(12, "0")}`,
    genCode: () => (++codeSeq).toString(16).padStart(24, "0"),
    scheduleTimeout: async () => {},
    defaultTimeoutMin: 30,
    maxTimeoutMin: 1440,
    onFailedControlEvent: (e) => failed.push(e),
  });

  return { service, repo, dashboard, clock, failed };
}

const dashboardApprovals = () =>
  approvals({ channels: ["dashboard"], dualChannelAbove: null, channelCaps: {}, escalationTimeoutMin: 30 });

// ── SEND (a pull surface: nothing external to deliver) ─────────────────────────────────────────────

test("send returns ok with rendered meta (a pull surface has nothing external to deliver)", async () => {
  const channel = new DashboardChannel();
  const res = await channel.send(message);
  assert.equal(res.ok, true);
  assert.equal(res.meta?.rendered, true);
});

// ── toInbound (pure normalization) ─────────────────────────────────────────────────────────────────

test("toInbound normalizes a dashboard action into a transport-neutral InboundResponse", () => {
  const channel = new DashboardChannel({ clock: () => 4242 });
  const inbound = channel.toInbound({
    senderHandle: SESSION_WALLET_LOWER,
    action: "APPROVE",
    code: "deadbeefcode",
    escalationRef: "esc_abc",
  });
  assert.equal(inbound.channel, "dashboard");
  assert.equal(inbound.senderHandle, SESSION_WALLET_LOWER);
  assert.equal(inbound.action, "APPROVE");
  assert.equal(inbound.code, "deadbeefcode");
  assert.equal(inbound.escalationRef, "esc_abc");
  assert.equal(inbound.receivedAtMs, 4242, "receivedAtMs comes from the injected clock");
  assert.equal(inbound.meta?.via, "dashboard");
});

test("toInbound omits escalationRef when absent (the by-code-hash baseline)", () => {
  const channel = new DashboardChannel({ clock: () => 1 });
  const inbound = channel.toInbound({ senderHandle: SESSION_WALLET_LOWER, action: "DENY", code: "c0ffee00c0de" });
  assert.equal(inbound.action, "DENY");
  assert.equal(inbound.escalationRef, undefined, "no id ⇒ resolved by code hash downstream");
});

// ── END-TO-END through the REAL §27 authority-boundary check ───────────────────────────────────────

test("a bound wallet (DIFFERENT checksum casing) with a valid code resolves APPROVED", async () => {
  const h = makeDashboardHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ approvals: dashboardApprovals() }),
  );
  assert.equal(record.status, "PENDING");
  assert.equal(record.channelLog.filter((e) => e.kind === "FANOUT").length, 1, "made available in the inbox");

  // Configured with the mixed-case wallet, approved from the all-lowercase form of the SAME address.
  const res = await h.service.handleInbound(
    h.dashboard.toInbound({ senderHandle: SESSION_WALLET_LOWER, action: "APPROVE", code, escalationRef: record.id }),
  );
  assert.equal(res.outcome, "APPROVED");
  assert.equal(res.status, "APPROVED");

  const stored = await h.repo.getById(record.id);
  assert.equal(stored!.resolvedBy!.channel, "dashboard");
  assert.equal(stored!.resolvedBy!.handle, SESSION_WALLET_LOWER, "records the handle as received");
  assert.equal((await h.service.getState(record.pollRef)).status, "APPROVED");
  assert.equal(h.failed.length, 0);
});

test("an unbound wallet is IGNORED_UNBOUND and the escalation stays PENDING", async () => {
  const h = makeDashboardHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ approvals: dashboardApprovals() }),
  );

  const res = await h.service.handleInbound(
    h.dashboard.toInbound({ senderHandle: UNBOUND_WALLET, action: "APPROVE", code, escalationRef: record.id }),
  );
  assert.equal(res.outcome, "IGNORED_UNBOUND");
  assert.equal(res.status, "PENDING", "escalation stays PENDING — the unbound wallet never counted");
  assert.equal(h.failed.at(-1)!.outcome, "IGNORED_UNBOUND", "logged as a failed control event, not dropped");
});

test("a bound wallet with a wrong code is IGNORED_BAD_CODE", async () => {
  const h = makeDashboardHarness();
  const { record } = await h.service.createEscalation(
    escalationRequest({ approvals: dashboardApprovals() }),
  );

  const res = await h.service.handleInbound(
    h.dashboard.toInbound({
      senderHandle: SESSION_WALLET_LOWER,
      action: "APPROVE",
      code: "deadbeefdeadbeefdeadbeef",
      escalationRef: record.id,
    }),
  );
  assert.equal(res.outcome, "IGNORED_BAD_CODE");
  assert.equal(res.status, "PENDING");
  assert.equal(h.failed.at(-1)!.outcome, "IGNORED_BAD_CODE");
});

// ── Channel compliance: startReceiving + submit + stop ─────────────────────────────────────────────

test("submit feeds the active receiver and throws with no receiver active", async () => {
  const channel = new DashboardChannel({ clock: () => 900 });

  // No receiver yet: a submit must be loud, never a silently dropped approval.
  await assert.rejects(
    () => channel.submit({ senderHandle: SESSION_WALLET_LOWER, action: "APPROVE", code: "abc123ff" }),
    /no active receiver/,
  );

  const delivered: InboundResponse[] = [];
  const receiver = await channel.startReceiving(async (r) => {
    delivered.push(r);
  });
  await channel.submit({ senderHandle: SESSION_WALLET_LOWER, action: "APPROVE", code: "abc123ff", escalationRef: "esc_1" });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.channel, "dashboard");
  assert.equal(delivered[0]!.code, "abc123ff");
  assert.equal(delivered[0]!.receivedAtMs, 900);

  // stop() releases the callback; a further submit is loud again.
  await receiver.stop();
  await assert.rejects(
    () => channel.submit({ senderHandle: SESSION_WALLET_LOWER, action: "DENY", code: "abc123ff" }),
    /no active receiver/,
  );
});
