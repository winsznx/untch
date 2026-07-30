import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryConsumerStore,
  ProviderRegistry,
  StorePauseChecker,
  TreasuryRouter,
  asset,
  isProviderError,
  money,
  parseMoney,
  sha256Hex,
  stableStringify,
  type ConsumerIntentState,
  type ConsumerQuote,
  type ConsumerStore,
  type ProviderExecutionRecord,
} from "@untch/consumer-core";
import { PROVIDER_SEEDS, PURCH_ENDPOINT_CLASS_SEARCH } from "@untch/consumer-providers";
import type { AdapterRegistry } from "@untch/consumer-providers";
import { ConsumerOrchestrator } from "../src/consumer/orchestrator";
import type { PolicyProvider } from "@untch/policy-store";
import type { Ledger } from "@untch/policy-engine";

/**
 * Re-verifying a paid read from evidence production already holds.
 *
 * Intent `ci_e58174e549f6a21c591eacfa` settled 0.010000 USDC on Solana mainnet, returned five real
 * products, and completed with `untchVerified: false, method: NONE`. That was true when it was written:
 * the delivery check had been built for a physical shipment, where Untch can prove an order was PLACED
 * and cannot prove a parcel arrived.
 *
 * The redrive corrects that WITHOUT another payment. Every fake below throws on contact, so "the redrive
 * never reaches a provider, a signer or a rail" is proven by the absence of an exception rather than
 * asserted in a comment — which is the only form of that claim worth having when the alternative costs
 * real money on Solana mainnet.
 */

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_USDC = asset("solana.usdc");
const PAY_TO = "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2";
const TREASURY = "FSW47vP9xHqPZbBqA1Vtn6HDMPQvXPvXvHqZoR2mGz3k";
const TX = "63cbzAEuDkMFs41TwuGKjYC3YWz3e8FeYbQVfrt2WGmvWotdUMmiJCf3yzyd8EypPDikfQjWAxWGUa5rDTJLrhVK";
const INTENT_ID = "ci_e58174e549f6a21c591eacfa";
const QUERY = "usb-c cable";
const NOW = Date.parse("2026-07-30T18:00:00.000Z");

const PRODUCTS = [
  { asin: "B0AAA00001", title: "USB-C cable, 2 m", price: "9.99", currency: "USD", source: "amazon", productUrl: "https://example.com/a", imageUrl: "https://example.com/a.jpg" },
] as const;

/**
 * Every collaborator a PAYMENT would need, rigged to throw on any access.
 *
 * A counter would let a regression pass silently until someone read it; a throw makes the failure
 * immediate. These stand in for the adapter registry, the treasury and the rail map.
 */
const explode = <T,>(what: string): T =>
  new Proxy({} as object, {
    get(_t, prop) {
      throw new Error(`THE REDRIVE REACHED ${what} via ${String(prop)}`);
    },
    apply() {
      throw new Error(`THE REDRIVE CALLED ${what}`);
    },
  }) as T;

/** The result hash the adapter wrote at execution time, computed the way the adapter computes it. */
function resultHashFor(products: readonly Record<string, unknown>[]): string {
  const parsed = products.map((p) => ({
    asin: p.asin ?? null,
    title: p.title,
    price: p.price ?? null,
    currency: p.currency ?? null,
    source: p.source ?? null,
    url: p.productUrl ?? p.url ?? null,
    imageUrl: p.imageUrl ?? null,
  }));
  return `0x${sha256Hex(stableStringify({ query: QUERY, products: parsed } as unknown as Record<string, unknown>))}`;
}

const ATTESTED = {
  query: QUERY,
  count: PRODUCTS.length,
  products: PRODUCTS,
  resultHash: resultHashFor([...PRODUCTS]),
};

interface SeedOptions {
  readonly executionShape?: "PAID_READ" | "FULFILMENT";
  readonly attested?: Record<string, unknown>;
  readonly executions?: number;
  readonly stopAt?: ConsumerIntentState;
  readonly settledAtomic?: bigint;
}

/**
 * A store carrying the completed intent, driven through the REAL state machine.
 *
 * Every edge is a legal one. Writing `state: "COMPLETED"` into a row directly would let a redrive test
 * pass over a history the lifecycle could never produce, and the redrive's whole contract is that it
 * describes something that actually happened.
 */
async function seed(opts: SeedOptions = {}): Promise<ConsumerStore> {
  const store = new InMemoryConsumerStore(() => NOW);
  const shape = opts.executionShape ?? "PAID_READ";

  for (const s of PROVIDER_SEEDS) {
    await store.upsertProvider({ ...s.provider, maturity: "verified" });
    for (const cap of s.capabilities) {
      await store.upsertCapability({
        ...cap,
        maturity: "verified",
        ...(cap.capability === "shop.search" ? { executionShape: shape } : {}),
      });
    }
  }

  await store.upsertTreasuryAccount({
    treasuryRef: "solana-usdc-settlement",
    asset: SOL_USDC,
    purpose: "SETTLEMENT",
    address: TREASURY,
    minBalance: parseMoney("0.00", SOL_USDC),
    dailyLimit: parseMoney("0.00", SOL_USDC),
    enabled: true,
  });

  const quote: ConsumerQuote = {
    quoteId: "cq_redrive0001",
    intentId: INTENT_ID,
    providerId: "purch",
    providerRef: QUERY,
    providerCost: money(10_000n, SOL_USDC),
    untchFee: money(0n, SOL_USDC),
    spread: money(0n, SOL_USDC),
    totalUserAmount: money(10_000n, SOL_USDC),
    maxAuthorisedAmount: money(10_050n, SOL_USDC),
    settlementRecipient: PAY_TO,
    settlementAsset: SOL_USDC,
    summary: `Paid search: ${QUERY}`,
    terms: { endpointClass: PURCH_ENDPOINT_CLASS_SEARCH, payTo: PAY_TO, mint: SOL_USDC.address, requestHash: "0xreq" },
    quoteHash: `0x${"9".repeat(64)}`,
    expiresAt: new Date(NOW + 600_000).toISOString(),
    createdAt: new Date(NOW).toISOString(),
  } as unknown as ConsumerQuote;

  await store.createIntent(
    {
      intentId: INTENT_ID,
      tenantId: "policy:12",
      requestingAgentId: "agent-1",
      principalId: "principal-1",
      action: "shop.search",
      category: "shop",
      request: { query: QUERY },
      policyId: "12",
      correlationId: "corr-1",
      idempotencyKey: "idem-1",
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    },
    { name: "consumer.intent.created", data: {} },
  );
  await store.insertQuote(quote);

  const path: readonly ConsumerIntentState[] = [
    "QUOTED", "POLICY_CHECKING", "APPROVED", "AWAITING_FUNDING", "FUNDED",
    "EXECUTION_QUEUED", "PROVIDER_PAYMENT_PENDING", "PROVIDER_PAID",
    "PROVIDER_ACKNOWLEDGED", "DELIVERY_VERIFIED", "COMPLETED",
  ];
  const stopAt = opts.stopAt ?? "COMPLETED";
  let from: ConsumerIntentState = "CREATED";
  for (const to of path) {
    await store.transition(
      INTENT_ID, from, to,
      from === "CREATED"
        ? { providerId: "purch", quoteId: quote.quoteId, quoteHash: quote.quoteHash }
        : {},
      { name: `consumer.intent.${to.toLowerCase()}`, data: {} },
    );
    from = to;
    if (to === stopAt) break;
  }

  for (let i = 0; i < (opts.executions ?? 1); i += 1) {
    const record: ProviderExecutionRecord = {
      executionId: `ex_redrive_${i}`,
      intentId: INTENT_ID,
      providerId: "purch",
      idempotencyKey: `exec-${i}`,
      attemptNo: i + 1,
      state: "PAID",
      providerReference: `search-${INTENT_ID}`,
      settlementTxHash: `${TX}${i === 0 ? "" : String(i)}`,
      settlementChain: SOLANA,
      settledAmount: money(opts.settledAtomic ?? 10_000n, SOL_USDC),
      error: null,
      startedAt: new Date(NOW).toISOString(),
      finishedAt: new Date(NOW).toISOString(),
    } as unknown as ProviderExecutionRecord;
    await store.prepareExecution(record);
    await store.updateExecution(record.executionId, {
      state: "PAID",
      settlementTxHash: record.settlementTxHash,
      settlementChain: SOLANA,
      settledAmount: record.settledAmount,
    });
  }

  await store.upsertDeliveryEvidence({
    intentId: INTENT_ID,
    providerId: "purch",
    providerAttested: {
      status: "fulfilled",
      reference: `search-${INTENT_ID}`,
      fields: opts.attested ?? ATTESTED,
      attestedAt: new Date(NOW).toISOString(),
    },
    /**
     * Exactly what the first bounded proof recorded.
     *
     * The redrive is only interesting against this starting point: an honest `false` that a shape-aware
     * check can now turn into an honest `true`.
     */
    untchVerified: { verified: false, method: "NONE", detail: "no shape-aware check existed at settlement", verifiedAt: null },
    evidenceHash: `0x${sha256Hex(stableStringify({ intentId: INTENT_ID, attested: ATTESTED } as unknown as Record<string, unknown>))}`,
  });

  return store;
}

function orchestratorOver(store: ConsumerStore): ConsumerOrchestrator {
  return new ConsumerOrchestrator({
    store,
    registry: new ProviderRegistry({
      store,
      gate: { executionFloor: "verified", allowSandboxExecution: false },
      flags: explode("THE PROVIDER FLAGS"),
      clock: () => NOW,
    }),
    // The three things a payment needs. Any contact throws.
    adapters: explode<AdapterRegistry>("THE ADAPTER REGISTRY"),
    treasury: new TreasuryRouter({
      store,
      rails: explode<Map<never, never>>("THE RAIL MAP"),
      pauses: new StorePauseChecker(store),
      clock: () => NOW,
    }),
    policyProvider: explode<PolicyProvider>("THE POLICY PROVIDER"),
    ledger: explode<Ledger>("THE LEDGER"),
    escalation: null,
    receipts: explode("THE RECEIPT SINK"),
    config: {
      allowSandboxExecution: false,
      maxSingleExecutionDisplay: "50.00",
      quoteTtlSec: 600,
      fundingTtlSec: 1800,
      providerTimeoutMs: 2000,
      executeTimeoutMs: 5000,
      breakerThreshold: 5,
      breakerCooldownMs: 60000,
    },
    publicBaseUrl: "https://asp.untch.xyz",
    siwx: null,
    clock: () => NOW,
  });
}

const codeOf = (err: unknown): string => (isProviderError(err) ? err.normalized.code : `NOT_A_PROVIDER_ERROR:${String(err)}`);

describe("the redrive verifies a completed paid read without spending anything", () => {
  test("it verifies, and reaches no adapter, treasury rail, policy provider or ledger", async () => {
    // #given the completed intent exactly as production holds it
    const store = await seed();
    // #when it is re-verified
    const { record, alreadyRecorded } = await orchestratorOver(store).redriveDeliveryVerification(INTENT_ID);
    // #then the binding is established — and no exploding collaborator was ever touched
    assert.equal(record.verified, true, JSON.stringify(record.refusals));
    assert.equal(record.method, "PAID_READ_RESULT_BINDING");
    assert.equal(alreadyRecorded, false);
    assert.equal(record.settlementTx, TX);
    assert.equal(record.settledAmount, "10000");
  });

  test("the delivery projection moves from NONE to the shape-aware method", async () => {
    const store = await seed();
    const before = await store.getDeliveryEvidence(INTENT_ID);
    assert.equal(before?.untchVerified.verified, false);
    assert.equal(before?.untchVerified.method, "NONE");

    await orchestratorOver(store).redriveDeliveryVerification(INTENT_ID);

    const after = await store.getDeliveryEvidence(INTENT_ID);
    assert.equal(after?.untchVerified.verified, true);
    assert.equal(after?.untchVerified.method, "PAID_READ_RESULT_BINDING");
    assert.ok(after?.untchVerified.verifiedAt !== null, "the later claim carries its own timestamp");
  });

  /**
   * The merchant's attestation is not rewritten.
   *
   * `providerAttested` is what Purch said at execution time. Only Untch's own claim moves, which is the
   * same reason the two were never merged into one field in the first place.
   */
  test("the provider's attestation is left exactly as it was recorded", async () => {
    const store = await seed();
    const before = await store.getDeliveryEvidence(INTENT_ID);
    await orchestratorOver(store).redriveDeliveryVerification(INTENT_ID);
    const after = await store.getDeliveryEvidence(INTENT_ID);
    assert.deepEqual(after?.providerAttested, before?.providerAttested);
  });

  test("no execution is added, and no settlement is recorded", async () => {
    const store = await seed();
    const before = await store.listExecutions(INTENT_ID);
    await orchestratorOver(store).redriveDeliveryVerification(INTENT_ID);
    const after = await store.listExecutions(INTENT_ID);
    assert.deepEqual(after, before, "a verification must not touch the execution history");
  });

  /**
   * The one-shot proof gate is not touched.
   *
   * The gate is the authority that let ONE payment happen, and it is consumed by claiming it. A redrive
   * that claimed it would burn a spending authorisation to answer a question about a payment that had
   * already been made — and would leave the gate looking used by something that never paid.
   */
  test("an armed proof gate is left in exactly the state it was in", async () => {
    const store = await seed();
    const scope = {
      intentId: INTENT_ID,
      providerId: "purch",
      capability: "shop.search",
      chain: SOLANA,
      asset: SOL_USDC,
      maxAmount: money(20_000n, SOL_USDC),
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    } as const;
    const armed = await store.armSolanaProofGate(scope, new Date(NOW).toISOString());

    await orchestratorOver(store).redriveDeliveryVerification(INTENT_ID);

    const after = await store.getSolanaProofGate(armed.scopeHash);
    assert.equal(after?.state, armed.state, "the gate must not be claimed by a verification");
    assert.deepEqual(after, armed, "no field of the gate may move");
  });

  test("no ledger group is written, so the book does not move", async () => {
    const store = await seed();
    await orchestratorOver(store).redriveDeliveryVerification(INTENT_ID);
    assert.deepEqual(await store.ledgerGroupsForIntent(INTENT_ID), []);
  });

  test("the intent stays COMPLETED and its timestamps do not move", async () => {
    const store = await seed();
    const before = await store.getIntent(INTENT_ID);
    await orchestratorOver(store).redriveDeliveryVerification(INTENT_ID);
    const after = await store.getIntent(INTENT_ID);
    assert.equal(after?.state, "COMPLETED");
    assert.equal(after?.createdAt, before?.createdAt);
    assert.equal(after?.receiptId, before?.receiptId, "the original receipt id is retained");
  });
});

describe("a redrive is idempotent, and a repeat is visible as a repeat", () => {
  test("running it twice records ONE verification and says the second was already there", async () => {
    // #given a redrive that has already run
    const store = await seed();
    const orch = orchestratorOver(store);
    const first = await orch.redriveDeliveryVerification(INTENT_ID);
    // #when it runs again over identical evidence
    const second = await orch.redriveDeliveryVerification(INTENT_ID);
    // #then the same row comes back, and the caller is told so rather than left to guess
    assert.equal(second.alreadyRecorded, true);
    assert.equal(second.record.verificationId, first.record.verificationId);
    assert.equal((await store.listDeliveryVerifications(INTENT_ID)).length, 1);
  });

  test("identical evidence always produces the same digest, which is what makes it idempotent", async () => {
    const a = await orchestratorOver(await seed()).redriveDeliveryVerification(INTENT_ID);
    const b = await orchestratorOver(await seed()).redriveDeliveryVerification(INTENT_ID);
    assert.equal(a.record.evidenceDigest, b.record.evidenceDigest);
  });

  test("the record is keyed so a NEW verifier version would not overwrite an old verdict", async () => {
    const store = await seed();
    const { record } = await orchestratorOver(store).redriveDeliveryVerification(INTENT_ID);
    // A later version reading the same evidence writes a second row rather than replacing this one,
    // which is precisely how a disagreement between two versions stays visible.
    await store.recordDeliveryVerification({ ...record, verifierVersion: "purch-paid-read/2.0.0", verificationId: "dv_v2" });
    const all = await store.listDeliveryVerifications(INTENT_ID);
    assert.equal(all.length, 2);
    assert.ok(all.some((r) => r.verifierVersion === "purch-paid-read/1.0.0"));
  });
});

describe("the redrive refuses what it cannot honestly describe", () => {
  test("an intent still in flight is refused, because its evidence is still moving", async () => {
    const store = await seed({ stopAt: "PROVIDER_PAID" });
    await assert.rejects(
      () => orchestratorOver(store).redriveDeliveryVerification(INTENT_ID),
      (err: unknown) => codeOf(err) === "PROVIDER_BAD_REQUEST",
    );
  });

  test("an unknown intent is refused", async () => {
    const orch = orchestratorOver(await seed());
    await assert.rejects(
      () => orch.redriveDeliveryVerification("ci_000000000000000000000000"),
      (err: unknown) => typeof codeOf(err) === "string",
    );
  });

  /**
   * A physical purchase is untouched.
   *
   * Its delivery claim is still "the order was PLACED", because the carrier is reachable only through
   * Purch's paid tracking endpoint. Extending the redrive to it would mean claiming a parcel arrived on
   * the strength of an order confirmation.
   */
  test("a FULFILMENT intent has no redrive and says so plainly", async () => {
    const store = await seed({ executionShape: "FULFILMENT" });
    await assert.rejects(
      () => orchestratorOver(store).redriveDeliveryVerification(INTENT_ID),
      (err: unknown) => codeOf(err) === "PROTOCOL_NOT_EXECUTABLE",
    );
  });

  test("a second execution on one intent is recorded as a refusal, not silently resolved", async () => {
    const store = await seed({ executions: 2 });
    const { record } = await orchestratorOver(store).redriveDeliveryVerification(INTENT_ID);
    assert.equal(record.verified, false);
    assert.ok(record.refusals.some((r) => r.code === "MULTIPLE_EXECUTIONS"));
  });

  test("a result answering a different query is refused, and the projection stays false", async () => {
    const store = await seed({
      attested: { query: "espresso machine", count: 1, products: PRODUCTS, resultHash: ATTESTED.resultHash },
    });
    const { record } = await orchestratorOver(store).redriveDeliveryVerification(INTENT_ID);
    assert.equal(record.verified, false);
    assert.ok(record.refusals.some((r) => r.code === "RESULT_NOT_BOUND"));

    // The honest `false` is preserved rather than upgraded on a failed check.
    const evidence = await store.getDeliveryEvidence(INTENT_ID);
    assert.equal(evidence?.untchVerified.verified, false);
    assert.equal(evidence?.untchVerified.method, "NONE");
  });

  test("a settlement above the authorised quote is refused", async () => {
    const store = await seed({ settledAtomic: 50_000n });
    const { record } = await orchestratorOver(store).redriveDeliveryVerification(INTENT_ID);
    assert.equal(record.verified, false);
    assert.ok(record.refusals.some((r) => r.code === "ABOVE_AUTHORISED_QUOTE"));
  });

  test("a refusal is still RECORDED, so a failed check is not indistinguishable from no check", async () => {
    const store = await seed({ settledAtomic: 50_000n });
    await orchestratorOver(store).redriveDeliveryVerification(INTENT_ID);
    const latest = await store.latestDeliveryVerification(INTENT_ID);
    assert.equal(latest?.verified, false);
    assert.ok((latest?.refusals.length ?? 0) > 0);
  });
});

/**
 * The redrive path holds no key, and this is proven by reading the modules rather than by review.
 *
 * The orchestrator itself legitimately reaches rails elsewhere. What must never happen is a redrive
 * that pays, so the check is on the VERIFIER's closure — the part the redrive delegates the whole
 * judgement to.
 */
describe("the verifier module reachable from the redrive cannot pay", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const verifier = readFileSync(
    join(here, "..", "..", "..", "packages", "consumer-providers", "src", "adapters", "purch-paid-read-verify.ts"),
    "utf8",
  );

  test("it names no fetch, signer, rail, RPC or environment read", () => {
    for (const banned of ["fetch(", "undici", "@solana/", "signTransaction", "sendTransaction", "process.env", "RailClient"]) {
      assert.ok(!verifier.includes(banned), `the verifier must not reference ${banned}`);
    }
  });
});
