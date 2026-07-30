import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { asset, money, type Money } from "@untch/consumer-core";
import {
  PAID_READ_VERIFIER_VERSION,
  paidReadResultHash,
  verifyPersistedPaidRead,
  type PaidReadVerificationInput,
} from "../src/adapters/purch-paid-read-verify";
import { PURCH_ENDPOINT_CLASS_SEARCH } from "../src/adapters/purch";

/**
 * Verifying a paid read from evidence alone.
 *
 * The first bounded Purch proof settled 0.010000 USDC on Solana mainnet and produced a receipt reading
 * `untchVerified: false, method: NONE`. That was accurate: the delivery check had been written for a
 * physical shipment, where Untch can prove an order was placed and cannot prove a parcel arrived.
 *
 * For a paid read that reasoning gives the wrong answer, because the returned result IS the delivered
 * service. These tests fix the shape-aware half in place: what it must prove, and — more importantly —
 * every case where it must refuse rather than flatter the record.
 */

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_USDC = asset("solana.usdc");
const PAY_TO = "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2";
const TREASURY_AUTHORITY = "FSW47vP9xHqPZbBqA1Vtn6HDMPQvXPvXvHqZoR2mGz3k";
const TX = "63cbzAEuDkMFs41TwuGKjYC3YWz3e8FeYbQVfrt2WGmvWotdUMmiJCf3yzyd8EypPDikfQjWAxWGUa5rDTJLrhVK";

const PRODUCTS = [
  { asin: "B0TEST0001", title: "USB-C cable, 2 m", price: "9.99", currency: "USD", source: "amazon", productUrl: "https://example.com/a", imageUrl: "https://example.com/a.jpg" },
  { asin: "B0TEST0002", title: "USB-C cable, 1 m", price: "7.49", currency: "USD", source: "amazon", productUrl: "https://example.com/b", imageUrl: "https://example.com/b.jpg" },
] as const;

const QUERY = "usb-c cable";

/**
 * The persisted result, hashed the way the adapter hashed it at execution time.
 *
 * Computed through the verifier's own exported helper rather than pasted in, so a fixture cannot drift
 * into agreeing with a hash nobody produces.
 */
function attested(over: Record<string, unknown> = {}): Record<string, unknown> {
  const parsed = paidReadResultHash(QUERY, [
    { asin: "B0TEST0001", title: "USB-C cable, 2 m", price: "9.99", currency: "USD", source: "amazon", url: "https://example.com/a", imageUrl: "https://example.com/a.jpg" },
    { asin: "B0TEST0002", title: "USB-C cable, 1 m", price: "7.49", currency: "USD", source: "amazon", url: "https://example.com/b", imageUrl: "https://example.com/b.jpg" },
  ]);
  return { query: QUERY, count: PRODUCTS.length, products: PRODUCTS, resultHash: parsed, ...over };
}

function input(over: Partial<PaidReadVerificationInput> = {}): PaidReadVerificationInput {
  return {
    intentId: "ci_e58174e549f6a21c591eacfa",
    providerId: "purch",
    capability: "shop.search",
    executionShape: "PAID_READ",
    quoteTerms: {
      endpointClass: PURCH_ENDPOINT_CLASS_SEARCH,
      payTo: PAY_TO,
      mint: SOL_USDC.address,
      requestHash: "0xdeadbeef",
    },
    quoteCost: money(10_000n, SOL_USDC),
    quoteHash: "0xq",
    settlementRecipient: PAY_TO,
    settlementChain: SOLANA,
    settlementAssetSymbol: "USDC",
    settlementMint: SOL_USDC.address,
    reservedAtomic: 10_050n,
    gateCeilingAtomic: 20_000n,
    executions: [{ state: "PAID", settlementTxHash: TX, settlementChain: SOLANA, settledAtomic: 10_000n }],
    registeredAuthority: TREASURY_AUTHORITY,
    attestedFields: attested(),
    attestedStatus: "fulfilled",
    request: { query: QUERY },
    ...over,
  };
}

const codes = (i: Partial<PaidReadVerificationInput>): readonly string[] =>
  verifyPersistedPaidRead(input(i)).refusals.map((r) => r.code);

describe("a paid read verifies from what production already holds", () => {
  test("the happy path verifies, with no shipment and no email anywhere in it", () => {
    // #given the evidence shape a completed paid read leaves behind
    // #when it is verified
    const v = verifyPersistedPaidRead(input());
    // #then the binding is established, under the shape-aware method
    assert.equal(v.verified, true, JSON.stringify(v.refusals));
    assert.equal(v.method, "PAID_READ_RESULT_BINDING");
    assert.equal(v.productCount, 2);
    assert.ok(v.resultHash?.startsWith("0x"));
    // …and nothing in it asked for the fields a physical purchase needs.
    const rendered = JSON.stringify(v);
    assert.ok(!/shippingAddress|shipment|tracking/.test(rendered));
  });

  /**
   * The claim is bounded, and the bound is asserted rather than trusted to reviewers.
   *
   * A verification that implied Untch had checked prices or stock would be worse than the `NONE` it
   * replaces, because `NONE` at least reads as an absence.
   */
  test("the detail claims the service ran, and explicitly disclaims listing accuracy", () => {
    const v = verifyPersistedPaidRead(input());
    assert.ok(v.detail.includes("does not verify"));
    assert.ok(/accurate|priced|in stock/.test(v.detail));
  });

  test("the same evidence always produces the same result hash and evidence digest", () => {
    // #given two independent verifications of identical evidence
    const a = verifyPersistedPaidRead(input());
    const b = verifyPersistedPaidRead(input());
    // #then both agree bit for bit, which is what makes a redrive idempotent
    assert.equal(a.resultHash, b.resultHash);
    assert.equal(a.evidenceDigest, b.evidenceDigest);
  });

  test("a different intent produces a different evidence digest", () => {
    assert.notEqual(
      verifyPersistedPaidRead(input()).evidenceDigest,
      verifyPersistedPaidRead(input({ intentId: "ci_000000000000000000000000" })).evidenceDigest,
    );
  });
});

describe("the verifier refuses rather than flattering the record", () => {
  test("a result answering a different query than the intent authorised is not bound", () => {
    // #given a result for a query nobody asked for
    // #then the binding, which is the entire assertion, fails
    assert.ok(codes({ request: { query: "espresso machine" } }).includes("RESULT_NOT_BOUND"));
  });

  test("a result that does not hash to what execution recorded is refused", () => {
    assert.ok(codes({ attestedFields: attested({ resultHash: `0x${"1".repeat(64)}` }) }).includes("RESULT_HASH_MISMATCH"));
  });

  /**
   * A substituted purchase response is caught on its SHAPE, not only its hash.
   *
   * Someone recomputing the hash to match would still be carrying an order id, and a paid read never has
   * one. Checking the shape means the cheap forgery fails too.
   */
  test("a purchase response substituted for a search result is refused on shape", () => {
    for (const field of ["orderId", "shipment", "tracking", "shippingAddress", "email"]) {
      assert.ok(
        codes({ attestedFields: attested({ [field]: "x" }) }).includes("PURCHASE_RESULT_SUBSTITUTED"),
        `${field} must be refused`,
      );
    }
  });

  test("a settlement above the authorised quote, the reservation or the gate ceiling is refused", () => {
    const over = (n: bigint): readonly string[] =>
      codes({ executions: [{ state: "PAID", settlementTxHash: TX, settlementChain: SOLANA, settledAtomic: n }] });
    assert.ok(over(10_001n).includes("ABOVE_AUTHORISED_QUOTE"));
    assert.ok(over(30_000n).includes("ABOVE_GATE_CEILING"));
    assert.ok(over(30_000n).includes("ABOVE_RESERVATION"));
  });

  test("a settlement on the wrong chain, asset or mint is refused", () => {
    assert.ok(codes({ settlementChain: "eip155:8453" }).includes("CHAIN_NOT_SOLANA"));
    assert.ok(codes({ settlementAssetSymbol: "USDT0" }).includes("ASSET_MISMATCH"));
    assert.ok(codes({ settlementMint: "SomeOtherMint1111111111111111111111111111111" }).includes("MINT_MISMATCH"));
  });

  test("a payment to a recipient the quote did not name is refused", () => {
    assert.ok(codes({ settlementRecipient: TREASURY_AUTHORITY }).includes("RECIPIENT_MISMATCH"));
  });

  /**
   * Paying our own treasury would mean the "merchant" was us.
   *
   * The banned self-transfer, in verification form: a transaction that moves value in a circle proves
   * a rail works and proves nothing at all about a purchase.
   */
  test("a payment to the registered treasury authority is refused", () => {
    const codes2 = codes({
      quoteTerms: { endpointClass: PURCH_ENDPOINT_CLASS_SEARCH, payTo: TREASURY_AUTHORITY, mint: SOL_USDC.address, requestHash: "0xh" },
      settlementRecipient: TREASURY_AUTHORITY,
    });
    assert.ok(codes2.includes("RECIPIENT_IS_OWN_TREASURY"));
  });

  /**
   * Two executions is a question for a human, not a choice for a verifier.
   *
   * Picking the successful one would be choosing which history to believe, on an intent where one
   * authorisation may have paid twice.
   */
  test("more than one execution is refused, and none is refused too", () => {
    const twice = {
      executions: [
        { state: "PAID", settlementTxHash: TX, settlementChain: SOLANA, settledAtomic: 10_000n },
        { state: "PAID", settlementTxHash: `${TX}2`, settlementChain: SOLANA, settledAtomic: 10_000n },
      ],
    };
    assert.ok(codes(twice).includes("MULTIPLE_EXECUTIONS"));
    assert.ok(codes({ executions: [] }).includes("NO_EXECUTION"));
  });

  test("an execution with no settlement transaction is refused", () => {
    assert.ok(
      codes({ executions: [{ state: "PAID", settlementTxHash: null, settlementChain: SOLANA, settledAtomic: 10_000n }] })
        .includes("SETTLEMENT_TX_MISSING"),
    );
  });

  test("an unpaid execution is refused", () => {
    assert.ok(
      codes({ executions: [{ state: "FAILED", settlementTxHash: TX, settlementChain: SOLANA, settledAtomic: 10_000n }] })
        .includes("EXECUTION_NOT_PAID"),
    );
  });

  test("a paid search that returned nothing is refused, because nothing was delivered", () => {
    const empty = paidReadResultHash(QUERY, []);
    assert.ok(codes({ attestedFields: { query: QUERY, count: 0, products: [], resultHash: empty } }).includes("RESULT_EMPTY"));
  });

  test("a result that does not parse as a Purch search is refused", () => {
    assert.ok(
      codes({ attestedFields: { query: QUERY, count: 1, products: [{ title: 42 }], resultHash: "0xa" } })
        .includes("RESULT_SCHEMA_INVALID"),
    );
  });

  test("a count that disagrees with what the result parses to is refused", () => {
    assert.ok(codes({ attestedFields: attested({ count: 9 }) }).includes("RESULT_COUNT_MISMATCH"));
  });

  test("a quote authorised against a different endpoint class is refused", () => {
    assert.ok(
      codes({ quoteTerms: { endpointClass: "purch:/x402/buy", payTo: PAY_TO, mint: SOL_USDC.address, requestHash: "0xh" } })
        .includes("ENDPOINT_CLASS_MISMATCH"),
    );
  });

  test("this verifier refuses a capability, provider or shape that is not its own", () => {
    assert.ok(codes({ providerId: "other" }).includes("PROVIDER_MISMATCH"));
    assert.ok(codes({ capability: "shop.buy" }).includes("CAPABILITY_MISMATCH"));
    assert.ok(codes({ executionShape: "FULFILMENT" }).includes("SHAPE_UNSUPPORTED"));
  });

  /**
   * Every ground is reported at once.
   *
   * An operator deciding whether a receipt can be revised needs the whole picture; one reason at a time
   * would turn that into several round trips through production.
   */
  test("several defects are all reported, not just the first", () => {
    const all = codes({
      settlementChain: "eip155:8453",
      settlementAssetSymbol: "USDT0",
      request: { query: "something else" },
    });
    assert.ok(all.length >= 3, JSON.stringify(all));
    assert.ok(all.includes("CHAIN_NOT_SOLANA") && all.includes("ASSET_MISMATCH") && all.includes("RESULT_NOT_BOUND"));
  });

  test("a refusal never claims verification", () => {
    const v = verifyPersistedPaidRead(input({ request: { query: "other" } }));
    assert.equal(v.verified, false);
    assert.ok(v.detail.startsWith("verification refused"));
  });
});

/**
 * The verifier cannot pay, and this is proven by its import graph rather than by review.
 *
 * A verifier that re-fetched the result would be checking a NEW answer against an OLD payment — which
 * proves nothing about what was bought, and would spend money to prove it. Reviewers do not reliably
 * catch a `fetch` added to a pure module six months from now; a failing test does.
 */
describe("the verifier holds no key and makes no request", () => {
  const source = readFileSync(new URL("../src/adapters/purch-paid-read-verify.ts", import.meta.url), "utf8");

  test("it imports nothing that could reach a network, a signer or a rail", () => {
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(imports)].sort(),
      ["./purch", "@untch/consumer-core"],
      "a new import here is a new way for a pure verifier to reach the world",
    );
  });

  test("it names no fetch, signer, rail or RPC", () => {
    for (const banned of ["fetch(", "undici", "@solana/", "signTransaction", "sendTransaction", "process.env"]) {
      assert.ok(!source.includes(banned), `the verifier must not reference ${banned}`);
    }
  });

  test("the verifier version is recorded, so two versions of the checks stay comparable", () => {
    assert.match(PAID_READ_VERIFIER_VERSION, /^purch-paid-read\/\d+\.\d+\.\d+$/);
  });
});

/** A guard against a fixture that quietly stops representing real money. */
describe("the fixture describes the settlement that actually happened", () => {
  test("the quote, reservation and settlement are the figures from the bounded proof", () => {
    const i = input();
    assert.equal(i.quoteCost.amount, 10_000n, "0.010000 USDC");
    assert.equal(i.reservedAtomic, 10_050n);
    const settled: Money = money(i.executions[0]?.settledAtomic ?? 0n, SOL_USDC);
    assert.equal(settled.amount, 10_000n);
  });
});
