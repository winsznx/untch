/**
 * @untch/escalation — public types.
 *
 * The vocabulary of the §7.2 escalation lifecycle and the §27 authority boundary. The core deliberately
 * knows nothing about any specific channel: a `Channel` is an interface (Telegram, Discord, Slack,
 * Dashboard, and Photon/iMessage all implement it) and an inbound operator response is a plain
 * `InboundResponse` — a transport-neutral
 * record the state machine runs through the same authority-boundary check regardless of where it came
 * from. Channels never make money decisions; they only transport a response for a decision the engine
 * already made.
 */

/** §8 escalations.status. */
export type EscalationStatus =
  | "PENDING"
  | "AWAITING_SECOND_CHANNEL"
  | "APPROVED"
  | "DENIED"
  | "EXPIRED"
  | "NOTIFY_FAILED";

/** A stored escalation row (§8 shape). Times are ISO-8601 strings at this boundary. */
export interface EscalationRecord {
  readonly id: string;
  readonly intentId: string;
  /** The id the x402-guard poll handle resolves by: `receiptRef.receiptId ?? intentHash`. */
  readonly pollRef: string;
  readonly status: EscalationStatus;
  readonly reason: string;
  readonly policyId: string;
  /** DISPLAY units (like §8.2), the value the operator is asked to approve. */
  readonly amount: number;
  readonly token: string;
  /** §27 approvals config snapshotted at creation — what the authority-boundary check is judged against. */
  readonly approvals: ApprovalsConfig;
  readonly approvalCodeHash: string;
  readonly codeExpiresAt: string;
  readonly channelLog: readonly ChannelLogEntry[];
  readonly approvedChannels: readonly string[];
  readonly resolvedBy: ResolvedBy | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResolvedBy {
  readonly channel: string;
  readonly handle: string;
}

/**
 * One appended event on an escalation's audit trail (§7.2 "notification receipt"). Covers BOTH the
 * outbound fan-out (`kind:"FANOUT"`) and every inbound decision (`kind:"INBOUND"`) — including the
 * IGNORED_* failures, which are logged, never dropped (§27: "receipted as a failed control event").
 */
export interface ChannelLogEntry {
  readonly at: string;
  readonly channel: string;
  readonly kind: "FANOUT" | "FANOUT_FAILED" | "INBOUND" | "SYSTEM";
  readonly handle?: string;
  /** For INBOUND: the outcome the authority-boundary check reached. */
  readonly outcome?: InboundOutcome;
  readonly latencyMs?: number;
  readonly detail?: string;
}

/**
 * The result of running one inbound response through the §27 authority-boundary check. The three
 * IGNORED_* codes are the adversarial cases the check MUST catch — each is logged and the escalation
 * stays PENDING; a plausible-looking but invalid approval is never honored.
 */
export type InboundOutcome =
  | "APPROVED" //                intent active, bound sender, valid code, caps ok, dual-channel satisfied
  | "DENIED" //                  a valid bound DENY
  | "AWAITING_SECOND_CHANNEL" // valid, but amount > dualChannelAbove and only one channel has confirmed
  | "IGNORED_UNBOUND" //         sender's binding tuple did not match (§27 pt 3)
  | "IGNORED_BAD_CODE" //        code invalid / expired / reused (§27 pt 4)
  | "IGNORED_CHANNEL_CAP" //     amount above this channel's cap (§27 pt 5)
  | "IGNORED_EXPIRED" //         the escalation already timed out (§27 pt 1 — intent no longer active)
  | "IGNORED_ALREADY_RESOLVED" //a terminal decision was already reached (idempotent ack)
  | "IGNORED_NOT_FOUND"; //      no escalation for this poll ref / code

/** A transport-neutral inbound operator response, normalized by a channel from its native event. */
export interface InboundResponse {
  /** Which channel produced this (e.g. "telegram"). */
  readonly channel: string;
  /** The sender's stable handle on that channel (Telegram: the chat id). Matched against the binding. */
  readonly senderHandle: string;
  /** The operator's intent. */
  readonly action: "APPROVE" | "DENY";
  /** The single-use code the operator's response carried (from the button payload / "APPROVE <code>"). */
  readonly code: string;
  /**
   * The escalation id the channel embedded in its reply path (e.g. Telegram button callback data), when
   * available. A direct lookup key. Absent for the bare-text baseline ("APPROVE <code>"), where the
   * service falls back to resolving by the code's hash. Either way the code is still validated (§27 pt 4).
   */
  readonly escalationRef?: string;
  /** Unix ms the channel observed the event; used to record inbound latency. */
  readonly receivedAtMs: number;
  /** Free-form provider metadata (message id, update id …) kept for the audit trail. */
  readonly meta?: Record<string, unknown>;
}

/** The result the service returns for one processed inbound response. */
export interface InboundResult {
  readonly outcome: InboundOutcome;
  /** The escalation's status after processing. Null only when no escalation matched (IGNORED_NOT_FOUND). */
  readonly status: EscalationStatus | null;
  readonly escalationId: string | null;
  readonly detail: string;
}

/**
 * The §27 approvals config, read from the stored policy's `rules` (which preserves these §8 fields
 * verbatim even though the engine narrows them away). All optional — a policy that omits `approvals`
 * gets safe fail-closed defaults: no channel is implicitly capped-out, and only the single live channel
 * is allowed. `dualChannelAbove: null` ⇒ never require a second channel.
 */
export interface ApprovalsConfig {
  /** Channels the policy authorizes for approvals. Empty/absent ⇒ the caller's live channels only. */
  readonly channels: readonly string[];
  /** §8 dualChannelAbove — amounts strictly above this require two distinct channels. null ⇒ never. */
  readonly dualChannelAbove: number | null;
  /** §8 channelCaps — per-channel max approval amount (DISPLAY units). Absent channel ⇒ uncapped. */
  readonly channelCaps: Readonly<Record<string, number>>;
  /** §8 escalationTimeoutMin — the escalation timeout (and the code TTL, per `codeTTL: escalationTimeout`). */
  readonly escalationTimeoutMin: number | null;
}

/**
 * What the engine hands the service when it escalates a decision — the minimum needed to create an
 * escalation and later re-present an APPROVED decision to the guard. Mirrors the §8.2 decision fields.
 */
export interface EscalationRequest {
  /** The id the guard's poll handle will use: `receiptRef.receiptId ?? intentHash`. */
  readonly pollRef: string;
  readonly intentId: string;
  /** The §7.1 escalation code (e.g. ESCALATED_THRESHOLD) — proves the engine, not a channel, escalated. */
  readonly reason: string;
  readonly policyId: string;
  readonly amount: number;
  readonly token: string;
  /** The §27 approvals config resolved from the stored policy. */
  readonly approvals: ApprovalsConfig;
}
