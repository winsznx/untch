import type { Channel, ChannelReceiver, ChannelSendResult, EscalationMessage } from "./channel";
import type { InboundResponse } from "./types";

/**
 * The Dashboard `Channel` — a fourth real implementation of the same seam Telegram, Discord, and Slack
 * use, authorized by SESSION IDENTITY: the operator is already SIWE-verified in their own authenticated
 * dashboard session, so their bound wallet address IS the sender handle. There is no fresh signature per
 * click and no per-click roundtrip; the §27 authority-boundary check in the service remains the sole
 * money-decision gate, exactly as it is for every other channel.
 *
 * Transport shape — a PULL surface, not a push transport. The other three channels PUSH an escalation out
 * to an external provider (a Telegram/Discord/Slack DM). The dashboard PUSHES nothing: an escalation is
 * already visible in the operator's authenticated inbox, which reads escalation records straight from the
 * repo. So `send` has nothing external to deliver. This is the OPPOSITE trade-off from Discord's gateway
 * note: there is no external endpoint and therefore no new inbound attack surface at all, at the cost of
 * the operator having to open their dashboard rather than being pinged on a device.
 *
 * Two usage paths, both fully within the seam:
 *   • As a registered `Channel` in the ASP `ChannelRegistry`: `startReceiving` stores the callback and
 *     `submit(input)` feeds a normalized `InboundResponse` into it, so the existing receiver loop that
 *     already drives Telegram/Discord/Slack drives the dashboard identically.
 *   • Directly from the web app: call `toInbound(input)` to get the transport-neutral response, then hand
 *     it to `service.handleInbound(...)` to capture the `InboundResult` for the HTTP response. Same check,
 *     same outcomes, just without the fire-and-forget callback.
 *
 * Like the others it does the transport jobs and NOTHING else: it normalizes an operator action into an
 * `InboundResponse` and never decides anything about the money.
 */

const CHANNEL_NAME = "dashboard";

export interface DashboardChannelOptions {
  /** DI clock (unix ms). Defaults to Date.now. Injected so tests can assert an exact `receivedAtMs`. */
  readonly clock?: () => number;
}

/**
 * One operator action taken in the authenticated dashboard. `senderHandle` is the operator's SIWE-verified
 * wallet address (the bound handle); `code` is the single-use §7.1 approval code shown alongside the
 * escalation; `escalationRef` is the escalation id the inbox row carries, when available (a direct lookup
 * key, like the button-payload id on the other channels).
 */
export interface DashboardApprovalInput {
  readonly senderHandle: string;
  readonly action: "APPROVE" | "DENY";
  /**
   * The single-use §7.1 code, when the dashboard has it (in-process creation). OMITTED on the identity
   * path: when the service registers `dashboard` as an identity-authorized channel, authority comes from
   * the SIWE session + policy ownership, and a seller-created escalation's plaintext code is not available
   * to the dashboard anyway (only its hash is stored). Resolution is then by `escalationRef`.
   */
  readonly code?: string;
  readonly escalationRef?: string;
}

export class DashboardChannel implements Channel {
  readonly name = CHANNEL_NAME;
  private readonly clock: () => number;
  private onInbound: ((r: InboundResponse) => Promise<void>) | null = null;

  constructor(opts: DashboardChannelOptions = {}) {
    this.clock = opts.clock ?? Date.now;
  }

  async send(_message: EscalationMessage): Promise<ChannelSendResult> {
    // Nothing to deliver: the dashboard is a PULL surface. The escalation is already readable in the
    // operator's authenticated inbox (which reads records from the repo), so there is no external endpoint
    // to POST to. Returning ok records a FANOUT entry in the audit log — proof the escalation was made
    // available in the inbox — with `rendered: true` standing in for the "delivered" of a push channel.
    // Unlike Discord's gateway, this opens no inbound endpoint, so it adds no new attack surface.
    return { ok: true, meta: { rendered: true } };
  }

  async startReceiving(
    onInbound: (r: InboundResponse) => Promise<void>,
  ): Promise<ChannelReceiver> {
    this.onInbound = onInbound;
    return {
      stop: async () => {
        this.onInbound = null;
      },
    };
  }

  /**
   * Feed one dashboard action into the active receiver. Used by the ASP receiver loop path. The web app
   * that wants the `InboundResult` back should instead call `toInbound` then `service.handleInbound`.
   * Throws if no receiver is active, so a lost binding is loud rather than a silently dropped approval.
   */
  async submit(input: DashboardApprovalInput): Promise<void> {
    if (!this.onInbound) {
      throw new Error("DashboardChannel.submit called before startReceiving: no active receiver");
    }
    await this.onInbound(this.toInbound(input));
  }

  /** Pure normalization of a dashboard action into a transport-neutral `InboundResponse`. */
  toInbound(input: DashboardApprovalInput): InboundResponse {
    return {
      channel: CHANNEL_NAME,
      senderHandle: input.senderHandle,
      action: input.action,
      code: input.code ?? "",
      ...(input.escalationRef ? { escalationRef: input.escalationRef } : {}),
      receivedAtMs: this.clock(),
      meta: { via: CHANNEL_NAME },
    };
  }
}
