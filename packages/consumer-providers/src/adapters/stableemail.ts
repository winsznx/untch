/**
 * StableEmail — governed transactional notification.
 *
 * The simplest real integration in the pack, and the one that closes the loop: a governed purchase
 * that cannot send its own receipt is only half a workflow.
 *
 * Verified live on 2026-07-27: `POST /api/send` answers 402 with Base USDC
 * (`0x8335…2913`, payTo `0xdb5a…0671`) and Solana USDC, at a fixed $0.02
 * (`x-payment-info: {"price":{"mode":"fixed","currency":"USD","amount":"0.02"}}`).
 *
 * The one thing this adapter is careful about is what it LOGS and STORES. An email body is personal
 * data and may contain a delivery address, an order reference, or a name. `execute` records the
 * message ID, the recipient COUNT and a subject hash — never the body, never the recipient list.
 * The provider needs those; Untch's audit trail does not.
 */

import {
  hashQuote,
  normalizedError,
  ProviderError,
  sha256Hex,
  type DeliveryEvidence,
  type DiscoveryInput,
  type DiscoveryResult,
  type ExecuteInput,
  type PaymentCapability,
  type ProviderExecution,
  type ProviderQuote,
  type ProviderReference,
  type ProviderStatus,
  type QuoteInput,
} from "@untch/consumer-core";
import { BaseAdapter, type AdapterContext, type ProviderCapabilityDescriptor } from "../adapter";
import { arr, obj, optStr, str, validated } from "../schema";

export const STABLEEMAIL_BASE_URL = "https://stableemail.dev";
/** The verified Base payTo, read from the live 402. */
export const STABLEEMAIL_BASE_PAYTO = "0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671";

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export interface NotifyMessage {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly replyTo: string | null;
}

/** Validate a message before any money moves. The provider's own limits, enforced on our side too. */
export function parseNotifyMessage(params: Readonly<Record<string, unknown>>): NotifyMessage {
  const to = validated("notify message", () =>
    arr(params.to ?? [], "params.to").map((v, i) => str(v, `params.to[${i}]`, 320).toLowerCase()),
  );
  if (to.length === 0 || to.length > 50) {
    throw new ProviderError(
      normalizedError("PROVIDER_BAD_REQUEST", "`to` must contain between 1 and 50 addresses"),
    );
  }
  for (const addr of to) {
    if (!EMAIL_RE.test(addr)) {
      throw new ProviderError(
        normalizedError("PROVIDER_BAD_REQUEST", "`to` contains an address that is not a valid email"),
      );
    }
  }
  const subject = str(params.subject ?? "", "params.subject", 998);
  if (subject.trim() === "") {
    throw new ProviderError(normalizedError("PROVIDER_BAD_REQUEST", "`subject` is required"));
  }
  const text = optStr(params.text, "params.text", 256_000);
  const html = optStr(params.html, "params.html", 256_000);
  if (text === null && html === null) {
    throw new ProviderError(
      normalizedError("PROVIDER_BAD_REQUEST", "one of `text` or `html` is required"),
    );
  }
  const replyTo = optStr(params.replyTo, "params.replyTo", 320);
  if (replyTo !== null && !EMAIL_RE.test(replyTo)) {
    throw new ProviderError(normalizedError("PROVIDER_BAD_REQUEST", "`replyTo` is not a valid email"));
  }
  return { to, subject, text, html, replyTo };
}

export class StableEmailAdapter extends BaseAdapter {
  readonly providerId = "stableemail";

  constructor(baseUrl: string = STABLEEMAIL_BASE_URL) {
    super(baseUrl);
  }

  capabilities(): readonly ProviderCapabilityDescriptor[] {
    return [
      { capability: "notify.confirmation", description: "send a transactional confirmation", movesValue: true },
      { capability: "notify.receipt", description: "send a receipt", movesValue: true },
      { capability: "notify.exception", description: "send an exception / approval notice", movesValue: true },
    ];
  }

  protected override healthPath(): string {
    return "/.well-known/x402";
  }

  /** There is nothing to discover: sending is a single fixed-price action. */
  async discover(_input: DiscoveryInput, _ctx: AdapterContext): Promise<DiscoveryResult> {
    throw new ProviderError(
      normalizedError(
        "CAPABILITY_UNAVAILABLE",
        "StableEmail has no discovery surface — sending is a single fixed-price action",
      ),
    );
  }

  async quote(input: QuoteInput, ctx: AdapterContext): Promise<ProviderQuote> {
    const message = parseNotifyMessage(input.params);
    const priced = await this.probe402("POST", "/api/send", ctx, {
      to: message.to,
      subject: message.subject,
      ...(message.text === null ? {} : { text: message.text }),
      ...(message.html === null ? {} : { html: message.html }),
    });

    return {
      providerId: this.providerId,
      providerRef: `send:${sha256Hex(message.subject).slice(0, 16)}`,
      cost: priced.amount,
      settlementRecipient: priced.recipient,
      settlementChain: priced.option.network,
      settlementAsset: priced.asset,
      summary: `Send 1 email to ${message.to.length} recipient${message.to.length === 1 ? "" : "s"}`,
      terms: {
        action: input.action,
        recipientCount: message.to.length,
        // Subject and body are personal data: the quote records a HASH so a receipt can prove which
        // message was authorised without the audit trail holding its contents.
        subjectHash: `0x${sha256Hex(message.subject)}`,
        hasHtml: message.html !== null,
        hasText: message.text !== null,
      },
      expiresAt: new Date((ctx.clock?.() ?? Date.now()) + 10 * 60_000).toISOString(),
    };
  }

  async execute(
    input: ExecuteInput,
    payment: PaymentCapability,
    ctx: AdapterContext,
  ): Promise<ProviderExecution> {
    const message = parseNotifyMessage(input.params);

    const result = await this.paid(
      {
        method: "POST",
        path: "/api/send",
        body: {
          to: message.to,
          subject: message.subject,
          ...(message.text === null ? {} : { text: message.text }),
          ...(message.html === null ? {} : { html: message.html }),
          ...(message.replyTo === null ? {} : { replyTo: message.replyTo }),
        },
        payment,
        allowedRecipients: [input.quote.settlementRecipient],
        ceilingFor: () => input.quote.cost,
        headers: { "x-untch-request-id": input.idempotencyKey },
      },
      ctx,
    );

    if (result.response.status >= 400) {
      throw this.classifyStatus(result.response, `${this.providerId} /api/send`);
    }
    if (!result.settlement) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_MALFORMED_RESPONSE",
          "/api/send returned success without demanding payment — refusing to record a settlement " +
            "that did not happen",
        ),
      );
    }

    const parsed = validated("StableEmail /api/send", () => {
      const o = obj(result.json, "send");
      return {
        id: optStr(o.id ?? o.messageId, "send.id", 128),
        status: optStr(o.status, "send.status", 64),
      };
    });

    return {
      providerReference: parsed.id ?? `sent-${input.idempotencyKey.slice(-16)}`,
      settlement: {
        txHash: result.settlement.txHash,
        chain: result.settlement.chain,
        amount: result.settlement.amount,
        recipient: result.settlement.recipient,
      },
      providerStatus: parsed.status ?? "sent",
      // Deliberately NOT the body, NOT the recipients. What a receipt needs is proof of which
      // authorised message was sent, and the hash already carries that.
      payload: {
        messageId: parsed.id,
        recipientCount: message.to.length,
        subjectHash: `0x${sha256Hex(message.subject)}`,
      },
      acknowledgedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  /**
   * Send is fire-and-forget on the shared relay: there is no per-message status endpoint on
   * `/api/send`. Reporting UNKNOWN is the truthful answer; a synthesized "delivered" would be a
   * fabrication.
   */
  async getStatus(ref: ProviderReference, ctx: AdapterContext): Promise<ProviderStatus> {
    return {
      reference: ref.reference,
      state: "UNKNOWN",
      detail:
        "StableEmail's shared-relay /api/send exposes no per-message status endpoint; acceptance by " +
        "the relay is all that can be known from this API",
      raw: {},
      checkedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  /**
   * The provider's acceptance is the only evidence that exists. `untchVerified` is therefore false
   * with method NONE — an accurate statement of what Untch can independently prove, which for a
   * relay hand-off is nothing.
   */
  async verifyDelivery(exec: ProviderExecution, ctx: AdapterContext): Promise<DeliveryEvidence> {
    const attested = {
      status: exec.providerStatus,
      reference: exec.providerReference,
      attestedAt: exec.acknowledgedAt,
      fields: exec.payload,
    };
    return {
      intentId: "",
      providerId: this.providerId,
      providerAttested: attested,
      untchVerified: {
        verified: false,
        method: "NONE",
        detail:
          "email delivery cannot be independently verified from the sender side; the provider's " +
          "acceptance of the message is the only available evidence",
        verifiedAt: null,
      },
      evidenceHash: hashQuote({ attested }),
    };
  }
}
