/**
 * StableMerch — custom shirts and mugs from a supplied image, for the Gifts surface.
 *
 * MATURITY: `experimental`, because the flow has an identity leg this build cannot complete.
 *
 * The reports treat StableMerch as an ordinary x402 purchase. The live captures say otherwise. Its
 * `.well-known/x402` lists seven resources, but only ONE — `/api/drafts/{draftId}/commit` — carries
 * an `x-payment-info` block. Every earlier step (`GET /api/catalog`, `POST /api/drafts`,
 * `/prepare-order`) answers 402 with an EMPTY `accepts[]` and a `sign-in-with-x` extension: they are
 * SIWX-gated, not paid. Its OpenAPI confirms it — `securitySchemes.siwx: {type: apiKey, in: header,
 * name: SIGN-IN-WITH-X}`, and `POST /api/drafts` declares `security: [{siwx: []}]`.
 *
 * So the real flow is: SIWX-authenticate → create a draft (mockups) → show previews → prepare the
 * unpaid Printify order → commit (x402/MPP, dynamic $0.01–$50.00). Four of those five steps need a
 * wallet identity, and the draft is bound to the SIGNING wallet, which means the same identity must
 * carry through to commit.
 *
 * That is all implemented below. What keeps it `experimental` is that the SIWX leg has never been
 * exercised against the live service — `CONSUMER_SIWX_PRIVATE_KEY` is not configured anywhere in this
 * environment, so the EIP-4361 rendering this build produces has never been accepted by StableMerch's
 * verifier. A rendering that a server rejects fails at draft creation, before any money moves, which
 * is the safe direction — but "we believe our message format is right" is not the same as "we have
 * seen it accepted", and only the second earns a promotion.
 */

import {
  hashQuote,
  newDiscoveryId,
  normalizedError,
  ProviderError,
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
import { arr, obj, optHttpsUrl, optStr, str, validated } from "../schema";

export const STABLEMERCH_BASE_URL = "https://stablemerch.dev";

/** The products the live catalogue enumerates. */
export const MERCH_PRODUCTS: readonly string[] = Object.freeze(["shirt", "heavyweight-shirt", "mug"]);

export class StableMerchAdapter extends BaseAdapter {
  readonly providerId = "stablemerch";

  constructor(baseUrl: string = STABLEMERCH_BASE_URL) {
    super(baseUrl);
  }

  capabilities(): readonly ProviderCapabilityDescriptor[] {
    return [
      { capability: "gifts.quote", description: "preview draft + prepared order total", movesValue: false },
      { capability: "gifts.order", description: "commit and pay for a prepared order", movesValue: true },
      { capability: "gifts.track", description: "draft / order status", movesValue: false },
    ];
  }

  protected override healthPath(): string {
    return "/.well-known/x402";
  }

  /** GET /api/catalog — SIWX-gated, free once authenticated. */
  async discover(input: DiscoveryInput, ctx: AdapterContext): Promise<DiscoveryResult> {
    const result = await this.paid({ method: "GET", path: "/api/catalog" }, ctx);
    const body = validated("StableMerch /api/catalog", () => obj(result.json, "catalog"));
    const products = validated("StableMerch products", () =>
      arr(body.products ?? body.items ?? [], "catalog.products").map((p, i) => {
        const o = obj(p, `catalog.products[${i}]`);
        return {
          slug: str(o.product_slug ?? o.slug, `catalog.products[${i}].slug`, 64),
          title: optStr(o.title ?? o.name, `catalog.products[${i}].title`, 200),
        };
      }),
    );

    return {
      providerId: this.providerId,
      discoveryId: newDiscoveryId(),
      options: products.slice(0, input.limit).map((p) => ({
        providerRef: p.slug,
        title: p.title ?? p.slug,
        description: "custom print-on-demand product",
        indicativePrice: null,
        imageUrl: null,
        attributes: { productSlug: p.slug },
      })),
      truncated: products.length > input.limit,
      retrievedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  /**
   * Draft → prepare-order → read the commit price.
   *
   * `client_request_id` is the provider's OWN idempotency key, and it is derived from the intent, so
   * a re-quote resumes the same draft instead of creating a second Printify product. The live
   * guidance is explicit that `POST /api/drafts` "creates or resumes" on that key.
   */
  async quote(input: QuoteInput, ctx: AdapterContext): Promise<ProviderQuote> {
    const productSlug = str(input.providerRef || input.params.product_slug, "params.product_slug", 64);
    if (!MERCH_PRODUCTS.includes(productSlug)) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_REJECTED",
          `product '${productSlug}' is not one of ${MERCH_PRODUCTS.join(", ")}`,
        ),
      );
    }
    const imageUrl = str(input.params.image_url ?? input.params.imageUrl, "params.image_url", 4096);
    // The provider accepts an https URL or a data: URL. Only https is allowed through here — a
    // data: URL would mean an arbitrary blob passing through Untch's request path.
    if (!imageUrl.startsWith("https://")) {
      throw new ProviderError(
        normalizedError("PROVIDER_BAD_REQUEST", "`image_url` must be an https URL"),
      );
    }

    const clientRequestId = str(input.params.clientRequestId ?? input.intentId, "clientRequestId", 128);

    const draft = await this.paid(
      {
        method: "POST",
        path: "/api/drafts",
        body: {
          client_request_id: clientRequestId,
          product_slug: productSlug,
          image_url: imageUrl,
          ...(typeof input.params.size === "string" ? { size: input.params.size } : {}),
          ...(typeof input.params.color === "string" ? { color: input.params.color } : {}),
          ...(typeof input.params.placement === "string" ? { placement: input.params.placement } : {}),
        },
      },
      ctx,
    );
    if (draft.response.status >= 400) {
      throw this.classifyStatus(draft.response, `${this.providerId} /api/drafts`);
    }

    const parsedDraft = validated("StableMerch /api/drafts", () => {
      const o = obj(draft.json, "draft");
      return {
        draftId: str(o.draft_id ?? o.draftId ?? o.id, "draft.draft_id", 128),
        status: str(o.status ?? "preview_ready", "draft.status", 64),
        previewUrls: arr(o.preview_urls ?? [], "draft.preview_urls")
          .map((u, i) => optHttpsUrl(u, `draft.preview_urls[${i}]`))
          .filter((u): u is string => u !== null)
          .slice(0, 6),
      };
    });

    // The Printify order is prepared BEFORE payment — that is the provider's own required ordering,
    // and it is also what makes the commit price exact rather than estimated.
    const prepared = await this.paid(
      { method: "POST", path: `/api/drafts/${encodeURIComponent(parsedDraft.draftId)}/prepare-order`, body: shippingBody(input.params) },
      ctx,
    );
    if (prepared.response.status >= 400) {
      throw this.classifyStatus(prepared.response, `${this.providerId} /prepare-order`);
    }

    const priced = await this.probe402(
      "POST",
      `/api/drafts/${encodeURIComponent(parsedDraft.draftId)}/commit`,
      ctx,
      {},
    );

    return {
      providerId: this.providerId,
      providerRef: parsedDraft.draftId,
      cost: priced.amount,
      settlementRecipient: priced.recipient,
      settlementChain: priced.option.network,
      settlementAsset: priced.asset,
      summary: `${productSlug} — prepared order ${parsedDraft.draftId}`,
      terms: {
        action: input.action,
        draftId: parsedDraft.draftId,
        productSlug,
        draftStatus: parsedDraft.status,
        previewUrls: parsedDraft.previewUrls,
        clientRequestId,
      },
      expiresAt: new Date((ctx.clock?.() ?? Date.now()) + 10 * 60_000).toISOString(),
    };
  }

  async execute(
    input: ExecuteInput,
    payment: PaymentCapability,
    ctx: AdapterContext,
  ): Promise<ProviderExecution> {
    const draftId = str(input.quote.terms.draftId ?? input.providerRef, "quote.terms.draftId", 128);

    const result = await this.paid(
      {
        method: "POST",
        path: `/api/drafts/${encodeURIComponent(draftId)}/commit`,
        body: {},
        payment,
        allowedRecipients: [input.quote.settlementRecipient],
        ceilingFor: () => input.quote.cost,
        headers: { "x-untch-request-id": input.idempotencyKey },
      },
      ctx,
    );

    if (result.response.status >= 400) {
      throw this.classifyStatus(result.response, `${this.providerId} /commit`);
    }
    if (!result.settlement) {
      throw new ProviderError(
        normalizedError("PROVIDER_MALFORMED_RESPONSE", "/commit returned success without demanding payment"),
      );
    }

    const parsed = validated("StableMerch /commit", () => {
      const o = obj(result.json, "commit");
      return {
        orderId: optStr(o.order_id ?? o.orderId, "commit.order_id", 128),
        status: str(o.status ?? "committed", "commit.status", 64),
      };
    });

    return {
      providerReference: parsed.orderId ?? draftId,
      settlement: {
        txHash: result.settlement.txHash,
        chain: result.settlement.chain,
        amount: result.settlement.amount,
        recipient: result.settlement.recipient,
      },
      providerStatus: parsed.status,
      payload: { draftId, orderId: parsed.orderId, status: parsed.status },
      acknowledgedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  async getStatus(ref: ProviderReference, ctx: AdapterContext): Promise<ProviderStatus> {
    const result = await this.paid(
      { method: "GET", path: `/api/drafts/${encodeURIComponent(ref.reference)}` },
      ctx,
    );
    if (result.response.status >= 400) {
      throw this.classifyStatus(result.response, `${this.providerId} /api/drafts/{id}`);
    }
    const body = validated("StableMerch draft status", () => obj(result.json, "draft"));
    const raw = str(body.status ?? "unknown", "draft.status", 64).toLowerCase();
    return {
      reference: ref.reference,
      state:
        raw.includes("fulfil") || raw.includes("shipped") || raw === "complete" ? "FULFILLED"
        : raw.includes("cancel") ? "CANCELLED"
        : raw.includes("fail") ? "FAILED"
        : raw === "preview_ready" || raw.includes("prepar") || raw.includes("commit") ? "IN_PROGRESS"
        : "UNKNOWN",
      detail: raw,
      raw: body,
      checkedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  /**
   * The draft's own status endpoint IS an independent-ish check: it reads the provider's order
   * record rather than replaying what the commit response said. Weaker than a DNS attestation,
   * stronger than nothing, and labelled as what it is.
   */
  async verifyDelivery(exec: ProviderExecution, ctx: AdapterContext): Promise<DeliveryEvidence> {
    const attested = {
      status: exec.providerStatus,
      reference: exec.providerReference,
      attestedAt: exec.acknowledgedAt,
      fields: exec.payload,
    };
    let verified = false;
    let detail = "";
    try {
      const status = await this.getStatus(
        { providerId: this.providerId, reference: str(exec.payload.draftId, "draftId", 128) },
        ctx,
      );
      verified = status.state === "FULFILLED";
      detail = `provider order record reports '${status.detail}'`;
    } catch (err) {
      detail = `status re-read failed: ${this.normalizeError(err).message}`;
    }
    return {
      intentId: "",
      providerId: this.providerId,
      providerAttested: attested,
      untchVerified: {
        verified,
        method: "PROVIDER_STATUS_POLL",
        detail,
        verifiedAt: verified ? new Date(ctx.clock?.() ?? Date.now()).toISOString() : null,
      },
      evidenceHash: hashQuote({ attested, verified, detail }),
    };
  }
}

function shippingBody(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const s = params.shipping ?? params.shippingAddress;
  if (s === undefined || s === null) {
    throw new ProviderError(
      normalizedError("PROVIDER_BAD_REQUEST", "`shipping` is required to prepare a merch order"),
    );
  }
  return validated("merch shipping", () => {
    const o = obj(s, "shipping");
    return {
      first_name: str(o.firstName ?? o.first_name, "shipping.firstName", 100),
      last_name: str(o.lastName ?? o.last_name, "shipping.lastName", 100),
      email: str(o.email, "shipping.email", 320),
      address1: str(o.line1 ?? o.address1, "shipping.address1", 200),
      ...(o.line2 || o.address2 ? { address2: str(o.line2 ?? o.address2, "shipping.address2", 200) } : {}),
      city: str(o.city, "shipping.city", 100),
      ...(o.region || o.state ? { region: str(o.region ?? o.state, "shipping.region", 100) } : {}),
      zip: str(o.postalCode ?? o.zip, "shipping.zip", 40),
      country: str(o.country, "shipping.country", 4).toUpperCase(),
      ...(o.phone ? { phone: str(o.phone, "shipping.phone", 40) } : {}),
    };
  });
}
