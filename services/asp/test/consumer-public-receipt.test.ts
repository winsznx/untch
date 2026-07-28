import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { asset, moneyToJson, parseMoney } from "@untch/consumer-core";
import type { ConsumerIntent, ConsumerStore, Money, ProviderExecutionRecord } from "@untch/consumer-core";
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
function stubStore(over: { receiptId?: string | null; executions?: readonly ProviderExecutionRecord[] } = {}): ConsumerStore {
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
      return null;
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

const seed = async (over: { receiptId?: string | null } = {}): Promise<ConsumerDeps> => depsFor(stubStore(over));

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
