import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramChannel, parseCallbackData, parseTextCommand } from "../src/telegram";

const config = { botToken: "TESTTOKEN", chatId: "555", apiBase: "https://tg.test" };

test("parseCallbackData reads approve/deny + id + code, rejects malformed", () => {
  assert.deepEqual(parseCallbackData("a:esc_abc:deadbeef"), {
    action: "APPROVE",
    code: "deadbeef",
    escalationRef: "esc_abc",
  });
  assert.deepEqual(parseCallbackData("d:esc_abc:deadbeef"), {
    action: "DENY",
    code: "deadbeef",
    escalationRef: "esc_abc",
  });
  assert.equal(parseCallbackData("x:esc_abc:deadbeef"), null);
  assert.equal(parseCallbackData("a:onlytwo"), null);
  assert.equal(parseCallbackData(undefined), null);
});

test("parseTextCommand reads the APPROVE/DENY <code> baseline case-insensitively", () => {
  assert.deepEqual(parseTextCommand("APPROVE deadbeefdead"), {
    action: "APPROVE",
    code: "deadbeefdead",
  });
  assert.deepEqual(parseTextCommand("  deny  DEADBEEFDEAD "), {
    action: "DENY",
    code: "DEADBEEFDEAD",
  });
  assert.equal(parseTextCommand("hello"), null);
  assert.equal(parseTextCommand("approve"), null, "no code ⇒ not a command");
});

test("send posts an inline keyboard whose buttons carry the single-use code", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
  }) as unknown as typeof fetch;

  const channel = new TelegramChannel({ config, fetchImpl, clock: () => 1000 });
  const res = await channel.send({
    escalationId: "esc_abc",
    intentId: "0xintent",
    reason: "ESCALATED_THRESHOLD",
    amount: 8,
    token: "USDT",
    policyId: "12",
    code: "deadbeefcode",
    expiresAt: new Date(1000 + 30 * 60_000).toISOString(),
  });

  assert.equal(res.ok, true);
  assert.equal(res.meta?.messageId, 42);
  assert.equal(calls.length, 1, "a request was made");
  const body = calls[0]!.body as {
    chat_id: string;
    reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
  };
  assert.equal(body.chat_id, "555");
  const buttons = body.reply_markup.inline_keyboard[0]!;
  assert.equal(buttons[0]!.callback_data, "a:esc_abc:deadbeefcode");
  assert.equal(buttons[1]!.callback_data, "d:esc_abc:deadbeefcode");
});

test("send surfaces a Bot API failure as ok:false (never a silent success)", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
      status: 400,
    })) as unknown as typeof fetch;
  const channel = new TelegramChannel({ config, fetchImpl });
  const res = await channel.send({
    escalationId: "esc_abc",
    intentId: "0xintent",
    reason: "ESCALATED_THRESHOLD",
    amount: 8,
    token: "USDT",
    policyId: "12",
    code: "deadbeefcode",
    expiresAt: new Date().toISOString(),
  });
  assert.equal(res.ok, false);
  assert.match(res.detail ?? "", /chat not found/);
});

test("parseUpdate normalizes a callback_query into a transport-neutral InboundResponse", () => {
  const channel = new TelegramChannel({ config, clock: () => 2000 });
  const inbound = channel.parseUpdate({
    update_id: 1,
    callback_query: {
      id: "cq1",
      from: { id: 999, username: "op" },
      message: { message_id: 42, chat: { id: 555 } },
      data: "a:esc_abc:deadbeefcode",
    },
  });
  assert.ok(inbound);
  assert.equal(inbound!.channel, "telegram");
  assert.equal(inbound!.senderHandle, "555");
  assert.equal(inbound!.action, "APPROVE");
  assert.equal(inbound!.code, "deadbeefcode");
  assert.equal(inbound!.escalationRef, "esc_abc");
  assert.equal(inbound!.receivedAtMs, 2000);
});

test("parseUpdate normalizes a text-baseline message and ignores non-commands", () => {
  const channel = new TelegramChannel({ config, clock: () => 3000 });
  const inbound = channel.parseUpdate({
    update_id: 2,
    message: { message_id: 7, chat: { id: 555 }, from: { id: 999 }, text: "APPROVE deadbeefcafe" },
  });
  assert.ok(inbound);
  assert.equal(inbound!.senderHandle, "555");
  assert.equal(inbound!.action, "APPROVE");
  assert.equal(inbound!.code, "deadbeefcafe");
  assert.equal(inbound!.escalationRef, undefined, "text baseline carries no id");

  assert.equal(
    channel.parseUpdate({ update_id: 3, message: { message_id: 8, chat: { id: 555 }, text: "hi" } }),
    null,
  );
});
