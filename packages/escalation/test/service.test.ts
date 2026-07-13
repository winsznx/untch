import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOUND_HANDLE,
  approvals,
  escalationRequest,
  inbound,
  makeHarness,
} from "./helpers";

/**
 * The §7.2 state machine + the §27 authority-boundary check, exercised against the in-memory repo with
 * a fake clock. The adversarial cases (wrong sender, replayed code, expired code) are first-class here:
 * each MUST be caught and logged as a failed control event, the escalation left un-approved — never a
 * silent accept.
 */

// ── CREATE → FAN_OUT → PENDING ────────────────────────────────────────────────────────────────────

test("create fans out to the live channel and lands PENDING with a scheduled timeout", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(escalationRequest());

  assert.equal(record.status, "PENDING");
  assert.equal(h.telegram.sent.length, 1);
  assert.equal(h.telegram.sent[0]!.code, code);
  assert.equal(record.channelLog.filter((e) => e.kind === "FANOUT").length, 1);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0]!.escalationId, record.id);
  // Only the hash is stored, never the plaintext code.
  assert.notEqual(record.approvalCodeHash, code);
});

test("all channels failing lands NOTIFY_FAILED but still schedules the timeout (clock runs)", async () => {
  const h = makeHarness();
  h.telegram.sendOk = false;
  const { record } = await h.service.createEscalation(escalationRequest());

  assert.equal(record.status, "NOTIFY_FAILED");
  assert.equal(record.channelLog.filter((e) => e.kind === "FANOUT_FAILED").length, 1);
  assert.equal(h.scheduled.length, 1, "timeout still scheduled so an unreachable operator fails closed");
});

test("a policy naming only an unregistered channel does not fan out and is never faked", async () => {
  const h = makeHarness();
  const { record } = await h.service.createEscalation(
    escalationRequest({ approvals: approvals({ channels: ["imessage"] }) }),
  );
  assert.equal(h.telegram.sent.length, 0, "telegram not in the policy's list ⇒ not used");
  assert.equal(record.status, "NOTIFY_FAILED", "no registered channel matched ⇒ notify failed, not faked");
});

// ── APPROVE happy path ────────────────────────────────────────────────────────────────────────────

test("a well-formed bound APPROVE resolves APPROVED and the guard poll() sees it", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(escalationRequest());

  const res = await h.service.handleInbound(inbound(code, { escalationRef: record.id }));
  assert.equal(res.outcome, "APPROVED");
  assert.equal(res.status, "APPROVED");

  const state = await h.service.getState(record.pollRef);
  assert.equal(state.status, "APPROVED");
  if (state.status === "APPROVED") {
    assert.equal(state.decision.decision, "APPROVED");
    assert.equal(state.decision.intentHash, record.intentId);
  }
  const stored = await h.repo.getById(record.id);
  assert.equal(stored!.resolvedBy!.channel, "telegram");
  assert.equal(stored!.resolvedBy!.handle, BOUND_HANDLE);
  assert.equal(h.failed.length, 0);
});

test("a bound DENY resolves DENIED and the guard poll() sees a default-safe DENY", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(escalationRequest());

  const res = await h.service.handleInbound(inbound(code, { action: "DENY", escalationRef: record.id }));
  assert.equal(res.outcome, "DENIED");

  const state = await h.service.getState(record.pollRef);
  assert.equal(state.status, "DENIED");
});

test("the text baseline (no escalationRef) resolves by code hash", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(escalationRequest());
  // No escalationRef — the "APPROVE <code>" path resolves purely by the code's hash.
  const res = await h.service.handleInbound(inbound(code));
  assert.equal(res.outcome, "APPROVED");
  assert.equal(res.escalationId, record.id);
});

// ── ADVERSARIAL: wrong sender ─────────────────────────────────────────────────────────────────────

test("ADVERSARIAL wrong sender — a well-formed APPROVE from an unbound handle is IGNORED_UNBOUND", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(escalationRequest());

  // Correct code, correct channel, but a DIFFERENT sender handle — the classic spoof.
  const res = await h.service.handleInbound(
    inbound(code, { escalationRef: record.id, senderHandle: "ATTACKER" }),
  );
  assert.equal(res.outcome, "IGNORED_UNBOUND");
  assert.equal(res.status, "PENDING", "escalation stays PENDING — the spoof never counted");

  const stored = await h.repo.getById(record.id);
  assert.equal(stored!.status, "PENDING");
  assert.equal(h.failed.at(-1)!.outcome, "IGNORED_UNBOUND", "logged as a failed control event, not dropped");

  // And a subsequent LEGITIMATE approval still works — the spoof didn't poison the escalation.
  const ok = await h.service.handleInbound(inbound(code, { escalationRef: record.id }));
  assert.equal(ok.outcome, "APPROVED");
});

test("ADVERSARIAL wrong channel — an approval on a channel the policy didn't authorize is IGNORED_UNBOUND", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ approvals: approvals({ channels: ["telegram"] }) }),
  );
  const res = await h.service.handleInbound(
    inbound(code, { escalationRef: record.id, channel: "webhook", senderHandle: BOUND_HANDLE }),
  );
  assert.equal(res.outcome, "IGNORED_UNBOUND");
});

// ── ADVERSARIAL: replayed code ────────────────────────────────────────────────────────────────────

test("ADVERSARIAL replayed code — replaying a spent approval is caught, never a second accept", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(escalationRequest());

  const first = await h.service.handleInbound(inbound(code, { escalationRef: record.id }));
  assert.equal(first.outcome, "APPROVED");

  // Exact same callback replayed — must be ignored as already-resolved, not honored again.
  const replay = await h.service.handleInbound(inbound(code, { escalationRef: record.id }));
  assert.equal(replay.outcome, "IGNORED_ALREADY_RESOLVED");
  assert.equal(replay.status, "APPROVED");
});

test("ADVERSARIAL replayed code on a dual-channel hold — same channel replay is IGNORED_BAD_CODE", async () => {
  const h = makeHarness();
  // dualChannelAbove below the amount ⇒ one telegram approval only moves to AWAITING_SECOND_CHANNEL.
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ amount: 80, approvals: approvals({ dualChannelAbove: 50 }) }),
  );
  const first = await h.service.handleInbound(inbound(code, { escalationRef: record.id }));
  assert.equal(first.outcome, "AWAITING_SECOND_CHANNEL");

  // Same channel replaying the code cannot count as the second, distinct channel — reused code.
  const replay = await h.service.handleInbound(inbound(code, { escalationRef: record.id }));
  assert.equal(replay.outcome, "IGNORED_BAD_CODE");
  assert.equal(replay.status, "AWAITING_SECOND_CHANNEL");
});

test("ADVERSARIAL bad code — a wrong code on a live escalation is IGNORED_BAD_CODE", async () => {
  const h = makeHarness();
  const { record } = await h.service.createEscalation(escalationRequest());
  const res = await h.service.handleInbound(
    inbound("deadbeefdeadbeefdeadbeef", { escalationRef: record.id }),
  );
  assert.equal(res.outcome, "IGNORED_BAD_CODE");
  assert.equal(h.failed.at(-1)!.outcome, "IGNORED_BAD_CODE");
});

// ── ADVERSARIAL: expired code ─────────────────────────────────────────────────────────────────────

test("ADVERSARIAL expired code — an approval after the TTL is IGNORED_EXPIRED and defaults to DENY", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ approvals: approvals({ escalationTimeoutMin: 30 }) }),
  );
  h.clock.advance(31 * 60_000); // past the 30-minute TTL

  const res = await h.service.handleInbound(inbound(code, { escalationRef: record.id }));
  assert.equal(res.outcome, "IGNORED_EXPIRED");
  assert.equal(res.status, "EXPIRED");

  // Fail-closed: the guard poll() now reads DENIED even though no timeout job ran.
  const state = await h.service.getState(record.pollRef);
  assert.equal(state.status, "DENIED");
});

// ── TIMEOUT → EXPIRED → default DENY (I2) ─────────────────────────────────────────────────────────

test("timeout fires EXPIRED → default DENY, and is idempotent / not-yet-due-safe", async () => {
  const h = makeHarness();
  const { record } = await h.service.createEscalation(
    escalationRequest({ approvals: approvals({ escalationTimeoutMin: 30 }) }),
  );

  // Not yet due — expire is a no-op.
  assert.equal(await h.service.expire(record.id), false);
  assert.equal((await h.repo.getById(record.id))!.status, "PENDING");

  h.clock.advance(30 * 60_000 + 1);
  assert.equal(await h.service.expire(record.id), true);
  assert.equal((await h.repo.getById(record.id))!.status, "EXPIRED");

  // Idempotent — a duplicate timeout job does nothing.
  assert.equal(await h.service.expire(record.id), false);

  const state = await h.service.getState(record.pollRef);
  assert.equal(state.status, "DENIED");
});

test("sweepExpired is a backstop that expires overdue escalations", async () => {
  const h = makeHarness();
  const a = await h.service.createEscalation(
    escalationRequest({ pollRef: "p_a", approvals: approvals({ escalationTimeoutMin: 10 }) }),
  );
  const b = await h.service.createEscalation(
    escalationRequest({ pollRef: "p_b", approvals: approvals({ escalationTimeoutMin: 60 }) }),
  );
  h.clock.advance(11 * 60_000); // a is overdue, b is not

  const n = await h.service.sweepExpired();
  assert.equal(n, 1);
  assert.equal((await h.repo.getById(a.record.id))!.status, "EXPIRED");
  assert.equal((await h.repo.getById(b.record.id))!.status, "PENDING");
});

test("a timeout after resolution never overturns the decision", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ approvals: approvals({ escalationTimeoutMin: 30 }) }),
  );
  await h.service.handleInbound(inbound(code, { escalationRef: record.id }));
  h.clock.advance(31 * 60_000);

  assert.equal(await h.service.expire(record.id), false);
  assert.equal((await h.repo.getById(record.id))!.status, "APPROVED");
});

// ── DUAL-CHANNEL (logic-level; inert with one live channel) ───────────────────────────────────────

test("dual-channel: above the threshold, a distinct second channel is required to reach APPROVED", async () => {
  // Register a second channel purely to prove the LOGIC — the live system has only Telegram, so this
  // path is inert there (documented). We never fake a live second channel; we test the state machine.
  const h = makeHarness({
    binding: (ch, handle) =>
      (ch === "telegram" || ch === "dashboard") && handle === BOUND_HANDLE,
  });
  const { record, code } = await h.service.createEscalation(
    escalationRequest({
      amount: 80,
      approvals: approvals({ dualChannelAbove: 50, channels: ["telegram", "dashboard"] }),
    }),
  );

  const first = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "telegram" }));
  assert.equal(first.outcome, "AWAITING_SECOND_CHANNEL");

  const second = await h.service.handleInbound(
    inbound(code, { escalationRef: record.id, channel: "dashboard" }),
  );
  assert.equal(second.outcome, "APPROVED");
  assert.equal((await h.service.getState(record.pollRef)).status, "APPROVED");
});

test("dual-channel with only one live channel stays AWAITING then times out to DENY (inert but correct)", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ amount: 80, approvals: approvals({ dualChannelAbove: 50, escalationTimeoutMin: 30 }) }),
  );
  const first = await h.service.handleInbound(inbound(code, { escalationRef: record.id }));
  assert.equal(first.outcome, "AWAITING_SECOND_CHANNEL");

  h.clock.advance(31 * 60_000);
  assert.equal(await h.service.expire(record.id), true);
  assert.equal((await h.service.getState(record.pollRef)).status, "DENIED");
});

test("below the dual threshold a single channel APPROVES directly", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ amount: 20, approvals: approvals({ dualChannelAbove: 50 }) }),
  );
  const res = await h.service.handleInbound(inbound(code, { escalationRef: record.id }));
  assert.equal(res.outcome, "APPROVED");
});

// ── CHANNEL CAPS (§27 pt5) ────────────────────────────────────────────────────────────────────────

test("channel cap: an amount above the channel's cap is IGNORED_CHANNEL_CAP", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ amount: 40, approvals: approvals({ channelCaps: { telegram: 25 } }) }),
  );
  const res = await h.service.handleInbound(inbound(code, { escalationRef: record.id }));
  assert.equal(res.outcome, "IGNORED_CHANNEL_CAP");
  assert.equal(res.status, "PENDING");
  assert.equal(h.failed.at(-1)!.outcome, "IGNORED_CHANNEL_CAP");
});

test("channel cap: an amount within the cap approves", async () => {
  const h = makeHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ amount: 10, approvals: approvals({ channelCaps: { telegram: 25 } }) }),
  );
  const res = await h.service.handleInbound(inbound(code, { escalationRef: record.id }));
  assert.equal(res.outcome, "APPROVED");
});

// ── NOT FOUND + resolver PENDING ──────────────────────────────────────────────────────────────────

test("an inbound for an unknown escalation is IGNORED_NOT_FOUND", async () => {
  const h = makeHarness();
  const res = await h.service.handleInbound(inbound("aaaaaaaaaaaaaaaaaaaaaaaa", { escalationRef: "esc_nope" }));
  assert.equal(res.outcome, "IGNORED_NOT_FOUND");
  assert.equal(res.escalationId, null);
  assert.equal(h.failed.at(-1)!.outcome, "IGNORED_NOT_FOUND");
});

test("getState for an uncreated escalation is PENDING (held, not yet created)", async () => {
  const h = makeHarness();
  const state = await h.service.getState("poll_unknown");
  assert.equal(state.status, "PENDING");
});
