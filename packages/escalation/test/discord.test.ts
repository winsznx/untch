import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordChannel } from "../src/discord";
import type { EscalationMessage } from "../src/channel";
import { fakeWsFactory } from "./helpers";

const config = {
  botToken: "BOTTOKEN",
  userId: "111222333",
  apiBase: "https://discord.test/api/v10",
  gatewayUrl: "wss://gw.test/",
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

test("send opens a DM then posts a message whose buttons carry the single-use code", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(init!.body as string) });
    if (url.endsWith("/users/@me/channels")) {
      return new Response(JSON.stringify({ id: "dm_9" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "msg_42" }), { status: 200 });
  }) as unknown as typeof fetch;

  const channel = new DiscordChannel({ config, fetchImpl, clock: () => 1000 });
  const res = await channel.send(message);

  assert.equal(res.ok, true);
  assert.equal(res.meta?.messageId, "msg_42");
  assert.equal(calls.length, 2, "one DM-open + one post");
  assert.equal(calls[0]!.body.recipient_id, "111222333");
  const post = calls[1]!.body as {
    content: string;
    components: Array<{ components: Array<{ custom_id: string; label: string }> }>;
  };
  const buttons = post.components[0]!.components;
  assert.equal(buttons[0]!.custom_id, "a:esc_abc:deadbeefcode");
  assert.equal(buttons[1]!.custom_id, "d:esc_abc:deadbeefcode");
  assert.equal(buttons[0]!.label, "Approve");
  assert.equal(buttons[1]!.label, "Deny");
  // Copy is plain — no em-dashes anywhere.
  assert.ok(!post.content.includes("—"), "message copy must contain no em-dashes");
  assert.match(post.content, /spend 8 USDT/);
});

test("send surfaces an open-DM failure as ok:false (never a silent success)", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/users/@me/channels")) {
      return new Response(JSON.stringify({ message: "Cannot send messages to this user" }), { status: 403 });
    }
    return new Response(JSON.stringify({ id: "msg_42" }), { status: 200 });
  }) as unknown as typeof fetch;
  const channel = new DiscordChannel({ config, fetchImpl });
  const res = await channel.send(message);
  assert.equal(res.ok, false);
  assert.match(res.detail ?? "", /Cannot send messages/);
});

// ── PARSE (pure normalization) ─────────────────────────────────────────────────────────────────────

test("parseDispatch normalizes a button INTERACTION_CREATE into a transport-neutral InboundResponse", () => {
  const channel = new DiscordChannel({ config, clock: () => 2000 });
  const inbound = channel.parseDispatch("INTERACTION_CREATE", {
    id: "int_1",
    token: "itok",
    type: 3,
    data: { custom_id: "a:esc_abc:deadbeefcode", component_type: 2 },
    user: { id: "111222333" },
    channel_id: "dm_9",
  });
  assert.ok(inbound);
  assert.equal(inbound!.channel, "discord");
  assert.equal(inbound!.senderHandle, "111222333");
  assert.equal(inbound!.action, "APPROVE");
  assert.equal(inbound!.code, "deadbeefcode");
  assert.equal(inbound!.escalationRef, "esc_abc");
  assert.equal(inbound!.receivedAtMs, 2000);
});

test("parseDispatch falls back to member.user.id and rejects a non-component interaction", () => {
  const channel = new DiscordChannel({ config });
  const viaMember = channel.parseDispatch("INTERACTION_CREATE", {
    id: "int_1",
    token: "t",
    type: 3,
    data: { custom_id: "d:esc_abc:deadbeefcode" },
    member: { user: { id: "555" } },
  });
  assert.equal(viaMember!.senderHandle, "555");
  assert.equal(viaMember!.action, "DENY");
  // type 2 = APPLICATION_COMMAND, not a component tap → ignored.
  assert.equal(channel.parseDispatch("INTERACTION_CREATE", { id: "x", token: "t", type: 2 }), null);
});

test("parseDispatch normalizes the DM text baseline and ignores bot messages + non-commands", () => {
  const channel = new DiscordChannel({ config, clock: () => 3000 });
  const inbound = channel.parseDispatch("MESSAGE_CREATE", {
    id: "m1",
    channel_id: "dm_9",
    author: { id: "111222333" },
    content: "APPROVE deadbeefcafe",
  });
  assert.ok(inbound);
  assert.equal(inbound!.senderHandle, "111222333");
  assert.equal(inbound!.action, "APPROVE");
  assert.equal(inbound!.code, "deadbeefcafe");
  assert.equal(inbound!.escalationRef, undefined, "text baseline carries no id");

  // The bot's own echoed message must never be read as a command.
  assert.equal(
    channel.parseDispatch("MESSAGE_CREATE", { id: "m2", channel_id: "dm_9", author: { id: "bot", bot: true }, content: "APPROVE deadbeef" }),
    null,
  );
  assert.equal(
    channel.parseDispatch("MESSAGE_CREATE", { id: "m3", channel_id: "dm_9", author: { id: "111222333" }, content: "hi" }),
    null,
  );
});

// ── GATEWAY LIFECYCLE (via a fake WebSocket) ───────────────────────────────────────────────────────

test("gateway: on HELLO it IDENTIFYs with the token + intents, answers server heartbeats, acks button taps", async () => {
  const { factory, sockets } = fakeWsFactory();
  const acks: string[] = [];
  const fetchImpl = (async (url: string) => {
    if (url.includes("/callback")) acks.push(url);
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;

  const inbounds: string[] = [];
  const channel = new DiscordChannel({ config, fetchImpl, wsFactory: factory, clock: () => 7000 });
  const receiver = await channel.startReceiving(async (r) => {
    inbounds.push(`${r.channel}:${r.action}:${r.code}`);
  });

  const ws = sockets[0]!;
  ws.receive({ op: 10, d: { heartbeat_interval: 45000 } });
  const identify = ws.sentJson().find((f) => f.op === 2);
  assert.ok(identify, "IDENTIFY sent after HELLO");
  assert.equal((identify!.d as { token: string }).token, "BOTTOKEN");
  assert.ok(((identify!.d as { intents: number }).intents & (1 << 12)) !== 0, "DIRECT_MESSAGES intent set");

  // A server-initiated heartbeat (op 1) is answered immediately.
  ws.receive({ op: 1 });
  assert.ok(ws.sentJson().some((f) => f.op === 1), "answered the server heartbeat");

  // A button tap dispatch → onInbound + an interaction ack POST.
  ws.receive({
    op: 0,
    s: 5,
    t: "INTERACTION_CREATE",
    d: { id: "int_9", token: "itok", type: 3, data: { custom_id: "a:esc_abc:c0ffee00c0de" }, user: { id: "111222333" } },
  });
  await sleep(5);
  assert.deepEqual(inbounds, ["discord:APPROVE:c0ffee00c0de"]);
  assert.equal(acks.length, 1, "interaction acked exactly once");

  await receiver.stop();
});

test("gateway: a close reconnects after the backoff (never gives up while running)", async () => {
  const { factory, sockets } = fakeWsFactory();
  const channel = new DiscordChannel({
    config,
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    wsFactory: factory,
    reconnectBackoffMs: 10,
  });
  const receiver = await channel.startReceiving(async () => {});

  assert.equal(sockets.length, 1);
  sockets[0]!.serverClose(4000, "dropped");
  await sleep(40);
  assert.equal(sockets.length, 2, "reconnected with a fresh socket after the backoff");

  await receiver.stop();
});
