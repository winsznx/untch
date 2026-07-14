import assert from "node:assert/strict";
import { test } from "node:test";
import { PhotonChannel, renderPhotonMessage, type SpectrumInbound, type SpectrumPort } from "../src/photon";
import type { EscalationMessage } from "../src/channel";
import { interimPhotonBinding } from "../src/binding";
import { makeHarness, approvals, escalationRequest, inbound } from "./helpers";

/**
 * The Photon (Spectrum Cloud / iMessage) channel — same rigor as Telegram/Discord/Slack, adapted to a
 * text-baseline, SDK-backed transport. No network: the real `spectrum-ts` SDK sits behind `SpectrumPort`
 * (see photon-spectrum.ts) and every test here injects a controllable fake port. The three named
 * adversarial cases (wrong sender, replayed code, expired code) run through a REAL PhotonChannel wired to
 * the real service + `interimPhotonBinding`, exactly as they run for the other channels.
 */

const OPERATOR = "+15551234567";
const CHANNEL_NAME = "imessage";

const message: EscalationMessage = {
  escalationId: "esc_abc",
  intentId: "0xintent",
  reason: "ESCALATED_THRESHOLD",
  amount: 8,
  token: "USDT",
  policyId: "12",
  code: "deadbeefc0de",
  expiresAt: new Date(1000 + 30 * 60_000).toISOString(),
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A controllable in-memory `SpectrumPort` — the fake analogue of the other channels' injected fetch/WS.
 * `deliver`/`endStream`/`throwStream` drive the inbound gRPC-stream analogue; `sends` records outbound.
 */
class FakeSpectrumPort implements SpectrumPort {
  readonly sends: Array<{ handle: string; text: string }> = [];
  sendError: string | null = null;
  closed = false;
  streamOpens = 0;
  private buffer: SpectrumInbound[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;
  private throwNext = false;

  async send(handle: string, text: string): Promise<{ id?: string }> {
    if (this.sendError) throw new Error(this.sendError);
    this.sends.push({ handle, text });
    return { id: `m${this.sends.length}` };
  }

  deliver(msg: SpectrumInbound): void {
    this.buffer.push(msg);
    this.wake();
  }
  endStream(): void {
    this.ended = true;
    this.wake();
  }
  throwStream(): void {
    this.throwNext = true;
    this.wake();
  }
  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *stream(): AsyncIterable<SpectrumInbound> {
    this.streamOpens++;
    this.ended = false;
    for (;;) {
      while (this.buffer.length) yield this.buffer.shift()!;
      if (this.throwNext) {
        this.throwNext = false;
        throw new Error("stream dropped");
      }
      if (this.ended) return;
      await new Promise<void>((r) => {
        this.waiter = r;
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.endStream();
  }
}

// ── SEND ─────────────────────────────────────────────────────────────────────────────────────────

test("send delivers the approval copy plus the reply grammar carrying the single-use code", async () => {
  const port = new FakeSpectrumPort();
  const channel = new PhotonChannel({ port, operatorHandle: OPERATOR });
  const res = await channel.send(message);

  assert.equal(res.ok, true);
  assert.equal(res.meta?.delivery, "accepted", "ok means ACCEPTED, never device-delivered");
  assert.equal(port.sends.length, 1);
  assert.equal(port.sends[0]!.handle, OPERATOR, "sent to the bound operator handle");
  const text = port.sends[0]!.text;
  assert.match(text, /spend 8 USDT/);
  assert.match(text, /Reply APPROVE deadbeefc0de or DENY deadbeefc0de\./, "text baseline carries the code");
  assert.ok(!text.includes("—"), "message copy must contain no em-dashes");
});

test("send surfaces a port error (e.g. shared-pool allowlist) as ok:false, never a silent success", async () => {
  const port = new FakeSpectrumPort();
  port.sendError = "Target not allowed for this project";
  const channel = new PhotonChannel({ port, operatorHandle: OPERATOR });
  const res = await channel.send(message);
  assert.equal(res.ok, false);
  assert.match(res.detail ?? "", /Target not allowed/);
});

// ── PARSE (pure normalization) ─────────────────────────────────────────────────────────────────────

test("toInbound normalizes an APPROVE text reply into a transport-neutral InboundResponse", () => {
  const channel = new PhotonChannel({ port: new FakeSpectrumPort(), operatorHandle: OPERATOR, clock: () => 2000 });
  const r = channel.toInbound({ text: "APPROVE deadbeefc0de", senderHandle: OPERATOR, id: "g1", service: "iMessage" });
  assert.ok(r);
  assert.equal(r!.channel, CHANNEL_NAME);
  assert.equal(r!.senderHandle, OPERATOR);
  assert.equal(r!.action, "APPROVE");
  assert.equal(r!.code, "deadbeefc0de");
  assert.equal(r!.escalationRef, undefined, "text baseline has no id — resolved by code hash");
  assert.equal(r!.receivedAtMs, 2000);
  assert.equal(r!.meta?.service, "iMessage");
});

test("toInbound normalizes DENY and ignores non-command text", () => {
  const channel = new PhotonChannel({ port: new FakeSpectrumPort(), operatorHandle: OPERATOR, clock: () => 1 });
  assert.equal(channel.toInbound({ text: "deny deadbeefcafe", senderHandle: OPERATOR, id: "g2" })!.action, "DENY");
  assert.equal(channel.toInbound({ text: "hi there", senderHandle: OPERATOR, id: "g3" }), null);
});

test("toInbound drops a message with no attributable sender (cannot be bound)", () => {
  const channel = new PhotonChannel({ port: new FakeSpectrumPort(), operatorHandle: OPERATOR });
  assert.equal(channel.toInbound({ text: "APPROVE deadbeefc0de", senderHandle: undefined, id: "g4" }), null);
});

// ── STREAM LIFECYCLE (via the fake port) ───────────────────────────────────────────────────────────

test("startReceiving consumes the stream and emits the operator's reply through onInbound", async () => {
  const port = new FakeSpectrumPort();
  const channel = new PhotonChannel({ port, operatorHandle: OPERATOR });
  const seen: string[] = [];
  const receiver = await channel.startReceiving(async (r) => {
    seen.push(`${r.channel}:${r.action}:${r.code}`);
  });

  port.deliver({ text: "APPROVE c0ffee00c0de", senderHandle: OPERATOR, id: "g9" });
  await sleep(10);
  assert.deepEqual(seen, ["imessage:APPROVE:c0ffee00c0de"]);

  await receiver.stop();
  assert.equal(port.closed, true, "stop() closes the underlying Spectrum connection");
});

test("a stream that ends re-opens after the backoff (reconnect, never silently deaf)", async () => {
  const port = new FakeSpectrumPort();
  const channel = new PhotonChannel({ port, operatorHandle: OPERATOR, reconnectBackoffMs: 10 });
  const receiver = await channel.startReceiving(async () => {});
  await sleep(5);
  assert.equal(port.streamOpens, 1);

  port.endStream();
  await sleep(40);
  assert.ok(port.streamOpens >= 2, `re-opened the stream after it ended (opens=${port.streamOpens})`);

  await receiver.stop();
});

test("a stream that throws backs off instead of hot-looping, and stop() halts it", async () => {
  const port = new FakeSpectrumPort();
  const channel = new PhotonChannel({ port, operatorHandle: OPERATOR, reconnectBackoffMs: 15 });
  const receiver = await channel.startReceiving(async () => {});
  await sleep(5);
  port.throwStream();
  await sleep(80);
  await receiver.stop();
  assert.ok(port.streamOpens > 1 && port.streamOpens < 12, `bounded retry under backoff, got ${port.streamOpens}`);
});

// ── ADVERSARIAL §27 — through a REAL PhotonChannel + the real service + interimPhotonBinding ─────────

/** A harness whose ONLY channel is a real PhotonChannel bound to OPERATOR, driven by a fake port. */
function makePhotonHarness() {
  const port = new FakeSpectrumPort();
  const channel = new PhotonChannel({ port, operatorHandle: OPERATOR });
  const h = makeHarness({ binding: interimPhotonBinding(OPERATOR) });
  h.registry.register(channel);
  return { ...h, port, channel };
}

/** A well-formed operator reply as it would arrive off the stream, normalized by the channel. */
function reply(channel: PhotonChannel, code: string, senderHandle: string, action: "APPROVE" | "DENY" = "APPROVE") {
  const r = channel.toInbound({ text: `${action} ${code}`, senderHandle, id: `g_${code}` });
  assert.ok(r, "expected a normalizable reply");
  return r!;
}

test("ADVERSARIAL wrong sender — an APPROVE from a different iMessage handle is IGNORED_UNBOUND", async () => {
  const h = makePhotonHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ approvals: approvals({ channels: [CHANNEL_NAME] }) }),
  );
  assert.equal(h.port.sends.length, 1, "fanned out to iMessage for real");
  assert.match(h.port.sends[0]!.text, new RegExp(`APPROVE ${code}`));

  const res = await h.service.handleInbound(reply(h.channel, code, "+15559999999"));
  assert.equal(res.outcome, "IGNORED_UNBOUND");
  assert.equal(res.status, "PENDING", "the spoof never counted");
  assert.equal(h.failed.at(-1)!.outcome, "IGNORED_UNBOUND", "logged as a failed control event, not dropped");

  // A subsequent LEGITIMATE reply from the bound operator still resolves it.
  const ok = await h.service.handleInbound(reply(h.channel, code, OPERATOR));
  assert.equal(ok.outcome, "APPROVED");
});

test("ADVERSARIAL replayed code — replaying a spent approval is never a second accept", async () => {
  const h = makePhotonHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ approvals: approvals({ channels: [CHANNEL_NAME] }) }),
  );
  const first = await h.service.handleInbound(reply(h.channel, code, OPERATOR));
  assert.equal(first.outcome, "APPROVED");

  const replay = await h.service.handleInbound(reply(h.channel, code, OPERATOR));
  assert.equal(replay.outcome, "IGNORED_ALREADY_RESOLVED");
  assert.equal(replay.status, "APPROVED");
  assert.equal(record.status, "PENDING", "the returned record is the creation snapshot; store is APPROVED");
});

test("ADVERSARIAL expired code — an approval after the TTL is IGNORED_EXPIRED and defaults to DENY", async () => {
  const h = makePhotonHarness();
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ approvals: approvals({ channels: [CHANNEL_NAME], escalationTimeoutMin: 30 }) }),
  );
  h.clock.advance(31 * 60_000);

  const res = await h.service.handleInbound(reply(h.channel, code, OPERATOR));
  assert.equal(res.outcome, "IGNORED_EXPIRED");
  assert.equal(res.status, "EXPIRED");
  assert.equal((await h.service.getState(record.pollRef)).status, "DENIED", "fail-closed to DENY");
});

test("the imessage channel satisfies the dual-channel rule as a DISTINCT second surface", async () => {
  // Reuse the shared harness (telegram live) + add a real PhotonChannel bound to the same operator, then
  // require two distinct channels above the threshold: telegram holds, imessage completes.
  const port = new FakeSpectrumPort();
  const channel = new PhotonChannel({ port, operatorHandle: OPERATOR });
  const h = makeHarness({
    binding: (ch, handle) =>
      (ch === "telegram" && handle === "OPERATOR") || (ch === CHANNEL_NAME && handle.toLowerCase() === OPERATOR),
  });
  h.registry.register(channel);
  const { record, code } = await h.service.createEscalation(
    escalationRequest({ amount: 80, approvals: approvals({ dualChannelAbove: 50, channels: ["telegram", CHANNEL_NAME] }) }),
  );

  const first = await h.service.handleInbound(inbound(code, { escalationRef: record.id, channel: "telegram" }));
  assert.equal(first.outcome, "AWAITING_SECOND_CHANNEL");

  const second = await h.service.handleInbound(reply(channel, code, OPERATOR));
  assert.equal(second.outcome, "APPROVED");
  assert.equal((await h.service.getState(record.pollRef)).status, "APPROVED");
});
