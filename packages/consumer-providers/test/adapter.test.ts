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

  /**
   * This assertion used to read "NOTHING is seeded as verified", which was true until a settlement
   * existed. Deleting it once one did would have thrown away the control along with the obsolete fact,
   * so it now checks the thing the original was standing in for: a verified claim must be BACKED.
   *
   * `verified` is the only value that clears the production execution floor, so it is the one word in
   * the seed that can move money. Requiring dated settlement evidence in the provenance means promoting
   * a capability takes a sentence describing what was observed, which is a much better gate than a
   * blanket prohibition that has to be removed the first time the project succeeds.
   */
  test("anything seeded 'verified' cites dated settlement and delivery evidence", () => {
    for (const seed of PROVIDER_SEEDS) {
      const verifiedCaps = seed.capabilities.filter((c) => c.maturity === "verified");
      const providerVerified = seed.provider.maturity === "verified";

      if (!providerVerified && verifiedCaps.length === 0) continue;

      // A verified capability under a non-verified provider can never execute, because the registry
      // takes the lower of the two. Seeding that pair states something the code will discard.
      if (verifiedCaps.length > 0) {
        assert.ok(
          providerVerified,
          `${seed.provider.providerId} has verified capabilities but is not itself verified`,
        );
      }

      // Provider-level verified means AT LEAST ONE capability is verified. It must not be a bare claim
      // with nothing under it, because the provider row is what a reader sees first.
      assert.ok(
        verifiedCaps.length > 0,
        `${seed.provider.providerId} claims 'verified' with no verified capability beneath it`,
      );

      assert.match(
        seed.provider.provenance,
        /\b20\d{2}-\d{2}-\d{2}\b.*settled/s,
        `${seed.provider.providerId} claims 'verified' without dated settlement evidence in its provenance`,
      );

      for (const cap of verifiedCaps) {
        assert.ok(
          cap.notes.length > 40,
          `${seed.provider.providerId}.${cap.capability} is verified but its notes do not say what was observed`,
        );
      }
    }
  });

  test("only purch shop.search is verified, so no other capability crossed the floor with it", () => {
    // The narrow promotion, pinned. A future edit that promotes a sibling has to change this line, which
    // makes widening the blast radius a deliberate act rather than a side effect.
    const verified = PROVIDER_SEEDS.flatMap((s) =>
      s.capabilities.filter((c) => c.maturity === "verified").map((c) => `${s.provider.providerId}.${c.capability}`),
    ).sort();
    assert.deepEqual(verified, ["purch.shop.search"]);
  });

  test("every seed carries a dated, checkable provenance string", () => {
    for (const seed of PROVIDER_SEEDS) {
      // A DATE, not one specific date. Pinning the literal 2026-07-27 here made the test fail the
      // moment a provider was honestly re-probed — which is exactly the behaviour the provenance
      // rule is meant to encourage, so the assertion was punishing the thing it exists to reward.
      assert.match(
        seed.provider.provenance,
        /\b20\d{2}-\d{2}-\d{2}\b/,
        `${seed.provider.providerId} provenance must name the date it was observed`,
      );
      assert.ok(seed.provider.provenance.length > 120, "provenance must say what was actually observed");
    }
  });

  test("an accessBlocker only ever appears on a capability below 'sandbox'", () => {
    // A blocker says "something outside Untch is in the way". On a capability that has settled and
    // verified, that claim is contradicted by the evidence — and `publicToolState` deliberately
    // ignores it there, so a seed carrying both would be stating something the code discards.
    for (const seed of PROVIDER_SEEDS) {
      for (const cap of seed.capabilities) {
        if (!cap.accessBlocker) continue;
        assert.equal(
          cap.maturity,
          "experimental",
          `${seed.provider.providerId}.${cap.capability} carries accessBlocker ` +
            `${cap.accessBlocker} at maturity '${cap.maturity}'`,
        );
        assert.ok(
          cap.notes.length > 40,
          `${seed.provider.providerId}.${cap.capability} must say WHY it is blocked`,
        );
      }
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

describe("Untch Mail — one merchant, eight tools, no shared blast radius", () => {
  const paidQuote = (action: Parameters<StableEmailAdapter["quote"]>[0]["action"], params: Record<string, unknown>, fixture: unknown) => {
    const { fetchImpl, requests } = scriptedFetch([{ status: 402, headers: challengeHeader(fixture) }]);
    return {
      requests,
      run: () =>
        new StableEmailAdapter().quote(
          { action, intentId: "ci_mail", providerRef: "", params },
          ctx({ fetchImpl }),
        ),
    };
  };

  test("every price comes from the merchant's OWN live challenge, per tool", async () => {
    const cases: readonly [Parameters<StableEmailAdapter["quote"]>[0]["action"], Record<string, unknown>, string, bigint][] = [
      ["mail.send", { to: ["a@b.com"], subject: "s", text: "t" }, "stableemailSend402", 20_000n],
      ["mail.inbox.buy", { username: "untchprobe", forwardTo: "probe@example.com" }, "stableemailInboxBuy402", 1_000_000n],
      ["mail.inbox.topup", { username: "untchprobe" }, "stableemailInboxTopup402", 1_000_000n],
      ["mail.subdomain.buy", { subdomain: "untchprobe" }, "stableemailSubdomainBuy402", 5_000_000n],
      [
        "mail.subdomain.send",
        { from: "a@untchprobe.stableemail.dev", to: ["b@example.com"], subject: "s", text: "t" },
        "stableemailSubdomainSend402",
        5_000n,
      ],
    ];

    for (const [action, params, fixture, expected] of cases) {
      const { run } = paidQuote(action, params, FIXTURES[fixture]);
      const q = await run();
      assert.equal(q.cost.amount, expected, `${action} price`);
      assert.equal(q.settlementChain, BASE, `${action} chain`);
      assert.equal(
        q.settlementRecipient.toLowerCase(),
        "0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671",
        `${action} payTo`,
      );
    }
  });

  test("a quote never carries the recipient list, the subject or the body — only hashes", async () => {
    const { run } = paidQuote(
      "mail.send",
      { to: ["alice@example.com"], subject: "Your order 4471", text: "Ship to 12 Acacia Ave" },
      FIXTURES.stableemailSend402,
    );
    const q = await run();
    // A quote carries Money, which is bigint-valued, so the leak check needs a replacer rather than
    // a bare stringify — otherwise the assertion throws before it can find anything.
    const serialized = JSON.stringify(q, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    assert.ok(!serialized.includes("alice@example.com"), "a recipient address leaked into the quote");
    assert.ok(!serialized.includes("Your order 4471"), "the subject leaked into the quote");
    assert.ok(!serialized.includes("Acacia"), "the body leaked into the quote");
    assert.equal(q.terms.recipientCount, 1);
    assert.match(String(q.terms.subjectHash), /^0x[0-9a-f]{64}$/);
    assert.match(String(q.terms.bodyHash), /^0x[0-9a-f]{64}$/);
  });

  test("the body hash binds the bytes, so a body swapped after approval produces a different quote", async () => {
    const a = await paidQuote("mail.send", { to: ["a@b.com"], subject: "s", text: "one" }, FIXTURES.stableemailSend402).run();
    const b = await paidQuote("mail.send", { to: ["a@b.com"], subject: "s", text: "two" }, FIXTURES.stableemailSend402).run();
    assert.equal(a.terms.subjectHash, b.terms.subjectHash, "same subject, same subject hash");
    assert.notEqual(a.terms.bodyHash, b.terms.bodyHash, "a changed body must change the bound hash");
  });

  test("a free SIWX operation is refused a quote rather than priced at zero", async () => {
    const adapter = new StableEmailAdapter();
    for (const [action, params] of [
      ["mail.inbox.status", { username: "untchprobe" }],
      ["mail.subdomain.status", { subdomain: "untchprobe" }],
      ["mail.inbox.cancel", { username: "untchprobe" }],
    ] as const) {
      await assert.rejects(
        () => adapter.quote({ action, intentId: "ci_x", providerRef: "", params }, ctx()),
        (e: unknown) => {
          assert.ok(isProviderError(e) && e.normalized.code === "CAPABILITY_UNAVAILABLE");
          assert.match(e.normalized.message, /not quotable/);
          return true;
        },
        `${action} must not be quotable`,
      );
    }
  });

  test("a SIWX-gated read with no identity key is PROVIDER_UNAUTHORIZED, never a fabricated status", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.stableemailInboxStatusSiwx402) },
    ]);
    await assert.rejects(
      () =>
        new StableEmailAdapter().discover(
          { action: "mail.inbox.status", params: { username: "untchprobe" }, limit: 1 },
          ctx({ fetchImpl, siwx: new SiwxSigner({ privateKey: null }) }),
        ),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "PROVIDER_UNAUTHORIZED");
        return true;
      },
    );
  });

  test("an inbox status read signs SIWX and reduces the owner's forwarding address to a boolean", async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.stableemailInboxStatusSiwx402) },
      {
        status: 200,
        body: {
          inbox: "untchprobe@stableemail.dev",
          ownerWallet: "0x0e79371813e88F31c2B60C80bad391a952039095",
          forwardTo: "someone@personal.example",
          retainMessages: true,
          expiresAt: "2026-08-28T00:00:00.000Z",
          daysRemaining: 30,
          active: true,
        },
      },
    ]);
    const result = await new StableEmailAdapter().discover(
      { action: "mail.inbox.status", params: { username: "untchprobe" }, limit: 1 },
      ctx({ fetchImpl, siwx: new SiwxSigner({ privateKey: KEY, clock: () => Date.parse("2026-07-29T13:53:00.000Z") }) }),
    );

    assert.equal(requests.length, 2, "one unauthenticated probe, then one signed retry");
    assert.ok(requests[1]?.headers["sign-in-with-x"], "the retry must carry the SIWX credential");
    assert.equal(result.options.length, 1);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("someone@personal.example"), "the owner's forwarding address leaked");
    assert.equal(result.options[0]?.attributes.forwarding, true);
    assert.equal(result.options[0]?.attributes.daysRemaining, 30);
  });

  test("a send is refused a discovery surface — there is nothing to browse", async () => {
    await assert.rejects(
      () =>
        new StableEmailAdapter().discover(
          { action: "mail.send", params: { to: ["a@b.com"], subject: "s", text: "t" }, limit: 5 },
          ctx(),
        ),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "CAPABILITY_UNAVAILABLE");
        return true;
      },
    );
  });

  test("an execute records a message-id HASH and a recipient count, never the message", async () => {
    const cap = fakeCapability({ recipients: ["0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671"] });
    const { fetchImpl } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.stableemailSend402) },
      {
        status: 200,
        body: { success: true, messageId: "0199-abcd-relay-id", from: "relay@stableemail.dev" },
        headers: {
          "payment-response": Buffer.from(
            JSON.stringify({ success: true, transaction: `0x${"e".repeat(64)}` }),
            "utf8",
          ).toString("base64"),
        },
      },
    ]);

    const exec = await new StableEmailAdapter().execute(
      {
        action: "mail.send",
        intentId: "ci_mail",
        providerRef: "send",
        idempotencyKey: "idem-mail-0001",
        params: { to: ["alice@example.com"], subject: "Your order 4471", text: "Ship to 12 Acacia Ave" },
        quote: {
          providerId: "stableemail",
          providerRef: "send",
          cost: money(20_000n, USDC),
          settlementRecipient: "0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671",
          settlementChain: BASE,
          settlementAsset: USDC,
          summary: "Send 1 email to 1 recipient",
          terms: {},
          expiresAt: new Date(NOW + 600_000).toISOString(),
        },
      },
      cap,
      ctx({ fetchImpl }),
    );

    assert.equal(exec.providerReference, "0199-abcd-relay-id");
    assert.equal(exec.settlement.amount.amount, 20_000n);
    const serialized = JSON.stringify(exec.payload);
    assert.ok(!serialized.includes("alice@example.com"), "a recipient leaked into the execution payload");
    assert.ok(!serialized.includes("Acacia"), "the body leaked into the execution payload");
    assert.ok(!serialized.includes("0199-abcd-relay-id"), "the raw message id leaked into the payload");
    assert.match(String(exec.payload.messageIdHash), /^0x[0-9a-f]{64}$/);
    assert.equal(exec.payload.recipientCount, 1);
  });

  test("an inbox purchase produces a kind-prefixed reference, so delivery can be polled", async () => {
    const cap = fakeCapability({ recipients: ["0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671"] });
    const { fetchImpl } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.stableemailInboxBuy402) },
      {
        status: 200,
        body: { success: true, inbox: "untchprobe@stableemail.dev", retainMessages: true, daysRemaining: 30 },
        headers: {
          "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: `0x${"f".repeat(64)}` }), "utf8").toString("base64"),
        },
      },
    ]);

    const exec = await new StableEmailAdapter().execute(
      {
        action: "mail.inbox.buy",
        intentId: "ci_inbox",
        providerRef: "inbox:untchprobe",
        idempotencyKey: "idem-inbox-0001",
        params: { username: "untchprobe", forwardTo: "probe@example.com" },
        quote: {
          providerId: "stableemail",
          providerRef: "inbox:untchprobe",
          cost: money(1_000_000n, USDC),
          settlementRecipient: "0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671",
          settlementChain: BASE,
          settlementAsset: USDC,
          summary: "Buy the inbox untchprobe@stableemail.dev for 30 days",
          terms: {},
          expiresAt: new Date(NOW + 600_000).toISOString(),
        },
      },
      cap,
      ctx({ fetchImpl }),
    );

    assert.equal(exec.providerReference, "inbox:untchprobe@stableemail.dev");
    assert.ok(!JSON.stringify(exec.payload).includes("probe@example.com"), "the forwarding address leaked");
  });

  test("a send's delivery evidence is honestly unverified; an inbox's is a real status poll", async () => {
    const adapter = new StableEmailAdapter();
    const base = {
      settlement: { txHash: null, chain: BASE, amount: money(20_000n, USDC), recipient: "0xdb5a" },
      providerStatus: "accepted",
      payload: {},
      acknowledgedAt: new Date(NOW).toISOString(),
    };

    const sendEvidence = await adapter.verifyDelivery({ ...base, providerReference: "relay-msg-1" }, ctx());
    assert.equal(sendEvidence.untchVerified.verified, false);
    assert.equal(sendEvidence.untchVerified.method, "NONE");

    // An inbox is verified by PAYING to read it. Being admitted by the provider as the payer IS the
    // ownership proof, and it needs no SIWX identity — which is the whole point, because the
    // identity key is deliberately not the treasury that owns the inbox.
    const cap = fakeCapability({ max: parseMoney("0.01", USDC), recipients: ["0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671"] });
    const { fetchImpl, requests } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.stableemailInboxMessages402) },
      { status: 200, body: { success: true, messages: [] } },
    ]);
    const inboxEvidence = await adapter.verifyDelivery(
      { ...base, providerReference: "inbox:untchprobe@stableemail.dev" },
      ctx({ fetchImpl, discoveryPayment: cap }),
    );
    assert.equal(requests[0]?.url, "https://stableemail.dev/api/inbox/messages");
    assert.equal(inboxEvidence.untchVerified.verified, true);
    assert.equal(inboxEvidence.untchVerified.method, "PROVIDER_STATUS_POLL");
    assert.match(inboxEvidence.untchVerified.detail, /admitted the Untch treasury as this inbox's owner/);
  });

  test("an inbox read reduces senders and subjects to hashes before they become options", async () => {
    const cap = fakeCapability({ max: parseMoney("0.01", USDC), recipients: ["0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671"] });
    const { fetchImpl } = scriptedFetch([
      { status: 402, headers: challengeHeader(FIXTURES.stableemailInboxMessages402) },
      {
        status: 200,
        body: {
          success: true,
          messages: [
            { id: "msg-1", fromEmail: "someone@personal.example", subject: "Re: Untch Mail delivery proof 462F", receivedAt: "2026-07-29T16:00:00.000Z", read: false },
          ],
        },
      },
    ]);
    const result = await new StableEmailAdapter().discover(
      { action: "mail.inbox.messages", params: { username: "untchprobe" }, limit: 20 },
      ctx({ fetchImpl, discoveryPayment: cap }),
    );

    const serialized = JSON.stringify(result, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    assert.ok(!serialized.includes("someone@personal.example"), "the sender address leaked");
    assert.ok(!serialized.includes("delivery proof 462F"), "the subject text leaked");
    const attrs = result.options[0]?.attributes ?? {};
    assert.match(String(attrs.fromHash), /^0x[0-9a-f]{64}$/);
    assert.match(String(attrs.subjectHash), /^0x[0-9a-f]{64}$/);
    assert.equal(attrs.receivedAt, "2026-07-29T16:00:00.000Z");
  });

  test("provider-side input rules are enforced BEFORE any money moves", async () => {
    const adapter = new StableEmailAdapter();
    const reject = async (action: Parameters<StableEmailAdapter["quote"]>[0]["action"], params: Record<string, unknown>, why: RegExp) =>
      assert.rejects(
        () => adapter.quote({ action, intentId: "ci_x", providerRef: "", params }, ctx()),
        (e: unknown) => {
          assert.ok(isProviderError(e) && e.normalized.code === "PROVIDER_BAD_REQUEST", `${action}: ${String(e)}`);
          assert.match(e.normalized.message, why);
          return true;
        },
      );

    await reject("mail.inbox.buy", { username: "no" }, /3-30 characters/);
    await reject("mail.inbox.buy", { username: "Bad_Name" }, /3-30 characters/);
    await reject("mail.inbox.buy", { username: "untchprobe", forwardTo: "not-an-email" }, /not a valid email/);
    await reject("mail.inbox.topup", { username: "untchprobe", period: "fortnight" }, /must be one of/);
    await reject("mail.subdomain.send", { from: "a@elsewhere.test", to: ["b@c.com"], subject: "s", text: "t" }, /subdomain of stableemail\.dev/);
    await reject("mail.send", { to: [], subject: "s", text: "t" }, /between 1 and 50/);
    await reject("mail.send", { to: ["a@b.com"], subject: "   ", text: "t" }, /`subject` is required/);
    await reject("mail.send", { to: ["a@b.com"], subject: "s" }, /one of `text` or `html`/);
  });

  test("the top-up period selects the provider's own endpoint, not a computed price", async () => {
    for (const [period, path] of [
      ["month", "/api/inbox/topup"],
      ["quarter", "/api/inbox/topup/quarter"],
      ["year", "/api/inbox/topup/year"],
    ] as const) {
      const { fetchImpl, requests } = scriptedFetch([
        { status: 402, headers: challengeHeader(FIXTURES.stableemailInboxTopup402) },
      ]);
      await new StableEmailAdapter().quote(
        { action: "mail.inbox.topup", intentId: "ci_t", providerRef: "", params: { username: "untchprobe", period } },
        ctx({ fetchImpl }),
      );
      assert.equal(requests[0]?.url, `https://stableemail.dev${path}`);
    }
  });
});
