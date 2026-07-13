import type { SlackConfig } from "./config";
import type { Channel, ChannelReceiver, ChannelSendResult, EscalationMessage } from "./channel";
import type { InboundResponse } from "./types";
import {
  approvePayload,
  denyPayload,
  parseButtonPayload,
  parseTextCommand,
  renderApprovalText,
} from "./wire-format";
import {
  defaultWebSocketFactory,
  frameToString,
  type WebSocketFactory,
  type WebSocketLike,
} from "./ws";

/**
 * The Slack `Channel` — the third real implementation of the same seam, DM to one bound operator (again a
 * private DM, never a public/team channel: a broadcast surface has a different trust model than a DM to a
 * single bound identity).
 *
 * Transport choice — SOCKET MODE over the Events API. Slack offers two ways to receive an operator's tap:
 * (a) Socket Mode, an OUTBOUND WebSocket the app opens with an app-level token (`apps.connections.open`
 * hands back a pre-authenticated WSS URL), or (b) the Events API, which requires a PUBLIC endpoint plus
 * signing-secret request verification. (b) adds a new externally-reachable surface; (a) needs no public
 * endpoint and mirrors the outbound-only shape the Telegram and Discord channels already have, so Socket
 * Mode is the consistent fit. Node's built-in `WebSocket` again means no @slack/* client dependency and
 * the same DI testability.
 *
 * Two transport jobs only: `send` a DM (`conversations.open` then `chat.postMessage`) with Approve/Deny
 * Block Kit buttons carrying the single-use code in the action `value`, and `startReceiving` normalizes
 * `block_actions` taps and the `APPROVE <code>` DM text baseline into `InboundResponse`s. Socket Mode
 * envelopes must be acked (echo `envelope_id`) within Slack's window; the service still applies the SAME
 * §27 authority boundary before any of it counts.
 */

type FetchImpl = typeof fetch;

const CHANNEL_NAME = "slack";

export interface SlackChannelOptions {
  readonly config: SlackConfig;
  /** DI for tests (mock Web API). Defaults to global fetch. */
  readonly fetchImpl?: FetchImpl;
  /** DI for tests (mock Socket Mode). Defaults to the global WebSocket. */
  readonly wsFactory?: WebSocketFactory;
  /** Backoff (ms) before reconnecting after a socket close/error or a failed apps.connections.open. */
  readonly reconnectBackoffMs?: number;
  /** DI clock (unix ms). Defaults to Date.now. */
  readonly clock?: () => number;
}

interface SlackEnvelope {
  type: string;
  envelope_id?: string;
  payload?: {
    type?: string;
    user?: { id?: string };
    actions?: Array<{ action_id?: string; value?: string }>;
    event?: { type?: string; channel_type?: string; user?: string; text?: string; bot_id?: string; ts?: string };
  };
  reason?: string;
}

export class SlackChannel implements Channel {
  readonly name = CHANNEL_NAME;
  private readonly cfg: SlackConfig;
  private readonly fetchImpl: FetchImpl;
  private readonly wsFactory: WebSocketFactory;
  private readonly reconnectBackoffMs: number;
  private readonly clock: () => number;

  constructor(opts: SlackChannelOptions) {
    this.cfg = opts.config;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.wsFactory = opts.wsFactory ?? defaultWebSocketFactory;
    this.reconnectBackoffMs = opts.reconnectBackoffMs ?? 3000;
    this.clock = opts.clock ?? Date.now;
  }

  private api(method: string): string {
    return `${this.cfg.apiBase}/${method}`;
  }

  async send(message: EscalationMessage): Promise<ChannelSendResult> {
    try {
      const open = await this.fetchImpl(this.api("conversations.open"), {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.botToken}`, "content-type": "application/json" },
        body: JSON.stringify({ users: this.cfg.userId }),
      });
      const openJson = (await open.json()) as { ok?: boolean; error?: string; channel?: { id?: string } };
      if (!openJson.ok || !openJson.channel?.id) {
        return { ok: false, detail: openJson.error ?? `conversations.open failed: HTTP ${open.status}` };
      }
      const channelId = openJson.channel.id;

      const res = await this.fetchImpl(this.api("chat.postMessage"), {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.botToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          channel: channelId,
          text: renderApprovalText(message),
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: renderApprovalText(message) } },
            {
              type: "actions",
              elements: [
                { type: "button", text: { type: "plain_text", text: "Approve" }, style: "primary", action_id: "approve", value: approvePayload(message) },
                { type: "button", text: { type: "plain_text", text: "Deny" }, style: "danger", action_id: "deny", value: denyPayload(message) },
              ],
            },
          ],
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; ts?: string };
      if (!json.ok) {
        return { ok: false, detail: json.error ?? `chat.postMessage failed: HTTP ${res.status}` };
      }
      return { ok: true, meta: { ts: json.ts, channelId } };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async startReceiving(
    onInbound: (r: InboundResponse) => Promise<void>,
  ): Promise<ChannelReceiver> {
    let running = true;
    let ws: WebSocketLike | null = null;

    const connect = async (): Promise<void> => {
      if (!running) return;
      let url: string;
      try {
        const res = await this.fetchImpl(this.api("apps.connections.open"), {
          method: "POST",
          headers: { authorization: `Bearer ${this.cfg.appToken}`, "content-type": "application/x-www-form-urlencoded" },
        });
        const json = (await res.json()) as { ok?: boolean; url?: string; error?: string };
        if (!json.ok || !json.url) {
          // A bad app-level token (or a rate-limit) returns immediately; back off so it can't hot-loop.
          scheduleReconnect();
          return;
        }
        url = json.url;
      } catch {
        scheduleReconnect();
        return;
      }
      if (!running) return;

      const socket = this.wsFactory(url);
      ws = socket;

      socket.addEventListener("message", (ev) => {
        const raw = frameToString(ev.data);
        if (raw === null) return;
        let envelope: SlackEnvelope;
        try {
          envelope = JSON.parse(raw) as SlackEnvelope;
        } catch {
          return;
        }

        // Every envelope Slack expects acked (echo the id) is acked immediately, before any §27 work.
        if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));

        if (envelope.type === "disconnect") {
          socket.close(1000, envelope.reason ?? "disconnect");
          return;
        }

        const inbound = this.parseEnvelope(envelope);
        if (!inbound) return;
        void onInbound(inbound).catch(() => {
          /* a handler error must not kill the receiver — the §27 failure is recorded in the log */
        });
      });

      socket.addEventListener("close", scheduleReconnect);
      socket.addEventListener("error", () => socket.close(1000, "socket error"));
    };

    const scheduleReconnect = (): void => {
      if (ws) ws = null;
      if (!running) return;
      setTimeout(() => void connect(), this.reconnectBackoffMs).unref();
    };

    await connect();

    return {
      stop: async () => {
        running = false;
        ws?.close(1000, "receiver stopped");
        ws = null;
      },
    };
  }

  /** Pure normalization of a Socket Mode envelope → an `InboundResponse` (or null). */
  parseEnvelope(envelope: SlackEnvelope): InboundResponse | null {
    const payload = envelope.payload;
    if (!payload) return null;

    if (payload.type === "block_actions") {
      const action = payload.actions?.[0];
      const parsed = parseButtonPayload(action?.value);
      if (!parsed) return null;
      const userId = payload.user?.id;
      if (!userId) return null;
      return {
        channel: CHANNEL_NAME,
        senderHandle: userId,
        action: parsed.action,
        code: parsed.code,
        ...(parsed.escalationRef ? { escalationRef: parsed.escalationRef } : {}),
        receivedAtMs: this.clock(),
        meta: { via: "block_action", envelopeId: envelope.envelope_id },
      };
    }

    const event = payload.event;
    if (envelope.type === "events_api" && event?.type === "message" && event.channel_type === "im") {
      if (event.bot_id) return null;
      const parsed = parseTextCommand(event.text ?? "");
      if (!parsed) return null;
      const userId = event.user;
      if (!userId) return null;
      return {
        channel: CHANNEL_NAME,
        senderHandle: userId,
        action: parsed.action,
        code: parsed.code,
        receivedAtMs: this.clock(),
        meta: { via: "text", ts: event.ts },
      };
    }
    return null;
  }
}
