/**
 * Purch — physical product search and purchase (Amazon / Shopify), plus the Vault for digital assets.
 *
 * MATURITY: `experimental`, and it will stay there until the Solana rail is finished.
 *
 * Purch is the most consumer-legible provider in the pack and the one the research reports lead with.
 * The live captures are unambiguous about why it cannot ship higher: EVERY Purch 402 —
 * `/x402/search`, `/x402/shop`, `/x402/vault/search`, `/x402/vault/download` — offers exactly ONE
 * payment option, on `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. There is no Base alternative
 * anywhere in its `accepts[]`, and its own OpenAPI says so in plain text: "All endpoints are payable
 * via the x402 protocol (USDC on Solana)."
 *
 * The Solana rail settled on 2026-07-29. x402 v2 payload construction works, the PAYMENT-SIGNATURE
 * header is accepted, 0.010000 USDC settled from an Untch treasury, and Purch returned five real
 * Shopify products. shop.search is verified on that evidence and executes.
 *
 * The other capabilities do not. shop.quote, shop.purchase and shop.track have no settlement or
 * delivery evidence, so their capability rows stay experimental and the registry refuses them even
 * though the provider is verified. The capability row is the execution boundary, not the provider row.
 *
 * The endpoints, request bodies, response schemas and pricing modes are read from the live OpenAPI and
 * exercised against fixtures in the tests, so promoting one of the remaining capabilities needs
 * evidence rather than code.
 *
 * Two facts worth carrying forward, both from the live spec:
 *   • `/x402/buy` uses `pricingMode: "quote"` — the 402's amount IS the product total including tax
 *     and shipping. That is exactly the dynamic-price shape the Consumer Pack's funding leg expects.
 *   • `/x402/buy` requires a shipping address and an email. Those are personal data and are passed
 *     through to the provider without ever being written to an Untch log or receipt.
 */

import {
  hashQuote,
  newDiscoveryId,
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
import { arr, decimalString, dig, obj, optHttpsUrl, optStr, str, validated } from "../schema";

export const PURCH_BASE_URL = "https://api.purch.xyz";
/** The verified Solana payTo and sponsoring feePayer, read from the live 402s. */
export const PURCH_SOLANA_PAYTO = "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2";

export interface ShippingAddress {
  readonly name: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly state: string | null;
  readonly postalCode: string;
  readonly country: string;
}

export function parseShippingAddress(raw: unknown): ShippingAddress {
  return validated("shipping address", () => {
    const o = obj(raw, "shippingAddress");
    return {
      name: str(o.name ?? o.fullName, "shippingAddress.name", 120),
      line1: str(o.line1 ?? o.addressLine1, "shippingAddress.line1", 200),
      line2: optStr(o.line2 ?? o.addressLine2, "shippingAddress.line2", 200),
      city: str(o.city, "shippingAddress.city", 100),
      state: optStr(o.state, "shippingAddress.state", 100),
      postalCode: str(o.postalCode ?? o.zip, "shippingAddress.postalCode", 40),
      country: str(o.country, "shippingAddress.country", 4).toUpperCase(),
    };
  });
}

export class PurchAdapter extends BaseAdapter {
  readonly providerId = "purch";

  constructor(baseUrl: string = PURCH_BASE_URL) {
    super(baseUrl);
  }

  capabilities(): readonly ProviderCapabilityDescriptor[] {
    return [
      { capability: "shop.search", description: "product search across Amazon and Shopify", movesValue: false },
      { capability: "shop.quote", description: "bindable purchase quote (dynamic total)", movesValue: false },
      { capability: "shop.purchase", description: "one-command checkout", movesValue: true },
      { capability: "shop.track", description: "shipment tracking across 2,500 carriers", movesValue: true },
    ];
  }

  protected override healthPath(): string {
    return "/openapi.json";
  }

  /** GET /x402/search — $0.01, Solana only. */
  async discover(input: DiscoveryInput, ctx: AdapterContext): Promise<DiscoveryResult> {
    const q = str(input.params.query ?? input.params.q, "params.query", 200);
    if (q.trim() === "") {
      throw new ProviderError(normalizedError("PROVIDER_BAD_REQUEST", "`query` is required"));
    }
    const search = new URLSearchParams({ q });
    if (typeof input.params.priceMax === "number") search.set("priceMax", String(input.params.priceMax));
    if (typeof input.params.priceMin === "number") search.set("priceMin", String(input.params.priceMin));
    if (typeof input.params.brand === "string") search.set("brand", input.params.brand.slice(0, 80));

    const result = await this.paid(
      {
        method: "GET",
        path: `/x402/search?${search.toString()}`,
        ...(ctx.discoveryPayment ? { payment: ctx.discoveryPayment } : {}),
      },
      ctx,
    );

    const body = validated("Purch /x402/search", () => obj(result.json, "search"));
    const products = validated("Purch products", () =>
      arr(body.products ?? [], "search.products").map((p, i) => {
        const o = obj(p, `search.products[${i}]`);
        return {
          asin: optStr(o.asin, `search.products[${i}].asin`, 40),
          title: str(o.title, `search.products[${i}].title`, 300),
          price: o.price === undefined || o.price === null ? null : decimalString(o.price, `search.products[${i}].price`),
          currency: optStr(o.currency, `search.products[${i}].currency`, 8),
          source: optStr(o.source, `search.products[${i}].source`, 40),
          url: optHttpsUrl(o.productUrl ?? o.url, `search.products[${i}].url`),
          imageUrl: optHttpsUrl(o.imageUrl, `search.products[${i}].imageUrl`),
        };
      }),
    );

    return {
      providerId: this.providerId,
      discoveryId: newDiscoveryId(),
      options: products.slice(0, input.limit).map((p) => ({
        providerRef: p.asin ?? p.url ?? p.title,
        // Product text is DATA. It is sanitized at the schema boundary and never concatenated into
        // an instruction anywhere — the control plane is LLM-free, so a "product" whose title is a
        // prompt-injection payload is just an oddly-named product.
        title: p.title,
        description: `${p.source ?? "marketplace"} listing`,
        // An indicative price only. Nothing binds until /x402/buy answers with its own 402 total.
        indicativePrice: null,
        imageUrl: p.imageUrl,
        attributes: {
          asin: p.asin,
          source: p.source,
          listedPrice: p.price,
          listedCurrency: p.currency,
          productUrl: p.url,
        },
      })),
      truncated: products.length > input.limit,
      retrievedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  /**
   * The quote comes from `/x402/buy`'s OWN 402 — `pricingMode: "quote"` means the challenge amount is
   * the product total including tax and shipping. Reading it costs nothing and binds to the
   * merchant's exact figure rather than to a listed price that excludes both.
   */
  async quote(input: QuoteInput, ctx: AdapterContext): Promise<ProviderQuote> {
    const shipping = parseShippingAddress(input.params.shippingAddress);
    const email = str(input.params.email, "params.email", 320);
    const body = buildBuyBody(input.providerRef, input.params, shipping, email);
    const priced = await this.probe402("POST", "/x402/buy", ctx, body);

    return {
      providerId: this.providerId,
      providerRef: input.providerRef,
      cost: priced.amount,
      settlementRecipient: priced.recipient,
      settlementChain: priced.option.network,
      settlementAsset: priced.asset,
      summary: `Purchase ${input.providerRef}`,
      terms: {
        action: input.action,
        providerRef: input.providerRef,
        includesTaxAndShipping: true,
        // Personal data is hashed, never stored. A dispute can prove WHICH address was authorised
        // without the ledger holding where someone lives.
        shippingHash: `0x${sha256Hex(JSON.stringify(shipping))}`,
        emailHash: `0x${sha256Hex(email.toLowerCase())}`,
        destinationCountry: shipping.country,
      },
      expiresAt: new Date((ctx.clock?.() ?? Date.now()) + 10 * 60_000).toISOString(),
    };
  }

  async execute(
    input: ExecuteInput,
    payment: PaymentCapability,
    ctx: AdapterContext,
  ): Promise<ProviderExecution> {
    const shipping = parseShippingAddress(input.params.shippingAddress);
    const email = str(input.params.email, "params.email", 320);
    const body = buildBuyBody(input.providerRef, input.params, shipping, email);

    const result = await this.paid(
      {
        method: "POST",
        path: "/x402/buy",
        body,
        payment,
        allowedRecipients: [input.quote.settlementRecipient],
        ceilingFor: () => input.quote.cost,
        headers: { "x-untch-request-id": input.idempotencyKey },
      },
      ctx,
    );

    if (result.response.status >= 400) {
      throw this.classifyStatus(result.response, `${this.providerId} /x402/buy`);
    }
    if (!result.settlement) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_MALFORMED_RESPONSE",
          "/x402/buy returned success without demanding payment",
        ),
      );
    }

    const parsed = validated("Purch /x402/buy", () => {
      const o = obj(result.json, "buy");
      return {
        orderId: str(o.orderId, "buy.orderId", 128),
        status: str(o.status ?? "processing", "buy.status", 64),
        title: optStr(dig(o.product, "title"), "buy.product.title", 300),
      };
    });

    return {
      providerReference: parsed.orderId,
      settlement: {
        txHash: result.settlement.txHash,
        chain: result.settlement.chain,
        amount: result.settlement.amount,
        recipient: result.settlement.recipient,
      },
      providerStatus: parsed.status,
      payload: { orderId: parsed.orderId, status: parsed.status, title: parsed.title },
      acknowledgedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  /**
   * GET /x402/track — $0.52, Solana only.
   *
   * Tracking is a PAID call, so it is not something a status poller may fire on a loop. The
   * orchestrator treats it as an explicit, budgeted action, which is also why `shop.track` is
   * declared as a value-moving capability above.
   */
  async getStatus(ref: ProviderReference, ctx: AdapterContext): Promise<ProviderStatus> {
    if (!ctx.discoveryPayment) {
      return {
        reference: ref.reference,
        state: "UNKNOWN",
        detail:
          "Purch shipment tracking costs $0.52 per call and needs an explicit spending authority; " +
          "no status was fetched",
        raw: {},
        checkedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
      };
    }
    const result = await this.paid(
      {
        method: "GET",
        path: `/x402/track?orderId=${encodeURIComponent(ref.reference)}`,
        payment: ctx.discoveryPayment,
      },
      ctx,
    );
    const body = validated("Purch /x402/track", () => obj(result.json, "track"));
    const raw = str(body.status ?? "unknown", "track.status", 64).toLowerCase();
    return {
      reference: ref.reference,
      state:
        raw.includes("deliver") ? "FULFILLED"
        : raw.includes("cancel") ? "CANCELLED"
        : raw.includes("transit") || raw.includes("ship") || raw.includes("process") ? "IN_PROGRESS"
        : "UNKNOWN",
      detail: raw,
      raw: body,
      checkedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  async verifyDelivery(exec: ProviderExecution, ctx: AdapterContext): Promise<DeliveryEvidence> {
    const attested = {
      status: exec.providerStatus,
      reference: exec.providerReference,
      attestedAt: exec.acknowledgedAt,
      fields: exec.payload,
    };
    // A physical shipment cannot be verified independently of the carrier, and the carrier is
    // reachable only through Purch's paid tracking endpoint. Untch therefore proves ORDER PLACEMENT,
    // not receipt, and says so rather than implying more.
    return {
      intentId: "",
      providerId: this.providerId,
      providerAttested: attested,
      untchVerified: {
        verified: false,
        method: "NONE",
        detail:
          "physical delivery is attested by the merchant and its carrier; Untch verifies that the " +
          "order was placed and paid, not that a parcel arrived",
        verifiedAt: null,
      },
      evidenceHash: hashQuote({ attested }),
    };
  }
}

function buildBuyBody(
  providerRef: string,
  params: Readonly<Record<string, unknown>>,
  shipping: ShippingAddress,
  email: string,
): Record<string, unknown> {
  // The live spec: Amazon takes `asin` OR `productUrl`; Shopify takes `productUrl` AND `variantId`.
  const variantId = optStr(params.variantId, "params.variantId", 64);
  const isUrl = providerRef.startsWith("https://");
  if (!isUrl && variantId !== null) {
    throw new ProviderError(
      normalizedError(
        "PROVIDER_BAD_REQUEST",
        "a Shopify purchase needs the product URL together with its variantId, not an ASIN",
      ),
    );
  }
  return {
    ...(isUrl ? { productUrl: providerRef } : { asin: providerRef }),
    ...(variantId === null ? {} : { variantId }),
    email,
    shippingAddress: {
      name: shipping.name,
      line1: shipping.line1,
      ...(shipping.line2 === null ? {} : { line2: shipping.line2 }),
      city: shipping.city,
      ...(shipping.state === null ? {} : { state: shipping.state }),
      postalCode: shipping.postalCode,
      country: shipping.country,
    },
  };
}
