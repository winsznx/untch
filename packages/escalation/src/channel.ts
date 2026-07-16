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
 * spend, only carry a response the engine already asked for. Telegram, Discord, Slack, Dashboard, and
 * Photon (Spectrum Cloud / iMessage) all implement this — each one file, none touching the state machine.
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

/** The governance events worth waking a human for. Names match the on-chain event names exactly. */
export type GovernanceEventKind =
  | "OpProposed"
  | "OpExecuted"
  | "OpCancelled"
  | "WriterAdded"
  | "WriterRemoved"
  | "AdminTransferred"
  | "OracleChanged"
  | "OwnershipTransferStarted"
  | "OwnershipTransferred"
  | "Paused"
  | "Unpaused";

/**
 * A governance event observed on-chain, ready to render. This is NOT an `EscalationMessage` and must not
 * be pushed through `send`: an escalation is a REQUEST the operator answers with a single-use code, and
 * the §27 authority-boundary check turns that answer into money moving. A governance alert is a
 * NOTIFICATION about something that already happened on-chain — there is no code, nothing to approve, and
 * the operator's lever is an on-chain `cancel()` from the admin key, not a button here. Rendering one as
 * the other would tell an operator "the agent wants to spend N USDT0" over an `OpProposed` and offer
 * Approve/Deny buttons that cannot cancel the timelock. Hence its own type and its own `notify` path.
 */
export interface GovernanceAlert {
  readonly kind: GovernanceEventKind;
  /** Which contract fired it, e.g. "UntchReceipts" — the operator should not have to decode an address. */
  readonly contract: string;
  readonly contractAddress: string;
  readonly chainId: number;
  readonly txHash: string;
  readonly blockNumber: string;
  /** Decoded event fields, already stringified for display (e.g. target, newAdmin, eta). */
  readonly fields: Readonly<Record<string, string>>;
  /**
   * `critical` = a live change to who can write or who is admin, or a proposal opening a cancel window.
   * `info` = the terminal record of something already alerted on. Channels may treat these differently;
   * the watcher never suppresses either.
   */
  readonly severity: "critical" | "info";
  /**
   * Present only for `OpProposed`: the window in which `cancel()` is still possible. This is the whole
   * point of the alert — without it the 72h delay is a lever nobody knows to pull.
   */
  readonly cancelWindow?: {
    readonly etaIso: string;
    readonly secondsRemaining: number;
  };
  readonly explorerUrl?: string;
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
   * Deliver a governance alert as a plain notification — no code, no buttons, nothing to answer.
   * OPTIONAL by design: a channel that cannot carry a pure notification simply does not implement it and
   * the watcher skips it loudly rather than faking an approval. See `GovernanceAlert` for why this is not
   * `send`.
   */
  notify?(alert: GovernanceAlert): Promise<ChannelSendResult>;
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
