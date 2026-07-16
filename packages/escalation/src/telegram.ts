import type { TelegramConfig } from "./config";
import type {
  Channel,
  ChannelReceiver,
  ChannelSendResult,
  EscalationMessage,
  GovernanceAlert,
} from "./channel";
import type { InboundResponse } from "./types";
import {
  approvePayload,
  denyPayload,
  parseButtonPayload,
  parseTextCommand,
  renderApprovalText,
  renderGovernanceText,
} from "./wire-format";

export { parseButtonPayload as parseCallbackData, parseTextCommand };

/**
 * The first real `Channel` implementation: Telegram (Discord and Slack are the other two — same seam,
 * same reply grammar, different transport).
 *
 * It does the two transport jobs and nothing else — sends an escalation with inline Approve/Deny
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
  /** Backoff (ms) after a transport error OR a non-ok Bot API response (invalid token, 429). Prevents a
   *  revoked/expired token from hot-looping getUpdates. Default 3000. */
  readonly errorBackoffMs?: number;
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
  private readonly errorBackoffMs: number;
  private readonly clock: () => number;

  constructor(opts: TelegramChannelOptions) {
    this.cfg = opts.config;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 25;
    this.errorBackoffMs = opts.errorBackoffMs ?? 3000;
    this.clock = opts.clock ?? Date.now;
  }

  private api(method: string): string {
    return `${this.cfg.apiBase}/bot${this.cfg.botToken}/${method}`;
  }

  async send(message: EscalationMessage): Promise<ChannelSendResult> {
    const text = renderApprovalText(message);
    const reply_markup = {
      inline_keyboard: [
        [
          { text: "Approve", callback_data: approvePayload(message) },
          { text: "Deny", callback_data: denyPayload(message) },
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

  /** Same bot, same chat, same transport as `send` — minus the inline keyboard, because there is
   * nothing here to approve. See `GovernanceAlert`. */
  async notify(alert: GovernanceAlert): Promise<ChannelSendResult> {
    try {
      const res = await this.fetchImpl(this.api("sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.cfg.chatId,
          text: renderGovernanceText(alert),
          disable_web_page_preview: true,
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
          const json = (await res.json()) as { ok: boolean; result?: TgUpdate[]; description?: string };
          if (!json.ok) {
            // A non-ok Bot API response (invalid/revoked token → 401, rate-limit → 429, etc.). This
            // returns IMMEDIATELY (no long-poll hold), so re-polling at once would hot-loop and hammer
            // the API. Back off. The escalation is safe in Postgres; the timeout still fails it closed.
            await sleep(this.errorBackoffMs);
            continue;
          }
          updates = json.result ?? [];
        } catch {
          // Transient transport failure — back off and retry; the escalation is safe in Postgres.
          await sleep(this.errorBackoffMs);
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
      const parsed = parseButtonPayload(cq.data);
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
