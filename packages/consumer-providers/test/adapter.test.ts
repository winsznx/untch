import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asset,
  isProviderError,
  money,
  parseMoney,
  type CaipChainId,
  type Money,
  type PaymentCapability,
  type PaymentRequest,
  type PaymentResult,
} from "@untch/consumer-core";
import {
  StableDomainsAdapter,
  StableEmailAdapter,
  StableTravelAdapter,
  PurchAdapter,
  assertSeedMatchesAdapters,
  buildAdapterRegistry,
  normalizeDomain,
  parseNotifyMessage,
  PROVIDER_SEEDS,
  SiwxSigner,
  type AdapterContext,
} from "../src/index";

const FIXTURES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "live-challenges.json"), "utf8"),
) as Record<string, unknown>;

const BASE: CaipChainId = "eip155:8453";
const USDC = asset("base.usdc");
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const NOW = Date.parse("2026-07-27T17:15:00.000Z");

/** A capability that records what it was asked to pay and never touches a rail. */
function fakeCapability(over: { max?: Money; recipients?: string[] } = {}): PaymentCapability & {
  calls: PaymentRequest[];
} {
  const calls: PaymentRequest[] = [];
  let consumed = false;
  return {
    calls,
    capabilityId: "cap_test",
    intentId: "ci_test",
    chain: BASE,
    asset: USDC,
    maxAmount: over.max ?? parseMoney("25.00", USDC),
    allowedRecipients: over.recipients ?? ["0xabcb091d90419e1c8ad4818f1b33fc4645501892"],
    expiresAt: new Date(NOW + 300_000).toISOString(),
    async pay(req: PaymentRequest): Promise<PaymentResult> {
      if (consumed) throw new Error("capability already consumed");
      consumed = true;
      calls.push(req);
      return {
        paymentHeader: "FAKE-PAYMENT",
        headerName: "X-PAYMENT",
        txHash: null,
        amount: req.amount,
        recipient: req.recipient,
        chain: BASE,
      };
    },
  };
}

/** Scripted fetch: a queue of responses, and a record of every request made. */
interface Scripted {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  throws?: Error;
}

function scriptedFetch(script: Scripted[]): {
  fetchImpl: typeof fetch;
  requests: { url: string; method: string; headers: Record<string, string>; body: string | null }[];
} {
  const requests: { url: string; method: string; headers: Record<string, string>; body: string | null }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const step = script[i];
    i += 1;
    if (!step) throw new Error(`scripted fetch ran out of responses at call ${i}`);
    if (step.throws) throw step.throws;
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json", ...(step.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

/** Encode a challenge object the way a provider sends it. */
const challengeHeader = (challenge: unknown): Record<string, string> => ({
  "payment-required": Buffer.from(JSON.stringify(challenge), "utf8").toString("base64"),
});

function ctx(over: Partial<AdapterContext> = {}): AdapterContext {
  return {
    correlationId: "cor_test",
    timeoutMs: 2000,
    signableChains: new Set<CaipChainId>([BASE]),
    siwx: null,
    discoveryPayment: null,
    clock: () => NOW,
    // Every host resolves to a public address so the SSRF guard is exercised but does not block.
    resolveHost: async () => ["104.18.0.1"],
    ...over,
  };
}

describe("adapter transport — a call with no spending authority can never pay", () => {
  test("a 402 on a discovery call is a typed refusal, not a silent payment", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.stabledomainsCheck402) },
    ]);
    const adapter = new StableDomainsAdapter();
    await assert.rejects(
      () => adapter.discover({ action: "domains.check", params: { name: "untchprobe" }, limit: 5 }, ctx({ fetchImpl })),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "PAYMENT_CHALLENGE_UNACCEPTABLE");
        assert.match(e.normalized.message, /carries no payment capability/);
        return true;
      },
    );
  });

  test("a discovery call WITH a discovery capability pays and retries", async () => {
    const cap = fakeCapability({ max: parseMoney("0.50", USDC) });
    const { fetchImpl, requests } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.stabledomainsCheck402) },
      {
        status: 200,
        body: {
          name: "untchprobe",
          tlds: [".com", ".xyz"],
          results: [
            { domain: "untchprobe.com", available: true, premium: false, tld: ".com" },
            { domain: "untchprobe.xyz", available: false, premium: false, tld: ".xyz" },
          ],
          availableDomains: ["untchprobe.com"],
          availableCount: 1,
          next: {},
        },
      },
    ]);
    const adapter = new StableDomainsAdapter();
    const result = await adapter.discover(
      { action: "domains.check", params: { name: "untchprobe" }, limit: 5 },
      ctx({ fetchImpl, discoveryPayment: cap }),
    );
    assert.equal(result.options.length, 1);
    assert.equal(result.options[0]?.providerRef, "untchprobe.com");
    // The paid retry carried the payment header.
    assert.equal(requests[1]?.headers["x-payment"], "FAKE-PAYMENT");
    assert.equal(cap.calls.length, 1);
  });
});

describe("adapter transport — SIWX is answered, not mistaken for a payment failure", () => {
  test("a SIWX 402 is signed and the request is retried with the credential", async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.stablemerchDraftsSiwx402) },
      { status: 200, body: { products: [{ product_slug: "mug", title: "Mug" }] } },
    ]);
    const adapter = buildAdapterRegistry().get("stablemerch");
    const result = await adapter.discover(
      { action: "gifts.quote", params: {}, limit: 5 },
      ctx({ fetchImpl, siwx: new SiwxSigner({ privateKey: KEY, clock: () => NOW }) }),
    );
    assert.equal(result.options.length, 1);
    assert.ok(requests[1]?.headers["sign-in-with-x"], "the retry must carry the SIWX credential");
  });

  test("without a SIWX key the call reports PROVIDER_UNAUTHORIZED, never a fake success", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.stablemerchDraftsSiwx402) },
    ]);
    const adapter = buildAdapterRegistry().get("stablemerch");
    await assert.rejects(
      () => adapter.discover({ action: "gifts.quote", params: {}, limit: 5 }, ctx({ fetchImpl })),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "PROVIDER_UNAUTHORIZED");
        assert.match(e.normalized.message, /SIWX/);
        return true;
      },
    );
  });
});

describe("adapter transport — the paid retry is AMBIGUOUS when it fails", () => {
  test("a transport failure AFTER the payment header was sent is never retryable", async () => {
    // This is the single most consequential classification in the system: the authorization has
    // left the building and the provider may act on it even though we never saw the response.
    const cap = fakeCapability();
    const { fetchImpl } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.stabledomainsRegister402) },
      { status: 0, throws: Object.assign(new Error("socket hang up"), { name: "TypeError" }) },
    ]);
    const adapter = new StableDomainsAdapter();
    await assert.rejects(
      () =>
        adapter.execute(
          {
            action: "domains.register",
            intentId: "ci_test",
            providerRef: "untchprobe.com",
            params: {},
            idempotencyKey: "untch-exec-abc",
            quote: {
              providerId: "stabledomains",
              providerRef: "untchprobe.com",
              cost: money(20_000_000n, USDC),
              settlementRecipient: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
              settlementChain: BASE,
              settlementAsset: USDC,
              summary: "Register untchprobe.com",
              terms: { readyToRegister: true },
              expiresAt: new Date(NOW + 600_000).toISOString(),
            },
          },
          cap,
          ctx({ fetchImpl }),
        ),
      (e: unknown) => {
        assert.ok(isProviderError(e));
        assert.equal(e.normalized.code, "PAYMENT_AMBIGUOUS");
        assert.equal(e.normalized.retryable, false, "an ambiguous payment must NEVER be retryable");
        assert.equal(e.normalized.sideEffectPossible, true);
        return true;
      },
    );
  });

  test("a timeout is classified ambiguous, not retryable", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 0, throws: Object.assign(new Error("aborted"), { name: "AbortError" }) },
    ]);
    const adapter = new StableEmailAdapter();
    await assert.rejects(
      () =>
        adapter.quote(
          {
            action: "notify.receipt",
            intentId: "ci_x",
            providerRef: "",
            params: { to: ["a@b.com"], subject: "hi", text: "hello" },
          },
          ctx({ fetchImpl }),
        ),
      (e: unknown) => {
        assert.ok(isProviderError(e));
        assert.equal(e.normalized.code, "PROVIDER_AMBIGUOUS");
        assert.equal(e.normalized.retryable, false);
        return true;
      },
    );
  });

  test("a redirect is refused rather than followed", async () => {
    const { fetchImpl } = scriptedFetch([{ status: 302, headers: { location: "https://evil.test/x" } }]);
    const adapter = new StableEmailAdapter();
    await assert.rejects(
      () =>
        adapter.quote(
          { action: "notify.receipt", intentId: "ci_x", providerRef: "", params: { to: ["a@b.com"], subject: "s", text: "t" } },
          ctx({ fetchImpl }),
        ),
      /redirects are not followed/,
    );
  });

  test("an https-only rule blocks a plain-http base URL before any request", async () => {
    const adapter = new StableEmailAdapter("http://stableemail.dev");
    await assert.rejects(
      () =>
        adapter.quote(
          { action: "notify.receipt", intentId: "ci_x", providerRef: "", params: { to: ["a@b.com"], subject: "s", text: "t" } },
          ctx(),
        ),
      /scheme http: is not permitted/,
    );
  });

  test("a provider host resolving to a private address is refused (SSRF)", async () => {
    const adapter = new StableEmailAdapter();
    await assert.rejects(
      () =>
        adapter.quote(
          { action: "notify.receipt", intentId: "ci_x", providerRef: "", params: { to: ["a@b.com"], subject: "s", text: "t" } },
          ctx({ resolveHost: async () => ["169.254.169.254"] }),
        ),
      /resolves to a non-public address/,
    );
  });
});

describe("StableDomains — the registrant-profile prerequisite", () => {
  const quoteFor = (readyToRegister: boolean) => ({
    providerId: "stabledomains",
    providerRef: "untchprobe.com",
    cost: money(20_000_000n, USDC),
    settlementRecipient: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
    settlementChain: BASE,
    settlementAsset: USDC,
    summary: "Register untchprobe.com",
    terms: { readyToRegister, profileNote: "no ICANN registrant profile on file for the paying wallet" },
    expiresAt: new Date(NOW + 600_000).toISOString(),
  });

  test("execute REFUSES before spending when the profile is not verified", async () => {
    // The whole point: $20 must not be spent on a call the provider will reject for a missing
    // profile. The refusal happens before a single request goes out.
    const cap = fakeCapability();
    const { fetchImpl, requests } = scriptedFetch([]);
    const adapter = new StableDomainsAdapter();
    await assert.rejects(
      () =>
        adapter.execute(
          {
            action: "domains.register",
            intentId: "ci_x",
            providerRef: "untchprobe.com",
            params: {},
            idempotencyKey: "untch-exec-x",
            quote: quoteFor(false),
          },
          cap,
          ctx({ fetchImpl }),
        ),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "PROVIDER_UNAUTHORIZED");
        assert.match(e.normalized.message, /registrant profile/);
        return true;
      },
    );
    assert.equal(requests.length, 0, "no request may be made at all");
    assert.equal(cap.calls.length, 0, "no payment may be attempted");
  });

  test("execute proceeds when the profile IS verified", async () => {
    const cap = fakeCapability();
    const { fetchImpl } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.stabledomainsRegister402) },
      {
        status: 200,
        body: { domain: "untchprobe.com", status: "pending", registrationEmailSent: true, next: {}, orderId: "ord_1" },
      },
    ]);
    const adapter = new StableDomainsAdapter();
    const exec = await adapter.execute(
      {
        action: "domains.register",
        intentId: "ci_x",
        providerRef: "untchprobe.com",
        params: {},
        idempotencyKey: "untch-exec-x",
        quote: quoteFor(true),
      },
      cap,
      ctx({ fetchImpl }),
    );
    assert.equal(exec.providerReference, "ord_1");
    assert.equal(exec.settlement.amount.amount, 20_000_000n);
    assert.equal(exec.providerStatus, "pending");
  });

  test("a 200 that never demanded payment is refused rather than recorded as a settlement", async () => {
    const cap = fakeCapability();
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: { domain: "untchprobe.com", status: "active", registrationEmailSent: false, next: {} } },
    ]);
    const adapter = new StableDomainsAdapter();
    await assert.rejects(
      () =>
        adapter.execute(
          {
            action: "domains.register",
            intentId: "ci_x",
            providerRef: "untchprobe.com",
            params: {},
            idempotencyKey: "untch-exec-x",
            quote: quoteFor(true),
          },
          cap,
          ctx({ fetchImpl }),
        ),
      /without ever demanding payment/,
    );
  });
});

describe("StableTravel — refuses to pretend it can book", () => {
  test("it declares no booking capability at all", () => {
    const caps = new StableTravelAdapter().capabilities().map((c) => c.capability);
    assert.deepEqual(caps.sort(), ["travel.compare", "travel.search"]);
    assert.equal(caps.includes("travel.book"), false);
  });

  test("quote() refuses with the provider's own words", async () => {
    await assert.rejects(
      () =>
        new StableTravelAdapter().quote(
          { action: "travel.quote", intentId: "ci_x", providerRef: "tok", params: {} },
          ctx(),
        ),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "CAPABILITY_UNAVAILABLE");
        assert.match(e.normalized.message, /does not issue tickets/);
        return true;
      },
    );
  });

  test("execute() refuses to spend against a provider that does not sell the thing", async () => {
    await assert.rejects(
      () =>
        new StableTravelAdapter().execute(
          {
            action: "travel.book",
            intentId: "ci_x",
            providerRef: "tok",
            params: {},
            idempotencyKey: "k",
            quote: {
              providerId: "stabletravel",
              providerRef: "tok",
              cost: money(1n, USDC),
              settlementRecipient: "0x0",
              settlementChain: BASE,
              settlementAsset: USDC,
              summary: "",
              terms: {},
              expiresAt: new Date(NOW).toISOString(),
            },
          },
          fakeCapability(),
          ctx(),
        ),
      /does not sell the thing being bought/,
    );
  });
});

describe("Purch — Solana-only, and honest about it", () => {
  test("every option in its challenge is on Solana, so selection fails on a Base-only signer", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.purchSearch402) },
    ]);
    const cap = fakeCapability();
    await assert.rejects(
      () =>
        new PurchAdapter().discover(
          { action: "shop.search", params: { query: "coffee mug" }, limit: 5 },
          ctx({ fetchImpl, discoveryPayment: cap }),
        ),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "PAYMENT_CHALLENGE_UNACCEPTABLE");
        assert.match(e.normalized.message, /no signing key configured for this rail/);
        return true;
      },
    );
  });
});

describe("input validation happens before anything is spent", () => {
  test("an unsupported TLD is rejected without a request", () => {
    assert.throws(() => normalizeDomain("example.wtf"), /not one of the 28/);
  });

  test("a malformed hostname is rejected", () => {
    for (const bad of ["not a domain", "-lead.com", "a..b.com", "x".repeat(300) + ".com"]) {
      assert.throws(() => normalizeDomain(bad));
    }
  });

  test("domains are normalised to lowercase with the trailing dot removed", () => {
    assert.equal(normalizeDomain("ExAmPlE.COM."), "example.com");
  });

  test("an email message with neither text nor html is rejected", () => {
    assert.throws(() => parseNotifyMessage({ to: ["a@b.com"], subject: "s" }), /one of `text` or `html`/);
  });

  test("an invalid recipient address is rejected", () => {
    assert.throws(() => parseNotifyMessage({ to: ["not-an-email"], subject: "s", text: "t" }), /valid email/);
  });

  test("more than 50 recipients is rejected", () => {
    const to = Array.from({ length: 51 }, (_, i) => `a${i}@b.com`);
    assert.throws(() => parseNotifyMessage({ to, subject: "s", text: "t" }), /between 1 and 50/);
  });
});

describe("the registry seed and the adapters cannot drift apart", () => {
  test("every seeded capability is implemented, and every adapter is seeded", () => {
    assertSeedMatchesAdapters(buildAdapterRegistry());
  });

  test("NOTHING is seeded as 'verified' — no settlement has ever been proven", () => {
    for (const seed of PROVIDER_SEEDS) {
      assert.notEqual(
        seed.provider.maturity,
        "verified",
        `${seed.provider.providerId} claims 'verified' without a proven settlement`,
      );
      for (const cap of seed.capabilities) {
        assert.notEqual(cap.maturity, "verified", `${seed.provider.providerId}.${cap.capability}`);
      }
    }
  });

  test("every seed carries a dated, checkable provenance string", () => {
    for (const seed of PROVIDER_SEEDS) {
      assert.match(seed.provider.provenance, /2026-07-27/, `${seed.provider.providerId} provenance`);
      assert.ok(seed.provider.provenance.length > 120, "provenance must say what was actually observed");
    }
  });

  test("every seeded base URL is https", () => {
    for (const seed of PROVIDER_SEEDS) {
      assert.match(seed.provider.baseUrl, /^https:\/\//);
    }
  });

  test("a provider with no adapter is refused by name", () => {
    assert.throws(() => buildAdapterRegistry().get("nope"), /no adapter is implemented/);
  });
});
