import type {
  Channel,
  ChannelReceiver,
  ChannelSendResult,
  EscalationMessage,
  GovernanceAlert,
} from "./channel";
import type { InboundResponse } from "./types";
import { parseTextCommand, renderApprovalText, renderGovernanceText } from "./wire-format";

/**
 * The Photon `Channel` — the fifth real implementation of the same seam Telegram, Discord, Slack, and
 * Dashboard use, delivering to ONE bound operator over iMessage via Photon's Spectrum Cloud (the hosted
 * infra behind `spectrum-ts`). It does the two transport jobs and NOTHING else; the service runs every
 * inbound response it emits through the SAME §27 authority boundary before it counts.
 *
 * Channel name is `imessage` — the operator-facing SURFACE — matching the seam's own documented example
 * (`channel.ts`: "a policy naming `imessage` (Photon)"). The provider is Photon Spectrum Cloud; the env is
 * `PHOTON_*` (see config.ts). One person, a fifth surface — not a fifth approver.
 *
 * ── Transport choice — the gRPC MESSAGE STREAM over the webhook ──────────────────────────────────────
 * Spectrum Cloud offers two ways to receive an operator's reply: (a) `app.messages`, an async-iterable
 * backed by an OUTBOUND gRPC ("Fusor") stream the process opens to Photon — no public URL, works behind
 * NAT; or (b) `app.webhook(req, handler)`, which requires a PUBLIC HTTPS endpoint you host and Photon
 * POSTs to (HMAC-signed, at-least-once). (b) adds a new externally-reachable inbound surface to a backend
 * that has none — the exact trade-off Discord's interactions-webhook and Slack's Events API were rejected
 * for. (a) is outbound-only, matching Telegram's long-poll and the Discord/Slack sockets, so the stream is
 * the consistent fit. This is the ONE channel that cannot avoid a client SDK: unlike Discord/Slack (raw
 * WebSocket) and Telegram (raw fetch), Spectrum's transport is proprietary gRPC with no built-in
 * equivalent — so the SDK is isolated behind the narrow `SpectrumPort` below, injected into this channel,
 * and the real adapter lives in `photon-spectrum.ts`. This channel imports no SDK and is unit-tested with
 * a fake port and no network, exactly like the other four.
 *
 * ── No inline buttons — the text baseline ────────────────────────────────────────────────────────────
 * iMessage has no Telegram/Discord/Slack-style action buttons, so Photon uses the `APPROVE <code>` /
 * `DENY <code>` TEXT baseline that `wire-format.ts` already defines as the judge-safe path (needs nothing
 * beyond send/receive). The single-use code is printed in the message body (delivered only to the bound
 * operator's device, same as the other channels embed it in a button payload) and the operator types the
 * reply. `parseTextCommand` normalizes it; the code is still re-validated by the §27 check (pt 4).
 *
 * ── Delivery is ACCEPTANCE, not device-delivery (verified in the SDK source) ─────────────────────────
 * A resolved `send` means "Spectrum Cloud accepted the send RPC", NOT that the message reached the
 * operator's device. Apple's own delivered/read receipts exist one layer down in Photon's transport but
 * `spectrum-ts` discards them before they reach a caller — there is no delivery webhook/callback/poll in
 * the public API. So `ChannelSendResult.ok` here is `meta.delivery: "accepted"`, never "delivered". This
 * is SAFE for an escalation channel precisely because the §7.2 timeout is fail-closed (I2): a silently
 * undelivered escalation still defaults to DENY at its deadline — the money can never settle because a
 * notification quietly failed. This is the same guarantee tier as every other channel (none confirm a
 * human actually read the message); Photon simply cannot do better even though Apple's signal exists,
 * because the abstraction drops it. Documented, not hidden.
 */

const CHANNEL_NAME = "imessage";

/** One inbound iMessage, already normalized by the adapter (no `spectrum-ts` types leak into this file). */
export interface SpectrumInbound {
  /** The message text, extracted from Spectrum's `Content` (empty for a non-text message). */
  readonly text: string;
  /**
   * The sender's stable iMessage handle (E.164 phone or email) from `message.sender.address`. Matched
   * against the §27 binding. `undefined` when Apple attributed no actor (e.g. some system events) — such
   * a message cannot be bound to the operator and is dropped, exactly as the other channels drop an event
   * with no user id.
   */
  readonly senderHandle: string | undefined;
  /** Provider message guid — kept for the audit trail and at-least-once dedupe (Spectrum is at-least-once). */
  readonly id: string;
  /** iMessage service ("iMessage" | "SMS" | "RCS" | "unknown"), when present — audit context only. */
  readonly service?: string;
}

export interface SpectrumSendResult {
  /** The sent message's provider guid, when the transport returns one. */
  readonly id?: string;
}

/**
 * The narrow seam this channel needs from Spectrum Cloud — the ONLY surface the real SDK adapter must
 * implement (see `photon-spectrum.ts`) and the surface a test fake stands in for. Deliberately tiny: a
 * `send`, an inbound `stream`, and a `close`. Nothing about the money crosses it.
 */
export interface SpectrumPort {
  /**
   * Deliver `text` to `handle` (E.164 phone or email). Resolves when Spectrum Cloud ACCEPTS the send RPC
   * — NOT on device delivery (see the header). Rejects on transport error or the shared-pool allowlist
   * violation ("Target not allowed for this project"), which the channel surfaces as `ok:false`.
   */
  send(handle: string, text: string): Promise<SpectrumSendResult>;
  /**
   * The inbound message stream (mirrors `app.messages`). Re-obtained by the receiver after a clean end or
   * an error, so a dropped gRPC connection reconnects rather than silently going deaf.
   */
  stream(): AsyncIterable<SpectrumInbound>;
  /** Release the underlying Spectrum connection. */
  close(): Promise<void>;
}

export interface PhotonChannelOptions {
  /** The Spectrum Cloud port — the real adapter in production, a fake in tests. */
  readonly port: SpectrumPort;
  /**
   * The bound operator's iMessage handle (E.164 phone or email) — the send TARGET and the same handle the
   * §27 binding matches inbound senders against. On the shared-pool (Free/Pro) plan this handle MUST be a
   * pre-registered user of the Photon project or `send` throws the allowlist error.
   */
  readonly operatorHandle: string;
  /** Backoff (ms) before re-opening the stream after a clean end or an error. Prevents a hot reconnect loop. */
  readonly reconnectBackoffMs?: number;
  /** DI clock (unix ms). Defaults to Date.now. */
  readonly clock?: () => number;
}

export class PhotonChannel implements Channel {
  readonly name = CHANNEL_NAME;
  private readonly port: SpectrumPort;
  private readonly operatorHandle: string;
  private readonly reconnectBackoffMs: number;
  private readonly clock: () => number;

  constructor(opts: PhotonChannelOptions) {
    this.port = opts.port;
    this.operatorHandle = opts.operatorHandle;
    this.reconnectBackoffMs = opts.reconnectBackoffMs ?? 3000;
    this.clock = opts.clock ?? Date.now;
  }

  async send(message: EscalationMessage): Promise<ChannelSendResult> {
    try {
      const res = await this.port.send(this.operatorHandle, renderPhotonMessage(message));
      // ok == Spectrum accepted the send RPC, NOT device-delivered (see header). meta records that
      // honestly; the §7.2 fail-closed timeout is the backstop if it never actually arrives.
      return { ok: true, meta: { messageId: res.id, delivery: "accepted" } };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /** Same Spectrum port, same bound operator handle as `send` — minus the "Reply APPROVE/DENY"
   * grammar, because a governance alert has no code to reply with. See `GovernanceAlert`. */
  async notify(alert: GovernanceAlert): Promise<ChannelSendResult> {
    try {
      const res = await this.port.send(this.operatorHandle, renderGovernanceText(alert));
      // Same honesty as `send`: ok == Spectrum accepted the RPC, NOT device-delivered.
      return { ok: true, meta: { messageId: res.id, delivery: "accepted" } };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async startReceiving(
    onInbound: (r: InboundResponse) => Promise<void>,
  ): Promise<ChannelReceiver> {
    let running = true;

    const loop = async (): Promise<void> => {
      while (running) {
        try {
          for await (const raw of this.port.stream()) {
            if (!running) break;
            const inbound = this.toInbound(raw);
            if (!inbound) continue;
            try {
              await onInbound(inbound);
            } catch {
              /* a handler error must not kill the receiver — the §27 failure is recorded in the log */
            }
          }
        } catch {
          /* stream threw — fall through to the backoff and re-open; the escalation is safe in Postgres */
        }
        // The stream ended (cleanly or via error). If still running, back off then re-open so a dropped
        // gRPC connection reconnects instead of the receiver going permanently deaf.
        if (running) await sleep(this.reconnectBackoffMs);
      }
    };

    void loop();
    return {
      stop: async () => {
        running = false;
        await this.port.close();
      },
    };
  }

  /** Pure normalization of one inbound iMessage → an `InboundResponse` (or null if not an approval). */
  toInbound(raw: SpectrumInbound): InboundResponse | null {
    const parsed = parseTextCommand(raw.text);
    if (!parsed) return null;
    // No attributable sender ⇒ cannot bind to the operator ⇒ drop (never guessed). §27 pt3 would reject
    // it anyway, but dropping here keeps an unattributable event out of the audit trail as an approval.
    if (!raw.senderHandle) return null;
    return {
      channel: CHANNEL_NAME,
      senderHandle: raw.senderHandle,
      action: parsed.action,
      code: parsed.code,
      receivedAtMs: this.clock(),
      meta: { via: "text", messageId: raw.id, ...(raw.service ? { service: raw.service } : {}) },
    };
  }
}

/**
 * The message body for iMessage: the shared approval copy plus the explicit reply grammar carrying the
 * single-use code (iMessage has no buttons, so the operator types the reply). The code is printed here
 * because the text baseline needs it visible; it is delivered only to the bound operator's device.
 */
export function renderPhotonMessage(message: EscalationMessage): string {
  return `${renderApprovalText(message)}\nReply APPROVE ${message.code} or DENY ${message.code}.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
