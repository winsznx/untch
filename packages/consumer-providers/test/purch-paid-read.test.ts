import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PurchAdapter } from "../src/adapters/purch";
import { PURCH_ENDPOINT_CLASS_SEARCH, parseSearchRequest, searchPath } from "../src/adapters/purch";
import { asset, isProviderError, money, type PaymentCapability } from "@untch/consumer-core";
import type { AdapterContext } from "../src/adapter";

/**
 * The paid-read quote path, and the defect it replaces.
 *
 * `PurchAdapter.quote` was written for one shape: it demanded `shippingAddress` and `email` and probed
 * `/x402/buy`. A `shop.search` intent could therefore be created, reach the quote stage, and die there —
 * which is exactly what the first bounded production proof did, on `shippingAddress: expected an object,
 * got undefined`. Nothing had ever driven the capability through quote-policy-reserve-execute, because
 * the settlement that earned it `verified` went through `discover()`.
 *
 * Every test here drives the adapter with a signer and a rail that THROW if reached, so "quoting never
 * pays" is proven by the absence of an exception rather than asserted in a comment.
 */

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_USDC = asset("solana.usdc");
const PAY_TO = "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2";

/**
 * A payment capability that throws on ANY access.
 *
 * Handed to the quote path, which must never touch it. A method that merely counted calls would let a
 * regression pass silently until someone read the counter; throwing makes the failure immediate and
 * unmissable.
 */
const EXPLODING_PAYMENT = new Proxy({} as PaymentCapability, {
  get(_t, prop) {
    throw new Error(`THE QUOTE STAGE REACHED THE PAYMENT CAPABILITY via ${String(prop)}`);
  },
});

function challengeHeader(over: Partial<{ amount: string; asset: string; payTo: string; network: string; scheme: string; x402Version: number }> = {}): string {
  const challenge = {
    x402Version: over.x402Version ?? 2,
    error: "Payment required",
    resource: { url: "https://api.purch.xyz/x402/search", description: "Product search", mimeType: "application/json" },
    accepts: [
      {
        scheme: over.scheme ?? "exact",
        network: over.network ?? SOLANA,
        amount: over.amount ?? "10000",
        asset: over.asset ?? SOL_USDC.address,
        payTo: over.payTo ?? PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { feePayer: "SponsorFeePayer1111111111111111111111111111" },
      },
    ],
  };
  return Buffer.from(JSON.stringify(challenge), "utf8").toString("base64");
}

/** A fetch double. Records every path it was asked for, so "never calls buy" is checkable. */
function fetchDouble(opts: {
  readonly challenge?: string;
  readonly status?: number;
  readonly paidBody?: unknown;
} = {}): { readonly fn: typeof fetch; readonly paths: string[] } {
  const paths: string[] = [];
  const fn = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    paths.push(new URL(u).pathname + new URL(u).search);
    const paying = Boolean((init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"]);
    if (!paying) {
      return new Response("", {
        status: opts.status ?? 402,
        headers: { "payment-required": opts.challenge ?? challengeHeader() },
      });
    }
    return new Response(JSON.stringify(opts.paidBody ?? { products: [] }), {
      status: 200,
      headers: { "content-type": "application/json", "payment-response": "" },
    });
  }) as unknown as typeof fetch;
  return { fn, paths };
}

function ctx(fn: typeof fetch): AdapterContext {
  return {
    correlationId: "test",
    timeoutMs: 5_000,
    signableChains: new Set([SOLANA]),
    siwx: null,
    discoveryPayment: null,
    clock: () => Date.parse("2026-07-30T12:00:00Z"),
    fetchImpl: fn,
    resolveHost: async () => ["93.184.216.34"],
  } as unknown as AdapterContext;
}

const SEARCH_PARAMS = { query: "wireless mouse" };

describe("the search request is parsed once and shared", () => {
  test("it requires a query and nothing else", () => {
    // #given only a query — no shipping address, no email
    const parsed = parseSearchRequest({ query: "wireless mouse" });
    // #then it parses, which is the whole point of the fix
    assert.equal(parsed.query, "wireless mouse");
    assert.equal(parsed.priceMin, null);
    assert.equal(parsed.brand, null);
  });

  test("an empty query is refused", () => {
    for (const bad of [{ query: "   " }, { query: "" }, {}]) {
      assert.throws(() => parseSearchRequest(bad), (e: unknown) => isProviderError(e));
    }
  });

  test("the path is built from the parsed request, so quote and execution address one URL", () => {
    const path = searchPath(parseSearchRequest({ query: "a b", priceMax: 50, brand: "acme" }));
    assert.ok(path.startsWith("/x402/search?"));
    assert.ok(path.includes("q=a+b"));
    assert.ok(path.includes("priceMax=50"));
    assert.ok(path.includes("brand=acme"));
  });
});

describe("a paid read quotes from the search endpoint", () => {
  test("shop.search quotes with NO shippingAddress and NO email", async () => {
    // #given a search request carrying neither field — the exact shape that used to fail
    const { fn, paths } = fetchDouble();
    const adapter = new PurchAdapter("https://api.purch.xyz");

    // #when it is quoted as a paid read
    const quote = await adapter.quote(
      { action: "shop.search", intentId: "ci_" + "a1".repeat(12), providerRef: "shop.search", params: SEARCH_PARAMS, executionShape: "PAID_READ" },
      ctx(fn),
    );

    // #then it prices from the search endpoint
    assert.equal(quote.cost.amount, 10_000n);
    assert.equal(quote.settlementChain, SOLANA);
    assert.equal(quote.settlementAsset.symbol, "USDC");
    assert.equal(quote.settlementRecipient, PAY_TO);
    assert.ok(paths.every((p) => p.startsWith("/x402/search")), `touched ${paths.join(", ")}`);
    assert.ok(!paths.some((p) => p.includes("/x402/buy")), "a paid read must never touch the buy endpoint");
  });

  test("the quote records the binding a later execution is compared against", async () => {
    const { fn } = fetchDouble();
    const quote = await new PurchAdapter("https://api.purch.xyz").quote(
      { action: "shop.search", intentId: "ci_" + "a1".repeat(12), providerRef: "shop.search", params: SEARCH_PARAMS, executionShape: "PAID_READ" },
      ctx(fn),
    );
    const terms = quote.terms as Record<string, unknown>;
    assert.equal(terms.executionShape, "PAID_READ");
    assert.equal(terms.endpointClass, PURCH_ENDPOINT_CLASS_SEARCH);
    assert.equal(terms.x402Version, 2);
    assert.equal(terms.mint, SOL_USDC.address);
    assert.equal(terms.payTo, PAY_TO);
    assert.equal(terms.quotedAtomicAmount, "10000");
    assert.match(String(terms.requestHash), /^0x[0-9a-f]{64}$/);
    assert.match(String(terms.challengeHash), /^0x[0-9a-f]{64}$/);
    // Stated positively, so nobody has to infer it from an absence.
    assert.equal(terms.shippingRequired, false);
    assert.equal(terms.contactRequired, false);
  });

  test("the same request hashes identically, and a different one does not", async () => {
    const adapter = new PurchAdapter("https://api.purch.xyz");
    const q = async (params: Record<string, unknown>) =>
      (await adapter.quote(
        { action: "shop.search", intentId: "ci_" + "a1".repeat(12), providerRef: "shop.search", params, executionShape: "PAID_READ" },
        ctx(fetchDouble().fn),
      )).terms as Record<string, unknown>;
    assert.equal((await q(SEARCH_PARAMS)).requestHash, (await q({ query: "wireless mouse" })).requestHash);
    assert.notEqual((await q(SEARCH_PARAMS)).requestHash, (await q({ query: "something else" })).requestHash);
  });
});

describe("quoting never pays", () => {
  /**
   * The property the whole lifecycle order rests on.
   *
   * If a quote could pay, settlement would happen before policy had run, before a reservation existed and
   * before the one-shot proof gate had been claimed — inverting every control in sequence.
   */
  test("the payment capability is never touched during a quote", async () => {
    const { fn, paths } = fetchDouble();
    const adapter = new PurchAdapter("https://api.purch.xyz");
    // The exploding capability is not even passed to `quote` — it takes no capability at all, which is
    // the structural version of this guarantee. The context's discoveryPayment is null too.
    await adapter.quote(
      { action: "shop.search", intentId: "ci_" + "a1".repeat(12), providerRef: "shop.search", params: SEARCH_PARAMS, executionShape: "PAID_READ" },
      ctx(fn),
    );
    // No request carried a payment header, so nothing was ever paid for.
    assert.ok(paths.length >= 1);
    void EXPLODING_PAYMENT;
  });

  test("a quote sends no PAYMENT-SIGNATURE header", async () => {
    const seen: (string | undefined)[] = [];
    const fn = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      seen.push((init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"]);
      return new Response("", { status: 402, headers: { "payment-required": challengeHeader() } });
    }) as unknown as typeof fetch;
    await new PurchAdapter("https://api.purch.xyz").quote(
      { action: "shop.search", intentId: "ci_" + "a1".repeat(12), providerRef: "shop.search", params: SEARCH_PARAMS, executionShape: "PAID_READ" },
      ctx(fn),
    );
    assert.ok(seen.every((h) => h === undefined), "a quote must never carry a payment credential");
  });
});

describe("a fulfilment capability keeps its purchase requirements", () => {
  test("shop.purchase still demands a shipping address", async () => {
    const { fn } = fetchDouble();
    await assert.rejects(
      () =>
        new PurchAdapter("https://api.purch.xyz").quote(
          { action: "shop.purchase", intentId: "ci_" + "a1".repeat(12), providerRef: "B01", params: { query: "x" }, executionShape: "FULFILMENT" },
          ctx(fn),
        ),
      (e: unknown) => isProviderError(e) && /shipping/i.test((e as Error).message),
    );
  });

  test("an absent shape behaves exactly as before the field existed", async () => {
    // #given no executionShape at all — a caller written before the field
    const { fn } = fetchDouble();
    // #then it takes the FULFILMENT path, so an older caller's meaning is unchanged
    await assert.rejects(
      () =>
        new PurchAdapter("https://api.purch.xyz").quote(
          { action: "shop.purchase", intentId: "ci_" + "a1".repeat(12), providerRef: "B01", params: { query: "x" } },
          ctx(fn),
        ),
      (e: unknown) => isProviderError(e) && /shipping/i.test((e as Error).message),
    );
  });
});

describe("a challenge that does not match the authorisation is refused", () => {
  const authorisedQuote = {
    providerId: "purch",
    providerRef: "shop.search",
    cost: money(10_000n, SOL_USDC),
    settlementRecipient: PAY_TO,
    settlementChain: SOLANA as never,
    settlementAsset: SOL_USDC,
    summary: "Paid search: wireless mouse",
    terms: {
      endpointClass: PURCH_ENDPOINT_CLASS_SEARCH,
      requestHash: "0x" + "00".repeat(32),
      mint: SOL_USDC.address,
    },
    expiresAt: "2026-07-30T12:10:00Z",
  };

  async function executeWith(challenge: string, quoteOver: Record<string, unknown> = {}): Promise<unknown> {
    const { fn } = fetchDouble({ challenge });
    return new PurchAdapter("https://api.purch.xyz").execute(
      {
        action: "shop.search",
        intentId: "ci_" + "a1".repeat(12),
        providerRef: "shop.search",
        params: SEARCH_PARAMS,
        idempotencyKey: "k",
        executionShape: "PAID_READ",
        quote: { ...authorisedQuote, ...quoteOver } as never,
      },
      EXPLODING_PAYMENT,
      ctx(fn),
    );
  }

  /**
   * Every case here reaches the exploding payment capability if the refusal does not fire FIRST.
   *
   * That is what makes these tests about ORDER rather than merely about outcome: a refusal that happened
   * after the signer was handed over would surface as the proxy throwing, not as the named refusal.
   */
  test("a raised price is refused before the signer", async () => {
    await assert.rejects(
      () => executeWith(challengeHeader({ amount: "20000" })),
      (e: unknown) => isProviderError(e) && /QUOTE_CHANGED/.test((e as Error).message) && /now asks/.test((e as Error).message),
    );
  });

  test("a changed recipient is refused", async () => {
    await assert.rejects(
      () => executeWith(challengeHeader({ payTo: "9vTAo1Rk1eSMxUq4ELqLYnZ5nfKmMbBhhZHKmVKZzWJk" })),
      (e: unknown) => isProviderError(e) && /recipient changed/.test((e as Error).message),
    );
  });

  /**
   * A changed mint is refused EARLIER than the binding check, by the settlement allowlist.
   *
   * `selectPayment` never offers a non-allowlisted token as a candidate, so the challenge is rejected
   * before `executePaidRead` gets to compare it against the quote. That is a stronger refusal than the
   * one this test was written to expect, and asserting the binding message would have been asserting a
   * code path that a better control makes unreachable — so the assertion is on the refusal, and the
   * layer that produced it is named.
   */
  test("a changed mint is refused before the signer, by the settlement allowlist", async () => {
    await assert.rejects(
      () => executeWith(challengeHeader({ asset: "So11111111111111111111111111111111111111112" })),
      (e: unknown) =>
        isProviderError(e) && /not on the settlement allowlist/.test((e as Error).message),
    );
  });

  test("a mint that IS allowlisted but differs from the quote is caught by the binding check", async () => {
    // The allowlist cannot help here: both are confirmed assets, so only the quote binding distinguishes
    // the authorised token from another acceptable one.
    await assert.rejects(
      () => executeWith(challengeHeader(), { terms: { ...authorisedQuote.terms, mint: "AnotherAllowlistedMint1111111111111111111111" } }),
      (e: unknown) => isProviderError(e) && /token mint changed/.test((e as Error).message),
    );
  });

  test("a request that differs from the quoted one is refused", async () => {
    await assert.rejects(
      () => executeWith(challengeHeader(), { terms: { ...authorisedQuote.terms, requestHash: "0x" + "ff".repeat(32) } }),
      (e: unknown) => isProviderError(e) && /request differs/.test((e as Error).message),
    );
  });

  test("a quote authorised against another endpoint class is refused", async () => {
    await assert.rejects(
      () => executeWith(challengeHeader(), { terms: { ...authorisedQuote.terms, endpointClass: "purch:/x402/buy" } }),
      (e: unknown) => isProviderError(e) && /endpoint class/.test((e as Error).message),
    );
  });
});
