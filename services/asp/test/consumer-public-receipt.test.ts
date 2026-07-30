import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { asset, moneyToJson, parseMoney } from "@untch/consumer-core";
import type {
  ConsumerIntent,
  ConsumerStore,
  DeliveryEvidence,
  DeliveryVerificationRecord,
  Money,
  ProviderExecutionRecord,
} from "@untch/consumer-core";
import {
  handleConsumerReceipt,
  handlePublicConsumerReceipt,
  type ConsumerDeps,
  type ReceiptStatusLike,
} from "../src/consumer/handlers";
import type { ConsumerOrchestrator } from "../src/consumer/orchestrator";

/**
 * The public receipt is the one URL a user shares, so the thing worth testing is not that it renders
 * — it is what it REFUSES to render. The private receipt carries the request payload, the correlation
 * id and which operator channel resolved an approval; publishing any of those would leak the exact
 * domain someone searched or the address a gift shipped to, to anyone holding the link.
 */

const USDT0 = asset("xlayer.usdt0");
const USDC = asset("base.usdc");
const NOW_ISO = "2026-07-27T12:00:00.000Z";
const INTENT_ID = "ci_publicreceipttest01";

/** A request payload containing exactly the sort of thing that must never reach a public page. */
const PRIVATE_REQUEST = { domain: "the-users-secret-startup-idea.com", shipTo: "12 Private Road" };

/**
 * A stub store, not the in-memory one.
 *
 * The subject here is FIELD SELECTION — which parts of a completed intent may be published. Driving
 * the real state machine to COMPLETED would add twenty steps of setup that the e2e suite already
 * covers, and none of them would make the disclosure assertions any stronger. What matters is that
 * the intent handed to the handler carries private data, so the handler has something to leak.
 */
function stubStore(
  over: {
    receiptId?: string | null;
    executions?: readonly ProviderExecutionRecord[];
    verification?: DeliveryVerificationRecord | null;
    /**
     * The delivery projection, which a redrive MUTATES.
     *
     * Previously this stub always returned null, so `delivery` was null before and after and the
     * settlement-digest test passed over a receipt that had no delivery block at all. Production then
     * moved the digest on the very first redrive. A fixture that cannot express the change it is
     * guarding against does not guard against anything.
     */
    evidence?: DeliveryEvidence | null;
  } = {},
): ConsumerStore {
  const intent = {
    intentId: INTENT_ID,
    tenantId: "tenant-a",
    requestingAgentId: "agent-1",
    principalId: "principal-1",
    action: "domains.check",
    category: "domains",
    providerId: "stabledomains",
    request: PRIVATE_REQUEST,
    policyId: "9001",
    policyVersion: 1,
    policyHash: `0x${"a".repeat(64)}`,
    policyDecision: { decision: "ALLOW" },
    quoteId: null,
    quoteHash: `0x${"b".repeat(64)}`,
    spendIntentHash: `0x${"c".repeat(64)}`,
    untchFee: parseMoney("0.30", USDT0),
    spread: parseMoney("0.10", USDT0),
    state: "COMPLETED",
    receiptId: over.receiptId === undefined ? null : over.receiptId,
    correlationId: "corr-secret-abc123",
    approvalRequired: false,
    approvalOutcome: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  } as unknown as ConsumerIntent;

  let fee = intent.untchFee;
  return {
    async getIntent(id: string) {
      return id === INTENT_ID ? ({ ...intent, untchFee: fee } as ConsumerIntent) : null;
    },
    // The handler derives the tenant from the policy id — `policy:<id>` — so a caller cannot claim
    // another tenant's scope with a header. The stub honours that same derivation.
    async getIntentForTenant(tenantId: string, id: string) {
      return tenantId === "policy:9001" && id === INTENT_ID ? ({ ...intent, untchFee: fee } as ConsumerIntent) : null;
    },
    async listExecutions() {
      return over.executions ?? [];
    },
    async getDeliveryEvidence() {
      return over.evidence ?? null;
    },
    async latestDeliveryVerification() {
      return over.verification ?? null;
    },
    async getQuote() {
      return null;
    },
    async getFunding() {
      return null;
    },
    async getApproval() {
      return null;
    },
    async ledgerGroupsForIntent() {
      return [];
    },
    /** Only used to prove the integrity digest moves when a published field moves. */
    setFee(next: Money) {
      fee = next;
    },
  } as unknown as ConsumerStore & { setFee(next: Money): void };
}

function depsFor(store: ConsumerStore): ConsumerDeps {
  return {
    store,
    orchestrator: null as unknown as ConsumerOrchestrator,
    publicBaseUrl: "https://asp.untch.xyz",
  };
}

const seed = async (
  over: {
    receiptId?: string | null;
    verification?: DeliveryVerificationRecord | null;
    evidence?: DeliveryEvidence | null;
  } = {},
): Promise<ConsumerDeps> => depsFor(stubStore(over));

/** The delivery projection as settlement wrote it: the merchant spoke, Untch had not yet checked. */
const EVIDENCE_UNVERIFIED: DeliveryEvidence = {
  intentId: INTENT_ID,
  providerId: "purch",
  providerAttested: { status: "fulfilled", reference: "search-1", fields: {}, attestedAt: NOW_ISO },
  untchVerified: { verified: false, method: "NONE", detail: "no shape-aware check existed", verifiedAt: null },
  evidenceHash: `0x${"7".repeat(64)}`,
};

/** The same evidence AFTER a redrive moved Untch's own claim. Only `untchVerified` differs. */
const EVIDENCE_VERIFIED: DeliveryEvidence = {
  ...EVIDENCE_UNVERIFIED,
  untchVerified: {
    verified: true,
    method: "PAID_READ_RESULT_BINDING",
    detail: "verified after settlement",
    verifiedAt: "2026-07-28T09:00:00.000Z",
  },
};

/**
 * A verification established AFTER the receipt was written.
 *
 * Dated a day later on purpose: the whole question these tests answer is whether a reader can still
 * tell what was known when the money moved from what was established afterwards.
 */
const LATER_VERIFICATION: DeliveryVerificationRecord = {
  verificationId: "dv_00112233445566778899",
  intentId: INTENT_ID,
  verifierVersion: "purch-paid-read/1.0.0",
  evidenceDigest: `0x${"f".repeat(64)}`,
  providerId: "purch",
  capability: "shop.search",
  executionShape: "PAID_READ",
  method: "PAID_READ_RESULT_BINDING",
  verified: true,
  detail: "the paid search returned 5 schema-valid products bound to the authorised request",
  requestHash: `0x${"1".repeat(64)}`,
  resultHash: `0x${"2".repeat(64)}`,
  quoteHash: `0x${"b".repeat(64)}`,
  settlementTx: "63cbzAEuDkMFs41TwuGKjYC3YWz3e8FeYbQVfrt2WGmvWotdUMmiJCf3yzyd8EypPDikfQjWAxWGUa5rDTJLrhVK",
  settledAmount: "10000",
  settlementChain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  originalReceiptId: null,
  supersedingReceiptId: null,
  refusals: [],
  verifiedAt: "2026-07-28T09:00:00.000Z",
};

const statusReader =
  (view: ReceiptStatusLike | null | "invalid") =>
  async (): Promise<ReceiptStatusLike | null | "invalid"> =>
    view;

describe("public receipt — what it withholds", () => {
  test("the request payload never appears anywhere in the response", async () => {
    // #given an intent whose request carries the user's private details
    const deps = await seed();

    // #when the public receipt is rendered
    const r = await handlePublicConsumerReceipt(INTENT_ID, deps, null);

    // #then nothing from the request survives into the serialised body
    assert.equal(r.status, 200);
    const serialised = JSON.stringify(r.body);
    assert.equal(serialised.includes("the-users-secret-startup-idea.com"), false);
    assert.equal(serialised.includes("12 Private Road"), false);
    assert.equal(serialised.includes("shipTo"), false);
  });

  test("the correlation id is withheld", async () => {
    const deps = await seed();
    const r = await handlePublicConsumerReceipt(INTENT_ID, deps, null);
    assert.equal(JSON.stringify(r.body).includes("corr-secret-abc123"), false);
  });

  test("the private receipt DOES carry them — the two views are genuinely different", async () => {
    // If this ever passes trivially the withholding test above proves nothing.
    const deps = await seed();
    const priv = await handleConsumerReceipt(INTENT_ID, "9001", deps);
    assert.equal(priv.status, 200);
    assert.equal(JSON.stringify(priv.body).includes("corr-secret-abc123"), true);
  });

  test("the public route needs no tenant scope, while the private route refuses without one", async () => {
    const deps = await seed();
    const pub = await handlePublicConsumerReceipt(INTENT_ID, deps, null);
    assert.equal(pub.status, 200);
    const priv = await handleConsumerReceipt(INTENT_ID, null, deps);
    assert.notEqual(priv.status, 200, "an unscoped private read must not succeed");
  });

  test("an unknown intent is 404, not an empty receipt", async () => {
    const deps = await seed();
    const r = await handlePublicConsumerReceipt("ci_doesnotexist", deps, null);
    assert.equal(r.status, 404);
    assert.equal((r.body as { code: string }).code, "INTENT_NOT_FOUND");
  });

  test("it publishes what it should: amounts, policy, decision, hashes", async () => {
    const deps = await seed();
    const body = (await handlePublicConsumerReceipt(INTENT_ID, deps, null)).body as Record<string, unknown>;
    assert.equal(body.intentId, INTENT_ID);
    assert.equal(body.action, "domains.check");
    assert.deepEqual(body.fee, moneyToJson(parseMoney("0.30", USDT0)));
    assert.deepEqual(body.spread, moneyToJson(parseMoney("0.10", USDT0)));
    assert.deepEqual(body.policy, {
      policyId: "9001",
      policyVersion: 1,
      policyHash: `0x${"a".repeat(64)}`,
      decision: "ALLOW",
    });
    assert.ok(typeof (body.integrity as { digest: string }).digest === "string");
  });
});

describe("public receipt — the five anchor states are distinguishable", () => {
  const receiptId = `0x${"d".repeat(64)}`;

  test("NOT_RECORDED when no receipt id exists, and it says why", async () => {
    const deps = await seed({ receiptId: null });
    const body = (await handlePublicConsumerReceipt(INTENT_ID, deps, null)).body as {
      receipt: { state: string; reason?: string };
    };
    assert.equal(body.receipt.state, "NOT_RECORDED");
    assert.ok((body.receipt.reason ?? "").length > 0, "a bare null is what this replaces");
  });

  test("PENDING while the receipt is durable but not yet batched", async () => {
    const deps = await seed({ receiptId });
    const body = (await handlePublicConsumerReceipt(
      INTENT_ID,
      deps,
      statusReader({ status: "QUEUED", txHash: null, blockNumber: null, batchId: null }),
    )).body as { receipt: { state: string; status?: string } };
    assert.equal(body.receipt.state, "PENDING");
    assert.equal(body.receipt.status, "QUEUED");
  });

  test("ANCHORED carries the transaction to check it against", async () => {
    const deps = await seed({ receiptId });
    const body = (await handlePublicConsumerReceipt(
      INTENT_ID,
      deps,
      statusReader({ status: "CONFIRMED", txHash: `0x${"e".repeat(64)}`, blockNumber: 123, batchId: 7 }),
    )).body as { receipt: { state: string; txHash?: string; blockNumber?: number } };
    assert.equal(body.receipt.state, "ANCHORED");
    assert.equal(body.receipt.txHash, `0x${"e".repeat(64)}`);
    assert.equal(body.receipt.blockNumber, 123);
  });

  test("ANCHOR_FAILED is distinct from PENDING — one is still working, the other gave up", async () => {
    const deps = await seed({ receiptId });
    const body = (await handlePublicConsumerReceipt(
      INTENT_ID,
      deps,
      statusReader({ status: "DEGRADED_UNANCHORED", txHash: null, blockNumber: null, batchId: null }),
    )).body as { receipt: { state: string } };
    assert.equal(body.receipt.state, "ANCHOR_FAILED");
  });

  test("NOT_FOUND when the intent names a receipt that does not exist", async () => {
    const deps = await seed({ receiptId });
    const body = (await handlePublicConsumerReceipt(INTENT_ID, deps, statusReader(null))).body as {
      receipt: { state: string };
    };
    assert.equal(body.receipt.state, "NOT_FOUND");
  });

  test("no receipt-status reader at all degrades to NOT_FOUND, never to a fake PENDING", async () => {
    // A deployment without a receipt writer must not imply an anchor that will never arrive.
    const deps = await seed({ receiptId });
    const body = (await handlePublicConsumerReceipt(INTENT_ID, deps, null)).body as {
      receipt: { state: string };
    };
    assert.equal(body.receipt.state, "NOT_FOUND");
  });
});

describe("public receipt — the integrity digest", () => {
  test("it is stable across identical reads", async () => {
    const deps = await seed({ receiptId: null });
    const a = (await handlePublicConsumerReceipt(INTENT_ID, deps, null)).body as { integrity: { digest: string } };
    const b = (await handlePublicConsumerReceipt(INTENT_ID, deps, null)).body as { integrity: { digest: string } };
    assert.equal(a.integrity.digest, b.integrity.digest);
  });

  test("it changes when a published field changes", async () => {
    const deps = await seed({ receiptId: null });
    const before = (await handlePublicConsumerReceipt(INTENT_ID, deps, null)).body as {
      integrity: { digest: string };
    };
    (deps.store as unknown as { setFee(m: Money): void }).setFee(parseMoney("0.31", USDT0));
    const after = (await handlePublicConsumerReceipt(INTENT_ID, deps, null)).body as {
      integrity: { digest: string };
    };
    assert.notEqual(after.integrity.digest, before.integrity.digest);
  });

  test("the anchor state is OUTSIDE the digest — anchoring later must not invalidate it", async () => {
    // The digest commits to what the receipt ASSERTS. Anchor progress is metadata about publication,
    // and folding it in would mean every holder's copy stopped matching the moment a batch landed.
    const deps = await seed({ receiptId: `0x${"d".repeat(64)}` });
    const pending = (await handlePublicConsumerReceipt(
      INTENT_ID,
      deps,
      statusReader({ status: "QUEUED", txHash: null, blockNumber: null, batchId: null }),
    )).body as { integrity: { digest: string } };
    const anchored = (await handlePublicConsumerReceipt(
      INTENT_ID,
      deps,
      statusReader({ status: "CONFIRMED", txHash: `0x${"e".repeat(64)}`, blockNumber: 9, batchId: 1 }),
    )).body as { integrity: { digest: string } };
    assert.equal(anchored.integrity.digest, pending.integrity.digest);
  });
});

/**
 * A verification that lands after settlement is an ADDENDUM, never a rewrite.
 *
 * The first bounded Purch proof settled real money and completed with `untchVerified: false,
 * method: NONE`, because the delivery check had been written for a physical shipment and was not yet
 * shape-aware. Verifying it days later must not make the receipt read as though the check had always
 * been there. A reader who cannot separate the two can no longer tell a legitimate correction from a
 * quietly edited history, and on a receipt that is the only distinction that matters.
 */
describe("public receipt — a later verification is appended, never merged", () => {
  test("with no verification the receipt is revision 1 and says it is the original", async () => {
    // #given a receipt nobody has re-verified
    const deps = await seed();
    // #when it is rendered
    const body = (await handlePublicConsumerReceipt(INTENT_ID, deps, null)).body as {
      revision: { number: number; supersedes: number | null; reason: string | null; revisedAt: string | null };
      verification: unknown;
    };
    // #then it reads as an absence, not as a failure
    assert.equal(body.revision.number, 1);
    assert.equal(body.revision.supersedes, null);
    assert.equal(body.revision.reason, null);
    assert.equal(body.revision.revisedAt, null);
    assert.equal(body.verification, null);
  });

  test("a verification appears as revision 2, dated when it happened and not when settlement did", async () => {
    const deps = await seed({ verification: LATER_VERIFICATION });
    const body = (await handlePublicConsumerReceipt(INTENT_ID, deps, null)).body as {
      revision: { number: number; supersedes: number | null; reason: string; originalRecordedAt: string; revisedAt: string };
      verification: { verifiedAt: string; relationship: string; verified: boolean; method: string };
      createdAt: string;
    };
    assert.equal(body.revision.number, 2);
    assert.equal(body.revision.supersedes, 1);
    assert.equal(body.revision.reason, "DELIVERY_VERIFIED_AFTER_SETTLEMENT");
    // The two dates are different, and the receipt shows both rather than picking one.
    assert.equal(body.revision.originalRecordedAt, NOW_ISO);
    assert.equal(body.revision.revisedAt, "2026-07-28T09:00:00.000Z");
    assert.equal(body.verification.verifiedAt, "2026-07-28T09:00:00.000Z");
    assert.equal(body.verification.relationship, "SUBSEQUENT_TO_SETTLEMENT");
  });

  test("the original settlement fields and timestamps are untouched by the addendum", async () => {
    // #given the same intent, rendered before and after a verification exists
    const before = (await handlePublicConsumerReceipt(INTENT_ID, await seed(), null)).body as Record<string, unknown>;
    const after = (await handlePublicConsumerReceipt(
      INTENT_ID,
      await seed({ verification: LATER_VERIFICATION }),
      null,
    )).body as Record<string, unknown>;

    // #then every settlement-time field is byte-identical
    for (const field of ["intentId", "action", "state", "settlement", "fee", "spread", "policy", "quoteHash", "spendIntentHash", "createdAt", "updatedAt"]) {
      assert.deepEqual(after[field], before[field], `${field} must not move when a verification is appended`);
    }
  });

  /**
   * The settlement digest is the load-bearing half.
   *
   * A holder who recorded it before any verification existed can still prove that part was never
   * rewritten. If the only digest moved, they would be unable to tell a legitimate addendum from a
   * rewritten history.
   */
  test("the settlement digest is unchanged by a verification, and the full digest moves", async () => {
    /**
     * Both sides carry a REAL delivery projection, and the projection differs between them.
     *
     * The earlier version of this test seeded no evidence at all, so `delivery` was null on both sides
     * and the assertion held over a receipt with nothing to move. Production moved the settlement digest
     * on the first redrive it ever ran. The fixture now expresses the exact change being guarded
     * against, which is the only reason the assertion means anything.
     */
    const before = (await handlePublicConsumerReceipt(
      INTENT_ID,
      await seed({ evidence: EVIDENCE_UNVERIFIED }),
      null,
    )).body as { integrity: { digest: string; settlementDigest: string } };
    const after = (await handlePublicConsumerReceipt(
      INTENT_ID,
      await seed({ evidence: EVIDENCE_VERIFIED, verification: LATER_VERIFICATION }),
      null,
    )).body as { integrity: { digest: string; settlementDigest: string } };

    assert.equal(after.integrity.settlementDigest, before.integrity.settlementDigest, "the original claim must stay verifiable");
    assert.notEqual(after.integrity.digest, before.integrity.digest, "the current document did change, and must say so");
  });

  /**
   * The narrower statement of the same defect, so a regression names its cause directly.
   *
   * `untchVerified` moving is the ONLY thing a redrive does to the projection. If that alone can move
   * the settlement digest, the digest is not evidence of anything.
   */
  test("Untch's own verification claim is outside the settlement digest entirely", async () => {
    const unverified = (await handlePublicConsumerReceipt(INTENT_ID, await seed({ evidence: EVIDENCE_UNVERIFIED }), null))
      .body as { integrity: { settlementDigest: string }; delivery: { untchVerified: boolean } };
    const verified = (await handlePublicConsumerReceipt(INTENT_ID, await seed({ evidence: EVIDENCE_VERIFIED }), null))
      .body as { integrity: { settlementDigest: string }; delivery: { untchVerified: boolean } };

    // The projection genuinely differs...
    assert.equal(unverified.delivery.untchVerified, false);
    assert.equal(verified.delivery.untchVerified, true);
    // ...and the settlement digest does not notice.
    assert.equal(verified.integrity.settlementDigest, unverified.integrity.settlementDigest);
  });

  /**
   * What the MERCHANT said is a settlement-time fact and stays inside the digest.
   *
   * Otherwise the split would have gone too far: a receipt whose provider attestation could change
   * without moving the settlement digest would be worse than one that moved it too eagerly.
   */
  test("the provider's attestation IS inside the settlement digest", async () => {
    const fulfilled = (await handlePublicConsumerReceipt(INTENT_ID, await seed({ evidence: EVIDENCE_UNVERIFIED }), null))
      .body as { integrity: { settlementDigest: string } };
    const disputed = (await handlePublicConsumerReceipt(
      INTENT_ID,
      await seed({
        evidence: { ...EVIDENCE_UNVERIFIED, providerAttested: { ...EVIDENCE_UNVERIFIED.providerAttested, status: "disputed" } },
      }),
      null,
    )).body as { integrity: { settlementDigest: string } };
    assert.notEqual(disputed.integrity.settlementDigest, fulfilled.integrity.settlementDigest);
  });

  test("a REFUSED verification is published as refused, with its grounds named", async () => {
    // A verification that could not be established is still a fact about the intent, and hiding it
    // would leave `untchVerified: false` looking like nobody had ever tried.
    const refused: DeliveryVerificationRecord = {
      ...LATER_VERIFICATION,
      verified: false,
      detail: "verification refused on 1 ground(s): RESULT_NOT_BOUND",
      refusals: [{ code: "RESULT_NOT_BOUND", detail: "the persisted result answers a different query" }],
    };
    const body = (await handlePublicConsumerReceipt(INTENT_ID, await seed({ verification: refused }), null)).body as {
      verification: { verified: boolean; refusals: readonly string[] };
    };
    assert.equal(body.verification.verified, false);
    assert.deepEqual(body.verification.refusals, ["RESULT_NOT_BOUND"]);
  });

  /**
   * NEITHER anchor implies the other, and this is the pair of tests the whole split exists for.
   *
   * The settlement receipt and the verification addendum are two claims. Anchoring the settlement batch
   * can never carry the addendum — a batch's receipt set is fixed when the batch is created, and that
   * batch predates the verification. A document reporting one combined ANCHORED would assert the
   * verification was on chain when only the settlement was.
   */
  test("a settlement anchor does NOT make the verification anchored", async () => {
    // #given a settlement receipt confirmed on chain, and a verification whose receipt is still queued
    const deps = await seed({
      receiptId: `0x${"d".repeat(64)}`,
      evidence: EVIDENCE_VERIFIED,
      verification: { ...LATER_VERIFICATION, supersedingReceiptId: `0x${"5".repeat(64)}` },
    });
    const body = (await handlePublicConsumerReceipt(
      INTENT_ID,
      deps,
      // Settlement CONFIRMED; the verification receipt is not.
      (async (id: string) =>
        id === `0x${"d".repeat(64)}`
          ? { status: "CONFIRMED", txHash: `0x${"e".repeat(64)}`, blockNumber: 9, batchId: 1 }
          : { status: "QUEUED", txHash: null, blockNumber: null, batchId: null }) as never,
    )).body as {
      settlementAnchor: { state: string; covers: string };
      verificationAnchor: { state: string; covers: string };
      fullyAnchored: boolean;
    };

    assert.equal(body.settlementAnchor.state, "ANCHORED");
    assert.equal(body.verificationAnchor.state, "PENDING", "the addendum is NOT anchored by the settlement");
    assert.equal(body.fullyAnchored, false, "the combined document must not read as anchored");
    assert.equal(body.settlementAnchor.covers, "SETTLEMENT_DECISION_RECEIPT");
    assert.equal(body.verificationAnchor.covers, "DELIVERY_VERIFICATION_ADDENDUM");
  });

  test("a verification anchor does NOT make the settlement anchored", async () => {
    // #given the reverse: the settlement anchor failed, the verification receipt confirmed
    const deps = await seed({
      receiptId: `0x${"d".repeat(64)}`,
      evidence: EVIDENCE_VERIFIED,
      verification: { ...LATER_VERIFICATION, supersedingReceiptId: `0x${"5".repeat(64)}` },
    });
    const body = (await handlePublicConsumerReceipt(
      INTENT_ID,
      deps,
      (async (id: string) =>
        id === `0x${"d".repeat(64)}`
          ? { status: "DEGRADED_UNANCHORED", txHash: null, blockNumber: null, batchId: null }
          : { status: "CONFIRMED", txHash: `0x${"f".repeat(64)}`, blockNumber: 11, batchId: 2 }) as never,
    )).body as {
      settlementAnchor: { state: string };
      verificationAnchor: { state: string; txHash: string | null };
      fullyAnchored: boolean;
    };

    assert.equal(body.settlementAnchor.state, "ANCHOR_FAILED");
    assert.equal(body.verificationAnchor.state, "ANCHORED");
    assert.equal(body.verificationAnchor.txHash, `0x${"f".repeat(64)}`);
    assert.equal(body.fullyAnchored, false, "an anchored addendum does not anchor the settlement");
  });

  test("fullyAnchored is true only when BOTH confirm", async () => {
    const deps = await seed({
      receiptId: `0x${"d".repeat(64)}`,
      evidence: EVIDENCE_VERIFIED,
      verification: { ...LATER_VERIFICATION, supersedingReceiptId: `0x${"5".repeat(64)}` },
    });
    const body = (await handlePublicConsumerReceipt(
      INTENT_ID,
      deps,
      (async () => ({ status: "CONFIRMED", txHash: `0x${"e".repeat(64)}`, blockNumber: 9, batchId: 1 })) as never,
    )).body as { fullyAnchored: boolean; settlementAnchor: { state: string }; verificationAnchor: { state: string } };
    assert.equal(body.settlementAnchor.state, "ANCHORED");
    assert.equal(body.verificationAnchor.state, "ANCHORED");
    assert.equal(body.fullyAnchored, true);
  });

  test("with no verification at all, the verification anchor says so rather than showing a failure", async () => {
    const body = (await handlePublicConsumerReceipt(INTENT_ID, await seed({ receiptId: `0x${"d".repeat(64)}` }), null))
      .body as { verificationAnchor: { state: string }; fullyAnchored: boolean };
    // An absence, not a fault: nobody has re-verified this intent.
    assert.equal(body.verificationAnchor.state, "NO_VERIFICATION");
    assert.equal(body.fullyAnchored, false);
  });

  test("a verification with no receipt yet reports NOT_RECORDED, not anchored", async () => {
    const body = (await handlePublicConsumerReceipt(
      INTENT_ID,
      await seed({ receiptId: `0x${"d".repeat(64)}`, evidence: EVIDENCE_VERIFIED, verification: LATER_VERIFICATION }),
      null,
    )).body as { verificationAnchor: { state: string } };
    assert.equal(body.verificationAnchor.state, "NOT_RECORDED");
  });

  test("the addendum publishes no request payload of its own", async () => {
    // The verification record carries hashes, never the query that was searched for.
    const body = (await handlePublicConsumerReceipt(INTENT_ID, await seed({ verification: LATER_VERIFICATION }), null)).body;
    const serialised = JSON.stringify(body);
    assert.equal(serialised.includes("the-users-secret-startup-idea.com"), false);
    assert.equal(serialised.includes("12 Private Road"), false);
  });
});

describe("public receipt — settlement is reported honestly", () => {
  test("an intent with no provider payment says so instead of showing blanks", async () => {
    const deps = await seed();
    const body = (await handlePublicConsumerReceipt(INTENT_ID, deps, null)).body as {
      settlement: unknown;
      delivery: unknown;
    };
    assert.equal(body.settlement, null);
    assert.equal(body.delivery, null);
  });

  test("USDC settlement details surface once an execution is PAID", async () => {
    const paid = {
      executionId: "ex_1",
      intentId: INTENT_ID,
      providerId: "stabledomains",
      capability: "domains.check",
      state: "PAID",
      settledAmount: parseMoney("0.05", USDC),
      settlementChain: "eip155:8453",
      settlementTxHash: `0x${"f".repeat(64)}`,
      providerReference: "ref-1",
    } as unknown as ProviderExecutionRecord;
    const deps = depsFor(stubStore({ executions: [paid] }));

    const body = (await handlePublicConsumerReceipt(INTENT_ID, deps, null)).body as {
      settlement: { providerId: string; chain: string; txHash: string } | null;
    };
    assert.equal(body.settlement?.providerId, "stabledomains");
    assert.equal(body.settlement?.chain, "eip155:8453");
    assert.equal(body.settlement?.txHash, `0x${"f".repeat(64)}`);
  });
});
