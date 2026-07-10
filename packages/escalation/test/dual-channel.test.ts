import assert from "node:assert/strict";
import { test } from "node:test";
import { BOUND_HANDLE, approvals, escalationRequest, inbound, makeTriHarness } from "./helpers";

/**
 * The dual-channel rule (§27 pt6) — proven for REAL, not inert.
 *
 * With three real channels registered and the same operator bound on each ("one operator, three
 * surfaces"), an amount above `dualChannelAbove` now genuinely requires confirmation from two DISTINCT
 * channels. The positive path (channel A holds → channel B approves) and the negative path (the same
 * channel twice does NOT satisfy it) are both first-class here, exercised against the same
 * compare-and-set repo semantics Postgres enforces.
 */

const DUAL = { amount: 80, approvals: approvals({ dualChannelAbove: 50, channels: ["telegram", "discord", "slack"] }) };

// ── POSITIVE: two distinct channels reach APPROVED ─────────────────────────────────────────────────

test("dual-channel POSITIVE: telegram holds at AWAITING_SECOND_CHANNEL, discord approves → APPROVED", async () => {
  // #given an above-threshold escalation and one operator reachable on telegram, discord, slack
  const h = makeTriHarness();
  const { record, code } = await h.service.createEscalation(escalationRequest(DUAL));

  // #when the operator approves on the FIRST channel
  const first = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "telegram" }));
  // #then it is not APPROVED yet — a distinct second channel is required
  assert.equal(first.outcome, "AWAITING_SECOND_CHANNEL");
  assert.equal(first.status, "AWAITING_SECOND_CHANNEL");
  const held = await h.repo.getById(record.id);
  assert.deepEqual([...held!.approvedChannels], ["telegram"]);
  assert.equal((await h.service.getState(record.pollRef)).status, "PENDING", "guard still holds — not approved");

  // #when the operator then approves on a DISTINCT second channel
  const second = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "discord" }));
  // #then it transitions to APPROVED
  assert.equal(second.outcome, "APPROVED");
  assert.equal(second.status, "APPROVED");
  const resolved = await h.repo.getById(record.id);
  assert.deepEqual([...resolved!.approvedChannels].sort(), ["discord", "telegram"]);
  assert.equal(resolved!.resolvedBy!.channel, "discord");
  assert.equal((await h.service.getState(record.pollRef)).status, "APPROVED");
});

test("dual-channel POSITIVE: any two of the three distinct channels satisfy it (slack then telegram)", async () => {
  const h = makeTriHarness();
  const { record, code } = await h.service.createEscalation(escalationRequest(DUAL));

  const first = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "slack" }));
  assert.equal(first.outcome, "AWAITING_SECOND_CHANNEL");

  const second = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "telegram" }));
  assert.equal(second.outcome, "APPROVED");
});

// ── NEGATIVE: the same channel twice must NOT satisfy the rule ──────────────────────────────────────

test("dual-channel NEGATIVE: the SAME channel approving twice does NOT satisfy the rule (replay)", async () => {
  // #given an above-threshold escalation held after one telegram approval
  const h = makeTriHarness();
  const { record, code } = await h.service.createEscalation(escalationRequest(DUAL));
  const first = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "telegram" }));
  assert.equal(first.outcome, "AWAITING_SECOND_CHANNEL");

  // #when the SAME channel sends the code again (a second tap / a retry)
  const again = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "telegram" }));

  // #then it is rejected as a reused code, never counted as the distinct second channel
  assert.equal(again.outcome, "IGNORED_BAD_CODE");
  assert.equal(again.status, "AWAITING_SECOND_CHANNEL", "still held — one channel does not approve alone");
  const held = await h.repo.getById(record.id);
  assert.deepEqual([...held!.approvedChannels], ["telegram"], "the second same-channel tap added nothing");
  assert.equal(h.failed.at(-1)!.outcome, "IGNORED_BAD_CODE", "logged as a failed control event, not dropped");
  assert.equal((await h.service.getState(record.pollRef)).status, "PENDING", "guard still holds after the replay");
});

test("dual-channel NEGATIVE: same-channel twice then a real distinct channel still resolves APPROVED", async () => {
  const h = makeTriHarness();
  const { record, code } = await h.service.createEscalation(escalationRequest(DUAL));
  await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "discord" }));
  // A same-channel replay is rejected...
  const replay = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "discord" }));
  assert.equal(replay.outcome, "IGNORED_BAD_CODE");
  // ...and a genuinely distinct channel still completes the pair.
  const distinct = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "slack" }));
  assert.equal(distinct.outcome, "APPROVED");
});

// ── FAN-OUT across all three ────────────────────────────────────────────────────────────────────────

test("fan-out reaches all three registered channels when the policy lists them", async () => {
  const h = makeTriHarness();
  const { record } = await h.service.createEscalation(escalationRequest(DUAL));
  assert.equal(h.telegram.sent.length, 1);
  assert.equal(h.discord.sent.length, 1);
  assert.equal(h.slack.sent.length, 1);
  const fanned = record.channelLog.filter((e) => e.kind === "FANOUT").map((e) => e.channel).sort();
  assert.deepEqual(fanned, ["discord", "slack", "telegram"]);
});

test("below the dual threshold, a single channel approves directly (no second channel needed)", async () => {
  const h = makeTriHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ amount: 20, approvals: approvals({ dualChannelAbove: 50, channels: ["telegram", "discord", "slack"] }) }),
  );
  const res = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "discord" }));
  assert.equal(res.outcome, "APPROVED");
});

// ── ADVERSARIAL across the new channels (same standard as Telegram) ─────────────────────────────────

test("ADVERSARIAL discord wrong sender — a well-formed APPROVE from an unbound discord id is IGNORED_UNBOUND", async () => {
  const h = makeTriHarness();
  const { record, code } = await h.service.createEscalation(escalationRequest());
  const res = await h.service.handleInbound(
    inbound(code, { escalationRef: record.id, channel: "discord", senderHandle: "999attacker" }),
  );
  assert.equal(res.outcome, "IGNORED_UNBOUND");
  assert.equal(res.status, "PENDING");
  // A legitimate discord approval from the bound id still works afterwards.
  const ok = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "discord", senderHandle: BOUND_HANDLE }));
  assert.equal(ok.outcome, "APPROVED");
});

test("ADVERSARIAL slack replayed code — replaying a spent slack approval is IGNORED_ALREADY_RESOLVED", async () => {
  const h = makeTriHarness();
  const { record, code } = await h.service.createEscalation(escalationRequest());
  const first = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "slack" }));
  assert.equal(first.outcome, "APPROVED");
  const replay = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "slack" }));
  assert.equal(replay.outcome, "IGNORED_ALREADY_RESOLVED");
  assert.equal(replay.status, "APPROVED");
});

test("ADVERSARIAL discord expired code — an approval after the TTL is IGNORED_EXPIRED, defaults to DENY", async () => {
  const h = makeTriHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ approvals: approvals({ escalationTimeoutMin: 30, channels: ["telegram", "discord", "slack"] }) }),
  );
  h.clock.advance(31 * 60_000);
  const res = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "discord" }));
  assert.equal(res.outcome, "IGNORED_EXPIRED");
  assert.equal((await h.service.getState(record.pollRef)).status, "DENIED");
});
