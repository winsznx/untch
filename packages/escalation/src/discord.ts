import type { DiscordConfig } from "./config";
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
 * The Discord `Channel` — a second real implementation of the same seam Telegram uses, DM to one bound
 * operator (never a public server channel: a broadcast surface has a different trust model than a private
 * DM to a single bound identity).
 *
 * Transport choice — GATEWAY over interactions webhook. Discord offers two ways to receive an operator's
 * tap: (a) the gateway, a persistent OUTBOUND WebSocket the bot opens, or (b) an interactions webhook,
 * which requires a PUBLIC HTTPS endpoint plus Ed25519 request-signature verification. (b) adds a new
 * externally-reachable attack surface to a backend that today has none; (a) keeps the exact operational
 * shape the Telegram channel already has (an outbound long-lived connection, no inbound endpoint), so the
 * gateway is the consistent fit. It also matches Node's built-in `WebSocket` — no discord.js dependency,
 * and the same fetch/WS dependency-injection that makes the Telegram channel unit-testable with no network.
 *
 * Like Telegram it does the two transport jobs and NOTHING else: `send` a DM with Approve/Deny buttons
 * carrying the single-use code (custom_id `a:<escId>:<code>`, well under Discord's 100-char budget), and
 * `startReceiving` normalizes button interactions and the `APPROVE <code>` DM text baseline into
 * transport-neutral `InboundResponse`s. The service runs each through the SAME §27 authority boundary.
 */

type FetchImpl = typeof fetch;

/** Gateway intents: DIRECT_MESSAGES (receive DMs) | MESSAGE_CONTENT (read their text — privileged). Button
 *  interactions arrive regardless of intents; MESSAGE_CONTENT is only needed for the text baseline. */
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_MESSAGE_CONTENT = 1 << 15;
const DEFAULT_INTENTS = INTENT_DIRECT_MESSAGES | INTENT_MESSAGE_CONTENT;

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const INTERACTION_MESSAGE_COMPONENT = 3;
const CALLBACK_MESSAGE_EPHEMERAL = { type: 4, data: { content: "Got it.", flags: 64 } };

const CHANNEL_NAME = "discord";

export interface DiscordChannelOptions {
  readonly config: DiscordConfig;
  /** DI for tests (mock REST). Defaults to global fetch. */
  readonly fetchImpl?: FetchImpl;
  /** DI for tests (mock gateway). Defaults to the global WebSocket. */
  readonly wsFactory?: WebSocketFactory;
  /** Backoff (ms) before reconnecting after a gateway close/error. Prevents a revoked token hot-looping. */
  readonly reconnectBackoffMs?: number;
  /** Gateway intents bitfield. Defaults to DIRECT_MESSAGES | MESSAGE_CONTENT. */
  readonly intents?: number;
  /** DI clock (unix ms). Defaults to Date.now. */
  readonly clock?: () => number;
}

interface DiscordUser {
  id: string;
  bot?: boolean;
  username?: string;
}
interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}
interface InteractionCreate {
  id: string;
  token: string;
  type: number;
  data?: { custom_id?: string; component_type?: number };
  user?: DiscordUser;
  member?: { user?: DiscordUser };
  channel_id?: string;
}
interface MessageCreate {
  id: string;
  channel_id: string;
  author?: DiscordUser;
  content?: string;
}

export class DiscordChannel implements Channel {
  readonly name = CHANNEL_NAME;
  private readonly cfg: DiscordConfig;
  private readonly fetchImpl: FetchImpl;
  private readonly wsFactory: WebSocketFactory;
  private readonly reconnectBackoffMs: number;
  private readonly intents: number;
  private readonly clock: () => number;

  constructor(opts: DiscordChannelOptions) {
    this.cfg = opts.config;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.wsFactory = opts.wsFactory ?? defaultWebSocketFactory;
    this.reconnectBackoffMs = opts.reconnectBackoffMs ?? 3000;
    this.intents = opts.intents ?? DEFAULT_INTENTS;
    this.clock = opts.clock ?? Date.now;
  }

  private api(path: string): string {
    return `${this.cfg.apiBase}${path}`;
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bot ${this.cfg.botToken}`, "content-type": "application/json" };
  }

  async send(message: EscalationMessage): Promise<ChannelSendResult> {
    try {
      const dm = await this.fetchImpl(this.api("/users/@me/channels"), {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ recipient_id: this.cfg.userId }),
      });
      const dmJson = (await dm.json()) as { id?: string; message?: string };
      if (!dm.ok || !dmJson.id) {
        return { ok: false, detail: dmJson.message ?? `open DM failed: HTTP ${dm.status}` };
      }

      const res = await this.fetchImpl(this.api(`/channels/${dmJson.id}/messages`), {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({
          content: renderApprovalText(message),
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: "Approve", custom_id: approvePayload(message) },
                { type: 2, style: 4, label: "Deny", custom_id: denyPayload(message) },
              ],
            },
          ],
        }),
      });
      const json = (await res.json()) as { id?: string; message?: string };
      if (!res.ok || !json.id) {
        return { ok: false, detail: json.message ?? `send failed: HTTP ${res.status}` };
      }
      return { ok: true, meta: { messageId: json.id, dmChannelId: dmJson.id } };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async startReceiving(
    onInbound: (r: InboundResponse) => Promise<void>,
  ): Promise<ChannelReceiver> {
    let running = true;
    let ws: WebSocketLike | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let lastSeq: number | null = null;
    let acked = true;

    const clearHeartbeat = (): void => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const connect = (): void => {
      if (!running) return;
      const socket = this.wsFactory(
        `${this.cfg.gatewayUrl}${this.cfg.gatewayUrl.includes("?") ? "&" : "?"}v=10&encoding=json`,
      );
      ws = socket;
      lastSeq = null;
      acked = true;

      const reconnect = (): void => {
        clearHeartbeat();
        if (ws === socket) ws = null;
        if (!running) return;
        setTimeout(connect, this.reconnectBackoffMs).unref();
      };

      socket.addEventListener("message", (ev) => {
        const raw = frameToString(ev.data);
        if (raw === null) return;
        let payload: GatewayPayload;
        try {
          payload = JSON.parse(raw) as GatewayPayload;
        } catch {
          return;
        }
        if (typeof payload.s === "number") lastSeq = payload.s;

        switch (payload.op) {
          case OP_HELLO: {
            const interval = (payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval;
            socket.send(JSON.stringify({
              op: OP_IDENTIFY,
              d: {
                token: this.cfg.botToken,
                intents: this.intents,
                properties: { os: "linux", browser: "untch-escalation", device: "untch-escalation" },
              },
            }));
            if (typeof interval === "number" && interval > 0) {
              acked = true;
              heartbeat = setInterval(() => {
                if (!acked) {
                  // No HEARTBEAT_ACK since the last beat — a zombied connection. Drop it and reconnect;
                  // the escalation is safe in Postgres and the timeout still fails it closed.
                  socket.close(4000, "heartbeat ack missing");
                  return;
                }
                acked = false;
                socket.send(JSON.stringify({ op: OP_HEARTBEAT, d: lastSeq }));
              }, interval);
              heartbeat.unref();
            }
            break;
          }
          case OP_HEARTBEAT:
            socket.send(JSON.stringify({ op: OP_HEARTBEAT, d: lastSeq }));
            break;
          case OP_HEARTBEAT_ACK:
            acked = true;
            break;
          case OP_RECONNECT:
          case OP_INVALID_SESSION:
            socket.close(4000, "reconnect requested");
            break;
          case OP_DISPATCH: {
            const inbound = this.parseDispatch(payload.t ?? "", payload.d);
            if (!inbound) return;
            void onInbound(inbound).catch(() => {
              /* a handler error must not kill the receiver — the §27 failure is recorded in the log */
            });
            const ic = payload.d as InteractionCreate | undefined;
            if (payload.t === "INTERACTION_CREATE" && ic?.id && ic.token) {
              void this.ackInteraction(ic.id, ic.token).catch(() => {});
            }
            break;
          }
          default:
            break;
        }
      });

      socket.addEventListener("close", reconnect);
      socket.addEventListener("error", () => socket.close(4000, "socket error"));
    };

    connect();

    return {
      stop: async () => {
        running = false;
        clearHeartbeat();
        ws?.close(1000, "receiver stopped");
        ws = null;
      },
    };
  }

  /** Pure normalization of a raw gateway DISPATCH (`t`, `d`) → an `InboundResponse` (or null). */
  parseDispatch(t: string, d: unknown): InboundResponse | null {
    if (t === "INTERACTION_CREATE") {
      const ic = d as InteractionCreate;
      if (ic.type !== INTERACTION_MESSAGE_COMPONENT) return null;
      const parsed = parseButtonPayload(ic.data?.custom_id);
      if (!parsed) return null;
      const userId = ic.user?.id ?? ic.member?.user?.id;
      if (!userId) return null;
      return {
        channel: CHANNEL_NAME,
        senderHandle: userId,
        action: parsed.action,
        code: parsed.code,
        ...(parsed.escalationRef ? { escalationRef: parsed.escalationRef } : {}),
        receivedAtMs: this.clock(),
        meta: { via: "component", interactionId: ic.id },
      };
    }
    if (t === "MESSAGE_CREATE") {
      const mc = d as MessageCreate;
      if (mc.author?.bot) return null;
      const parsed = parseTextCommand(mc.content ?? "");
      if (!parsed) return null;
      const userId = mc.author?.id;
      if (!userId) return null;
      return {
        channel: CHANNEL_NAME,
        senderHandle: userId,
        action: parsed.action,
        code: parsed.code,
        receivedAtMs: this.clock(),
        meta: { via: "text", messageId: mc.id },
      };
    }
    return null;
  }

  private async ackInteraction(id: string, token: string): Promise<void> {
    await this.fetchImpl(this.api(`/interactions/${id}/${token}/callback`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CALLBACK_MESSAGE_EPHEMERAL),
    });
  }
}
