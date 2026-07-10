import type { TelegramConfig } from "./config";
import type { Channel, ChannelReceiver, ChannelSendResult, EscalationMessage } from "./channel";
import type { InboundResponse } from "./types";

/**
 * The one real `Channel` implementation: Telegram.
 *
 * It does the two transport jobs and nothing else — sends an escalation with inline APPROVE/DENY
 * buttons that carry the single-use code, and long-polls `getUpdates` to turn button callbacks (and the
 * "APPROVE <code>" / "DENY <code>" text baseline, §27) into transport-neutral `InboundResponse`s. It
 * makes NO authority decision: the service runs every response it emits through the §27 check. Swapping
 * this out for a Photon channel is a matter of implementing the same two methods.
 *
 * `callback_data` budget is 64 bytes; `a:<escId>:<code>` / `d:<escId>:<code>` fits comfortably
 * (esc_+12hex id, 24hex code) and lets the service resolve the escalation directly, then re-validate the
 * code against it.
 */

type FetchImpl = typeof fetch;

export interface TelegramChannelOptions {
  readonly config: TelegramConfig;
  /** DI for tests (mock Bot API). Defaults to global fetch. */
  readonly fetchImpl?: FetchImpl;
  /** getUpdates long-poll timeout, seconds. */
  readonly pollTimeoutSec?: number;
  /** DI clock (unix ms). Defaults to Date.now. */
  readonly clock?: () => number;
}

interface TgUser {
  id: number;
  username?: string;
}
interface TgChat {
  id: number;
}
interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

const CHANNEL_NAME = "telegram";

export class TelegramChannel implements Channel {
  readonly name = CHANNEL_NAME;
  private readonly cfg: TelegramConfig;
  private readonly fetchImpl: FetchImpl;
  private readonly pollTimeoutSec: number;
  private readonly clock: () => number;

  constructor(opts: TelegramChannelOptions) {
    this.cfg = opts.config;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 25;
    this.clock = opts.clock ?? Date.now;
  }

  private api(method: string): string {
    return `${this.cfg.apiBase}/bot${this.cfg.botToken}/${method}`;
  }

  async send(message: EscalationMessage): Promise<ChannelSendResult> {
    const text = renderMessage(message);
    const reply_markup = {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `a:${message.escalationId}:${message.code}` },
          { text: "⛔ Deny", callback_data: `d:${message.escalationId}:${message.code}` },
        ],
      ],
    };
    try {
      const res = await this.fetchImpl(this.api("sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.cfg.chatId,
          text,
          parse_mode: "Markdown",
          reply_markup,
        }),
      });
      const json = (await res.json()) as { ok: boolean; description?: string; result?: TgMessage };
      if (!res.ok || !json.ok) {
        return { ok: false, detail: json.description ?? `HTTP ${res.status}` };
      }
      return { ok: true, meta: { messageId: json.result?.message_id } };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async startReceiving(
    onInbound: (r: InboundResponse) => Promise<void>,
  ): Promise<ChannelReceiver> {
    let running = true;
    let offset = 0;

    const loop = async (): Promise<void> => {
      while (running) {
        let updates: TgUpdate[] = [];
        try {
          const res = await this.fetchImpl(this.api("getUpdates"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              offset,
              timeout: this.pollTimeoutSec,
              allowed_updates: ["message", "callback_query"],
            }),
          });
          const json = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
          updates = json.ok && json.result ? json.result : [];
        } catch {
          // Transient poll failure — back off briefly and retry; the escalation is safe in Postgres.
          await sleep(1000);
          continue;
        }

        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          const inbound = this.parseUpdate(update);
          if (!inbound) continue;
          try {
            await onInbound(inbound);
          } catch {
            /* a handler error must not kill the receiver — the audit trail records the failure */
          }
          if (update.callback_query) {
            await this.answerCallback(update.callback_query.id).catch(() => {});
          }
        }
      }
    };

    void loop();
    return {
      stop: async () => {
        running = false;
      },
    };
  }

  /** Pure normalization of a raw Telegram update → an `InboundResponse` (or null if not an approval). */
  parseUpdate(update: TgUpdate): InboundResponse | null {
    if (update.callback_query) {
      const cq = update.callback_query;
      const parsed = parseCallbackData(cq.data);
      if (!parsed) return null;
      const chat = cq.message?.chat.id;
      return {
        channel: CHANNEL_NAME,
        senderHandle: String(chat ?? cq.from.id),
        action: parsed.action,
        code: parsed.code,
        ...(parsed.escalationRef ? { escalationRef: parsed.escalationRef } : {}),
        receivedAtMs: this.clock(),
        meta: { via: "callback", fromId: cq.from.id, username: cq.from.username },
      };
    }
    if (update.message?.text) {
      const parsed = parseTextCommand(update.message.text);
      if (!parsed) return null;
      return {
        channel: CHANNEL_NAME,
        senderHandle: String(update.message.chat.id),
        action: parsed.action,
        code: parsed.code,
        receivedAtMs: this.clock(),
        meta: { via: "text", fromId: update.message.from?.id },
      };
    }
    return null;
  }

  private async answerCallback(callbackQueryId: string): Promise<void> {
    await this.fetchImpl(this.api("answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: "Received." }),
    });
  }
}

function renderMessage(m: EscalationMessage): string {
  const deadline = new Date(m.expiresAt).toISOString().replace("T", " ").slice(0, 19);
  return [
    `*Untch approval needed* — the agent asked to spend money the policy escalated.`,
    ``,
    `• Amount: *${m.amount} ${m.token}*`,
    `• Reason: \`${m.reason}\``,
    `• Policy: \`${m.policyId}\``,
    `• Intent: \`${m.intentId}\``,
    ``,
    `Approve or deny below. Expires *${deadline} UTC* — after that it defaults to DENY.`,
    `The model never touched the money; you decide.`,
  ].join("\n");
}

interface ParsedCommand {
  readonly action: "APPROVE" | "DENY";
  readonly code: string;
  readonly escalationRef?: string;
}

/** `a:<escId>:<code>` / `d:<escId>:<code>` (button) — the id lets the service resolve directly. */
export function parseCallbackData(data: string | undefined): ParsedCommand | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [tag, escalationRef, code] = parts;
  if (!escalationRef || !code) return null;
  if (tag === "a") return { action: "APPROVE", code, escalationRef };
  if (tag === "d") return { action: "DENY", code, escalationRef };
  return null;
}

/** `APPROVE <code>` / `DENY <code>` (§27 text baseline). Case-insensitive; no id, resolved by hash. */
export function parseTextCommand(text: string): ParsedCommand | null {
  const m = text.trim().match(/^(approve|deny)\s+([0-9a-fA-F]{8,})$/i);
  if (!m) return null;
  return {
    action: m[1]!.toUpperCase() === "APPROVE" ? "APPROVE" : "DENY",
    code: m[2]!,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
