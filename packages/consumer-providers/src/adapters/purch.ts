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
  DEFAULT_CAPABILITY_EXECUTION_SHAPE,
  hashQuote,
  newDiscoveryId,
  normalizedError,
  ProviderError,
  sha256Hex,
  stableStringify,
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

export interface SearchProduct {
  readonly asin: string | null;
  readonly title: string;
  readonly price: string | null;
  readonly currency: string | null;
  readonly source: string | null;
  readonly url: string | null;
  readonly imageUrl: string | null;
}

/**
 * Validate a search response into products, in one place.
 *
 * Shared by `discover` and by the paid-read execution so the two cannot disagree about what a product is.
 * Product text is DATA: it is sanitized at this boundary and never concatenated into an instruction
 * anywhere, so a listing whose title is a prompt-injection payload is just an oddly-named product.
 */
export function parseSearchProducts(json: unknown): readonly SearchProduct[] {
  const body = validated("Purch /x402/search", () => obj(json, "search"));
  return validated("Purch products", () =>
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
}

/** The endpoint CLASS a paid read is authorised against. Compared at execution; never a full path. */
export const PURCH_ENDPOINT_CLASS_SEARCH = "purch:/x402/search" as const;

export interface SearchRequest {
  readonly query: string;
  readonly priceMin: number | null;
  readonly priceMax: number | null;
  readonly brand: string | null;
}

/**
 * The search request, parsed and NORMALISED once.
 *
 * Shared by `discover`, the paid-read quote and the paid-read execution, so all three agree on what the
 * request is. Three separate readings of `params` would be three chances for the thing quoted to differ
 * from the thing paid for, and the request hash that binds them would be measuring different objects.
 *
 * It requires a query and NOTHING else. No shipping address, no email: a search has nothing to ship and
 * nobody to notify, and demanding either is exactly the defect this replaces.
 */
export function parseSearchRequest(params: Readonly<Record<string, unknown>>): SearchRequest {
  return validated("Purch search request", () => {
    const q = str(params.query ?? params.q, "params.query", 200).trim();
    if (q === "") {
      throw new ProviderError(normalizedError("PROVIDER_BAD_REQUEST", "`query` is required"));
    }
    return {
      query: q,
      priceMin: typeof params.priceMin === "number" ? params.priceMin : null,
      priceMax: typeof params.priceMax === "number" ? params.priceMax : null,
      brand: typeof params.brand === "string" ? params.brand.slice(0, 80) : null,
    };
  });
}

/** The one place the search path is built, so a quote and its payment address the same URL. */
export function searchPath(search: SearchRequest): string {
  const qs = new URLSearchParams({ q: search.query });
  if (search.priceMax !== null) qs.set("priceMax", String(search.priceMax));
  if (search.priceMin !== null) qs.set("priceMin", String(search.priceMin));
  if (search.brand !== null) qs.set("brand", search.brand);
  return `/x402/search?${qs.toString()}`;
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
    // The SAME parser and path builder the paid-read quote uses, so discovery and the quoted execution
    // cannot address different URLs for the same request.
    const result = await this.paid(
      {
        method: "GET",
        path: searchPath(parseSearchRequest(input.params)),
        ...(ctx.discoveryPayment ? { payment: ctx.discoveryPayment } : {}),
      },
      ctx,
    );

    const products = parseSearchProducts(result.json);

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
   * Dispatch on the capability's EXECUTION SHAPE, never on its name.
   *
   * The shape arrives from the registry via the orchestrator. Reading `input.action` here and branching
   * on the string would put the lifecycle's routing decision inside the adapter and duplicate it at
   * `execute`, which is how the two would eventually disagree about which endpoint priced a quote.
   *
   * An absent shape resolves to FULFILMENT, which is what every caller meant before the field existed.
   */
  async quote(input: QuoteInput, ctx: AdapterContext): Promise<ProviderQuote> {
    return (input.executionShape ?? DEFAULT_CAPABILITY_EXECUTION_SHAPE) === "PAID_READ"
      ? this.quotePaidRead(input, ctx)
      : this.quoteFulfilment(input, ctx);
  }

  /**
   * Price a PAID READ from the read endpoint's own 402.
   *
   * This is the path the first production proof attempt needed and did not have. A search has nothing to
   * ship and nobody to notify, so it requires none of the fields a purchase does — and demanding them was
   * the defect: `shop.search` reached the quote stage and died on `shippingAddress: expected an object,
   * got undefined`, because the only quote path probed `/x402/buy`.
   *
   * `/x402/search` is the SAME endpoint `discover` pays, so the price quoted here is the price the
   * execution will be charged. Probing it is free: the request goes unpaid and the 402 is the answer.
   *
   * `discover` is deliberately NOT reused as a lifecycle shortcut. It PAYS, and a quote that paid would
   * settle before policy had run, before a reservation existed and before the proof gate had been
   * claimed — inverting the whole order the lifecycle exists to enforce.
   */
  private async quotePaidRead(input: QuoteInput, ctx: AdapterContext): Promise<ProviderQuote> {
    const search = parseSearchRequest(input.params);
    const path = searchPath(search);
    const { payment, challenge } = await this.probe402Detailed("GET", path, ctx);

    const requestHash = `0x${sha256Hex(stableStringify(search as unknown as Record<string, unknown>))}`;
    const challengeHash = `0x${sha256Hex(stableStringify(challenge as unknown as Record<string, unknown>))}`;

    return {
      providerId: this.providerId,
      providerRef: input.providerRef,
      cost: payment.amount,
      settlementRecipient: payment.recipient,
      settlementChain: payment.option.network,
      settlementAsset: payment.asset,
      summary: `Paid search: ${search.query}`,
      /**
       * The binding a paid read is authorised under.
       *
       * Every field here is compared again at execution before the signer is reachable. `endpointClass`
       * rather than the full path, because the path carries the query and a stored quote should not be a
       * second copy of the request; the request itself is bound by `requestHash`.
       */
      terms: {
        action: input.action,
        executionShape: "PAID_READ",
        endpointClass: PURCH_ENDPOINT_CLASS_SEARCH,
        providerRef: input.providerRef,
        requestHash,
        searchParamsHash: requestHash,
        x402Version: challenge.x402Version,
        challengeHash,
        challengeResourceUrl: challenge.resource.url,
        scheme: payment.option.scheme,
        mint: payment.option.asset,
        payTo: payment.recipient,
        maxTimeoutSeconds: payment.option.maxTimeoutSeconds,
        quotedAtomicAmount: payment.amount.amount.toString(),
        // Stated so a reader never has to infer it from an absence.
        shippingRequired: false,
        contactRequired: false,
        quotedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
      },
      expiresAt: new Date((ctx.clock?.() ?? Date.now()) + 10 * 60_000).toISOString(),
    };
  }

  /**
   * The quote comes from `/x402/buy`'s OWN 402 — `pricingMode: "quote"` means the challenge amount is
   * the product total including tax and shipping. Reading it costs nothing and binds to the
   * merchant's exact figure rather than to a listed price that excludes both.
   */
  private async quoteFulfilment(input: QuoteInput, ctx: AdapterContext): Promise<ProviderQuote> {
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
    return (input.executionShape ?? DEFAULT_CAPABILITY_EXECUTION_SHAPE) === "PAID_READ"
      ? this.executePaidRead(input, payment, ctx)
      : this.executeFulfilment(input, payment, ctx);
  }

  /**
   * Pay for the read that was quoted, and refuse if the offer has changed.
   *
   * The order here is the point. A FRESH challenge is fetched and compared against the authorised quote
   * BEFORE `paid()` is called, so every mismatch is refused while the signer is still unreachable — the
   * payment capability is only handed over once the two agree. Comparing afterwards would mean discovering
   * a substituted recipient or a raised price with a signature already in flight.
   *
   * The comparison is on IDENTITY, not just on cost. A cheaper challenge for a different resource, a
   * different mint or a different payTo is not a better deal; it is a different purchase wearing this
   * one's authorisation.
   */
  private async executePaidRead(
    input: ExecuteInput,
    payment: PaymentCapability,
    ctx: AdapterContext,
  ): Promise<ProviderExecution> {
    const search = parseSearchRequest(input.params);
    const path = searchPath(search);
    const authorised = input.quote;
    const terms = (authorised.terms ?? {}) as Record<string, unknown>;

    const fresh = await this.probe402Detailed("GET", path, ctx);
    const requestHash = `0x${sha256Hex(stableStringify(search as unknown as Record<string, unknown>))}`;

    const drift: string[] = [];
    if (terms.endpointClass !== PURCH_ENDPOINT_CLASS_SEARCH) {
      drift.push(`the quote authorised endpoint class ${String(terms.endpointClass)}`);
    }
    if (terms.requestHash !== requestHash) drift.push("the request differs from the one quoted");
    if (fresh.payment.option.network !== authorised.settlementChain) drift.push("the settlement chain changed");
    if (fresh.payment.asset.symbol !== authorised.settlementAsset.symbol) drift.push("the settlement asset changed");
    if (fresh.payment.option.asset !== terms.mint) drift.push("the token mint changed");
    if (fresh.payment.recipient.toLowerCase() !== authorised.settlementRecipient.toLowerCase()) {
      drift.push("the payment recipient changed");
    }
    if (fresh.payment.amount.amount > authorised.cost.amount) {
      drift.push(
        `the provider now asks ${fresh.payment.amount.amount} atomic units against an authorised ` +
          `${authorised.cost.amount}`,
      );
    }
    if (drift.length > 0) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_BINDING_MISMATCH",
          `QUOTE_CHANGED: refusing before the signer is reached — ${drift.join("; ")}. A reservation is ` +
            "never widened to fit a new offer, and a different offer needs a new authorisation.",
        ),
      );
    }

    const result = await this.paid(
      {
        method: "GET",
        path,
        payment,
        allowedRecipients: [authorised.settlementRecipient],
        // The AUTHORISED figure, not the refreshed one. The refreshed amount has already been proven no
        // greater; pinning the ceiling to the authorisation means a race between the two cannot raise it.
        ceilingFor: () => authorised.cost,
        headers: { "x-untch-request-id": input.idempotencyKey },
      },
      ctx,
    );

    if (result.response.status >= 400) {
      throw this.classifyStatus(result.response, `${this.providerId} /x402/search`);
    }
    if (!result.settlement) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_MALFORMED_RESPONSE",
          "/x402/search returned success without demanding payment, so nothing was bought",
        ),
      );
    }

    const products = parseSearchProducts(result.json);
    const resultHash = `0x${sha256Hex(stableStringify({ query: search.query, products } as unknown as Record<string, unknown>))}`;

    return {
      providerReference: `search-${input.intentId}`,
      settlement: {
        txHash: result.settlement.txHash,
        chain: result.settlement.chain,
        amount: result.settlement.amount,
        recipient: result.settlement.recipient,
      },
      /**
       * A paid read is FULFILLED the moment the answer arrives. There is no shipment to await, so the
       * returned product set IS the delivered service — which is the same reasoning that earned this
       * capability its `verified` maturity.
       */
      providerStatus: "fulfilled",
      payload: { query: search.query, count: products.length, products, resultHash },
      acknowledgedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  private async executeFulfilment(
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
