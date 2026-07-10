import type { InboundResponse } from "./types";

/**
 * The channel-agnostic seam — the whole reason this service can outlive its one real channel.
 *
 * A `Channel` does exactly two transport things and NOTHING else:
 *   • `send` an escalation notification carrying the single-use code, and
 *   • `startReceiving` inbound operator responses, normalized to the transport-neutral `InboundResponse`.
 *
 * It never decides anything about the money. Every inbound response a channel emits is run by the
 * service through the SAME §27 authority-boundary check before it counts — a channel cannot approve a
 * spend, only carry a response the engine already asked for. Telegram implements this now; Photon
 * (Spectrum) implements the same two methods later, without the core state machine changing at all.
 */

/** What the service hands a channel to render + deliver. The channel decides presentation, never policy. */
export interface EscalationMessage {
  readonly escalationId: string;
  readonly intentId: string;
  /** §7.1 escalation code (e.g. ESCALATED_THRESHOLD) — shown so the operator knows WHY it escalated. */
  readonly reason: string;
  readonly amount: number;
  readonly token: string;
  readonly policyId: string;
  /** The plaintext single-use code (only the hash is stored). The channel embeds it in the reply path. */
  readonly code: string;
  /** ISO-8601 — shown as the deadline; after it, any reply is rejected (§7.2). */
  readonly expiresAt: string;
}

export interface ChannelSendResult {
  readonly ok: boolean;
  readonly detail?: string;
  readonly meta?: Record<string, unknown>;
}

/** A running inbound listener. `stop()` releases it (closes the long-poll / stream). */
export interface ChannelReceiver {
  stop(): Promise<void>;
}

export interface Channel {
  /** Stable channel name, matched against `policy.approvals.channels` and channel caps (e.g. "telegram"). */
  readonly name: string;
  send(message: EscalationMessage): Promise<ChannelSendResult>;
  /**
   * Begin delivering inbound operator responses to `onInbound`. The channel is responsible ONLY for
   * turning its native events into `InboundResponse`s (parsing the button payload / "APPROVE <code>"
   * text into an action + code + sender handle); it applies no authority logic. `onInbound` rejections
   * must not crash the receiver.
   */
  startReceiving(onInbound: (r: InboundResponse) => Promise<void>): Promise<ChannelReceiver>;
}

/**
 * Holds the live channels by name. The service fans out to the intersection of the policy's allowed
 * channels and what is actually registered — so a policy naming `imessage` (Photon) simply doesn't fan
 * out there until a Photon channel is registered; it is never faked.
 */
export class ChannelRegistry {
  private readonly channels = new Map<string, Channel>();

  register(channel: Channel): void {
    this.channels.set(channel.name, channel);
  }

  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  names(): string[] {
    return [...this.channels.keys()];
  }

  all(): Channel[] {
    return [...this.channels.values()];
  }
}
