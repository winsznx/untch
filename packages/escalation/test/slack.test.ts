import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackChannel } from "../src/slack";
import type { EscalationMessage } from "../src/channel";
import { fakeWsFactory } from "./helpers";

const config = {
  botToken: "xoxb-test",
  appToken: "xapp-test",
  userId: "U123",
  apiBase: "https://slack.test/api",
};

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── SEND ─────────────────────────────────────────────────────────────────────────────────────────

test("send opens a DM conversation then posts Block Kit buttons carrying the single-use code", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(init!.body as string) });
    if (url.endsWith("/conversations.open")) {
      return new Response(JSON.stringify({ ok: true, channel: { id: "D999" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, ts: "1700.01" }), { status: 200 });
  }) as unknown as typeof fetch;

  const channel = new SlackChannel({ config, fetchImpl, clock: () => 1000 });
  const res = await channel.send(message);

  assert.equal(res.ok, true);
  assert.equal(res.meta?.ts, "1700.01");
  assert.equal(calls[0]!.body.users, "U123");
  const post = calls[1]!.body as {
    channel: string;
    text: string;
    blocks: Array<{ type: string; elements?: Array<{ value: string; text: { text: string } }> }>;
  };
  assert.equal(post.channel, "D999");
  const actions = post.blocks.find((b) => b.type === "actions")!;
  assert.equal(actions.elements![0]!.value, "a:esc_abc:deadbeefcode");
  assert.equal(actions.elements![1]!.value, "d:esc_abc:deadbeefcode");
  assert.equal(actions.elements![0]!.text.text, "Approve");
  assert.ok(!post.text.includes("—"), "message copy must contain no em-dashes");
  assert.match(post.text, /spend 8 USDT/);
});

test("send surfaces a Slack API error as ok:false (never a silent success)", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/conversations.open")) {
      return new Response(JSON.stringify({ ok: false, error: "user_not_found" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, ts: "1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const channel = new SlackChannel({ config, fetchImpl });
  const res = await channel.send(message);
  assert.equal(res.ok, false);
  assert.match(res.detail ?? "", /user_not_found/);
});

// ── PARSE (pure normalization) ─────────────────────────────────────────────────────────────────────

test("parseEnvelope normalizes a block_actions button tap into a transport-neutral InboundResponse", () => {
  const channel = new SlackChannel({ config, clock: () => 2000 });
  const inbound = channel.parseEnvelope({
    type: "interactive",
    envelope_id: "env_1",
    payload: {
      type: "block_actions",
      user: { id: "U123" },
      actions: [{ action_id: "approve", value: "a:esc_abc:deadbeefcode" }],
    },
  });
  assert.ok(inbound);
  assert.equal(inbound!.channel, "slack");
  assert.equal(inbound!.senderHandle, "U123");
  assert.equal(inbound!.action, "APPROVE");
  assert.equal(inbound!.code, "deadbeefcode");
  assert.equal(inbound!.escalationRef, "esc_abc");
  assert.equal(inbound!.receivedAtMs, 2000);
});

test("parseEnvelope normalizes the DM text baseline and ignores bot messages + non-IM channels", () => {
  const channel = new SlackChannel({ config, clock: () => 3000 });
  const inbound = channel.parseEnvelope({
    type: "events_api",
    envelope_id: "env_2",
    payload: { event: { type: "message", channel_type: "im", user: "U123", text: "deny deadbeefcafe" } },
  });
  assert.ok(inbound);
  assert.equal(inbound!.action, "DENY");
  assert.equal(inbound!.code, "deadbeefcafe");
  assert.equal(inbound!.escalationRef, undefined);

  // The bot's own message must never be read as a command.
  assert.equal(
    channel.parseEnvelope({ type: "events_api", payload: { event: { type: "message", channel_type: "im", bot_id: "B1", text: "APPROVE deadbeef" } } }),
    null,
  );
  // A non-IM (channel) message is ignored — DM-only trust boundary.
  assert.equal(
    channel.parseEnvelope({ type: "events_api", payload: { event: { type: "message", channel_type: "channel", user: "U123", text: "APPROVE deadbeef" } } }),
    null,
  );
});

// ── SOCKET MODE LIFECYCLE (via a fake WebSocket) ───────────────────────────────────────────────────

test("socket mode: opens the WSS from apps.connections.open, acks every envelope, emits the tap", async () => {
  const { factory, sockets } = fakeWsFactory();
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/apps.connections.open")) {
      return new Response(JSON.stringify({ ok: true, url: "wss://slack-socket.test/link" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const inbounds: string[] = [];
  const channel = new SlackChannel({ config, fetchImpl, wsFactory: factory });
  const receiver = await channel.startReceiving(async (r) => {
    inbounds.push(`${r.channel}:${r.action}:${r.code}`);
  });

  const ws = sockets[0]!;
  assert.equal(ws.url, "wss://slack-socket.test/link", "connected to the URL Slack handed back");
  ws.receive({ type: "hello" });

  ws.receive({
    type: "interactive",
    envelope_id: "env_9",
    payload: { type: "block_actions", user: { id: "U123" }, actions: [{ action_id: "approve", value: "a:esc_abc:c0ffee00c0de" }] },
  });
  await sleep(5);
  assert.deepEqual(inbounds, ["slack:APPROVE:c0ffee00c0de"]);
  const ack = ws.sentJson().find((f) => f.envelope_id === "env_9");
  assert.ok(ack, "the envelope was acked by echoing its id");

  await receiver.stop();
});

test("socket mode: a server disconnect reconnects after the backoff", async () => {
  const { factory, sockets } = fakeWsFactory();
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/apps.connections.open")) {
      return new Response(JSON.stringify({ ok: true, url: "wss://slack-socket.test/link" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const channel = new SlackChannel({ config, fetchImpl, wsFactory: factory, reconnectBackoffMs: 10 });
  const receiver = await channel.startReceiving(async () => {});

  assert.equal(sockets.length, 1);
  sockets[0]!.receive({ type: "disconnect", reason: "link_disabled" });
  await sleep(40);
  assert.equal(sockets.length, 2, "reconnected after Slack asked us to disconnect");

  await receiver.stop();
});

test("socket mode: a bad app-level token backs off instead of hot-looping (never a silent connect)", async () => {
  const { factory, sockets } = fakeWsFactory();
  let opens = 0;
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/apps.connections.open")) {
      opens++;
      return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const channel = new SlackChannel({ config, fetchImpl, wsFactory: factory, reconnectBackoffMs: 15 });
  const receiver = await channel.startReceiving(async () => {});
  await sleep(80);
  await receiver.stop();

  assert.equal(sockets.length, 0, "no socket opened on invalid_auth");
  assert.ok(opens > 0 && opens < 12, `bounded retry under backoff, got ${opens} attempts`);
});
