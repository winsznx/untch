import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryConsumerStore,
  InvalidStateTransitionError,
  StaleIntentStateError,
  asset,
  deriveIdempotencyKey,
  fundingGroup,
  parseMoney,
  providerIdempotencyKey,
  type ConsumerStore,
  type CreateIntentInput,
  type FundingReceipt,
  type ProviderExecutionRecord,
  type TransitionEvent,
} from "../src/index";

const USDT0 = asset("xlayer.usdt0");
const CREATED_EVENT: TransitionEvent = { name: "consumer.intent.created", data: {} };

function baseInput(over: Partial<CreateIntentInput> = {}): CreateIntentInput {
  return {
    intentId: "ci_000000000000000000000001",
    tenantId: "tenant-a",
    requestingAgentId: "agent-1",
    principalId: "user-1",
    action: "domains.register",
    category: "domains",
    request: { domain: "example.xyz" },
    policyId: "42",
    correlationId: "cor_1",
    idempotencyKey: "key-1",
    expiresAt: null,
    ...over,
  };
}

async function seeded(): Promise<{ store: ConsumerStore; intentId: string }> {
  const store = new InMemoryConsumerStore(() => Date.parse("2026-07-27T12:00:00.000Z"));
  const { intent } = await store.createIntent(baseInput(), CREATED_EVENT);
  return { store, intentId: intent.intentId };
}

describe("store — the transition is a compare-and-set", () => {
  test("a legal transition advances the state and emits exactly one event", async () => {
    const { store, intentId } = await seeded();
    const r = await store.transition(intentId, "CREATED", "DISCOVERING", {}, {
      name: "consumer.discovery.completed",
      data: { options: 3 },
    });
    assert.equal(r.intent.state, "DISCOVERING");
    assert.equal(r.event.seq, 2);
    const events = await store.eventsSince(intentId, 0, 100);
    assert.deepEqual(events.map((e) => e.name), [
      "consumer.intent.created",
      "consumer.discovery.completed",
    ]);
  });

  test("a SECOND transition from a stale expectation is refused", async () => {
    // Two workers read the same intent, both try to advance it. Exactly one wins.
    const { store, intentId } = await seeded();
    await store.transition(intentId, "CREATED", "DISCOVERING", {}, CREATED_EVENT);
    await assert.rejects(
      () => store.transition(intentId, "CREATED", "DISCOVERING", {}, CREATED_EVENT),
      StaleIntentStateError,
    );
  });

  test("an illegal edge is refused before any write happens", async () => {
    const { store, intentId } = await seeded();
    await assert.rejects(
      () => store.transition(intentId, "CREATED", "COMPLETED", {}, CREATED_EVENT),
      InvalidStateTransitionError,
    );
    const after = await store.getIntent(intentId);
    assert.equal(after?.state, "CREATED");
    // And no event leaked out of the failed attempt.
    assert.equal((await store.eventsSince(intentId, 0, 100)).length, 1);
  });

  test("event seq is per-intent, monotonic and gapless", async () => {
    const { store, intentId } = await seeded();
    await store.transition(intentId, "CREATED", "DISCOVERING", {}, CREATED_EVENT);
    await store.transition(intentId, "DISCOVERING", "QUOTED", {}, CREATED_EVENT);
    await store.transition(intentId, "QUOTED", "POLICY_CHECKING", {}, CREATED_EVENT);
    const events = await store.eventsSince(intentId, 0, 100);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
  });

  test("Last-Event-ID resume returns only what follows the cursor", async () => {
    const { store, intentId } = await seeded();
    await store.transition(intentId, "CREATED", "DISCOVERING", {}, CREATED_EVENT);
    await store.transition(intentId, "DISCOVERING", "QUOTED", {}, CREATED_EVENT);
    const resumed = await store.eventsSince(intentId, 2, 100);
    assert.deepEqual(resumed.map((e) => e.seq), [3]);
  });

  test("a patch of undefined never clobbers a real value", async () => {
    // Load-bearing under exactOptionalPropertyTypes: spreading { policyHash: undefined } must not
    // erase a stored hash. That would be silent data loss on a field an approval binds to.
    const { store, intentId } = await seeded();
    await store.transition(intentId, "CREATED", "QUOTED", { policyHash: "0xabc" }, CREATED_EVENT);
    await store.transition(intentId, "QUOTED", "POLICY_CHECKING", { policyVersion: 3 }, CREATED_EVENT);
    const after = await store.getIntent(intentId);
    assert.equal(after?.policyHash, "0xabc");
    assert.equal(after?.policyVersion, 3);
  });
});

describe("store — tenant isolation", () => {
  test("a cross-tenant read returns null rather than the row", async () => {
    const { store, intentId } = await seeded();
    assert.notEqual(await store.getIntentForTenant("tenant-a", intentId), null);
    assert.equal(await store.getIntentForTenant("tenant-b", intentId), null);
  });

  test("two tenants may use the SAME idempotency key without colliding", async () => {
    const store = new InMemoryConsumerStore();
    await store.createIntent(baseInput({ tenantId: "t1", intentId: "ci_1" }), CREATED_EVENT);
    await store.createIntent(baseInput({ tenantId: "t2", intentId: "ci_2" }), CREATED_EVENT);
    assert.equal((await store.findByIdempotencyKey("t1", "key-1"))?.intentId, "ci_1");
    assert.equal((await store.findByIdempotencyKey("t2", "key-1"))?.intentId, "ci_2");
  });

  test("the same tenant reusing a key is refused", async () => {
    const store = new InMemoryConsumerStore();
    await store.createIntent(baseInput({ intentId: "ci_1" }), CREATED_EVENT);
    await assert.rejects(() => store.createIntent(baseInput({ intentId: "ci_2" }), CREATED_EVENT));
  });

  test("derived idempotency keys differ across tenants for a byte-identical request", () => {
    const request = { domain: "example.xyz" };
    const a = deriveIdempotencyKey({ tenantId: "t1", action: "domains.register", request });
    const b = deriveIdempotencyKey({ tenantId: "t2", action: "domains.register", request });
    assert.notEqual(a, b);
  });

  test("derived idempotency keys differ across actions for the same request", () => {
    const request = { domain: "example.xyz" };
    assert.notEqual(
      deriveIdempotencyKey({ tenantId: "t1", action: "domains.check", request }),
      deriveIdempotencyKey({ tenantId: "t1", action: "domains.register", request }),
    );
  });

  test("derived idempotency keys are stable under key reordering", () => {
    assert.equal(
      deriveIdempotencyKey({ tenantId: "t1", action: "a", request: { x: 1, y: 2 } }),
      deriveIdempotencyKey({ tenantId: "t1", action: "a", request: { y: 2, x: 1 } }),
    );
  });
});

describe("store — one funding receipt can never fund two intents", () => {
  const receipt = (over: Partial<FundingReceipt> = {}): FundingReceipt => ({
    intentId: "ci_000000000000000000000001",
    chain: "eip155:196",
    txHash: "0xFEED",
    amount: parseMoney("20.50", USDT0),
    payer: null,
    settledAt: "2026-07-27T12:00:00.000Z",
    confirmations: 12,
    finalized: true,
    ...over,
  });

  test("a duplicate settlement for the same intent is a no-op, not a second credit", async () => {
    const { store, intentId } = await seeded();
    const g = (id: string): ReturnType<typeof fundingGroup> =>
      fundingGroup({
        groupId: id,
        intentId,
        total: parseMoney("20.50", USDT0),
        treasuryRef: "t",
        createdAt: "2026-07-27T12:00:00.000Z",
      });
    assert.equal(await store.recordFunding(receipt(), g("g1")), true);
    assert.equal(await store.recordFunding(receipt({ txHash: "0xOTHER" }), g("g2")), false);
    // And exactly one ledger group exists — the second call wrote nothing at all.
    assert.equal((await store.ledgerGroupsForIntent(intentId)).length, 1);
  });

  test("the SAME on-chain tx cannot fund a DIFFERENT intent", async () => {
    const store = new InMemoryConsumerStore();
    await store.createIntent(baseInput({ intentId: "ci_1", idempotencyKey: "k1" }), CREATED_EVENT);
    await store.createIntent(baseInput({ intentId: "ci_2", idempotencyKey: "k2" }), CREATED_EVENT);
    const mk = (intentId: string, groupId: string) =>
      fundingGroup({
        groupId,
        intentId,
        total: parseMoney("20.50", USDT0),
        treasuryRef: "t",
        createdAt: "2026-07-27T12:00:00.000Z",
      });
    assert.equal(await store.recordFunding(receipt({ intentId: "ci_1" }), mk("ci_1", "g1")), true);
    assert.equal(await store.recordFunding(receipt({ intentId: "ci_2" }), mk("ci_2", "g2")), false);
    assert.equal(await store.getFunding("ci_2"), null);
  });

  test("tx-hash uniqueness is case-insensitive", async () => {
    const store = new InMemoryConsumerStore();
    await store.createIntent(baseInput({ intentId: "ci_1", idempotencyKey: "k1" }), CREATED_EVENT);
    await store.createIntent(baseInput({ intentId: "ci_2", idempotencyKey: "k2" }), CREATED_EVENT);
    const mk = (intentId: string, groupId: string) =>
      fundingGroup({
        groupId,
        intentId,
        total: parseMoney("1.00", USDT0),
        treasuryRef: "t",
        createdAt: "2026-07-27T12:00:00.000Z",
      });
    await store.recordFunding(
      receipt({ intentId: "ci_1", txHash: "0xAbCdEf", amount: parseMoney("1.00", USDT0) }),
      mk("ci_1", "g1"),
    );
    assert.equal(
      await store.recordFunding(
        receipt({ intentId: "ci_2", txHash: "0xabcdef", amount: parseMoney("1.00", USDT0) }),
        mk("ci_2", "g2"),
      ),
      false,
    );
  });
});

describe("store — one provider execution can never be sent twice", () => {
  const exec = (over: Partial<ProviderExecutionRecord> = {}): ProviderExecutionRecord => ({
    executionId: "ex_1",
    intentId: "ci_000000000000000000000001",
    providerId: "stabledomains",
    attemptNo: 1,
    idempotencyKey: providerIdempotencyKey("ci_000000000000000000000001"),
    state: "PREPARED",
    providerReference: null,
    settlementTxHash: null,
    settlementChain: null,
    settledAmount: null,
    error: null,
    startedAt: "2026-07-27T12:00:00.000Z",
    finishedAt: null,
    ...over,
  });

  test("a second attempt with the same provider idempotency key is refused", async () => {
    const { store } = await seeded();
    await store.prepareExecution(exec());
    await assert.rejects(
      () => store.prepareExecution(exec({ executionId: "ex_2", attemptNo: 2 })),
      /idempotency key already used/,
    );
  });

  test("a second attempt with the same attempt number is refused", async () => {
    const { store } = await seeded();
    await store.prepareExecution(exec());
    await assert.rejects(
      () => store.prepareExecution(exec({ executionId: "ex_2", idempotencyKey: "different" })),
      /attempt 1 already exists/,
    );
  });

  test("the provider idempotency key is stable for an intent and unique across intents", () => {
    assert.equal(providerIdempotencyKey("ci_a"), providerIdempotencyKey("ci_a"));
    assert.notEqual(providerIdempotencyKey("ci_a"), providerIdempotencyKey("ci_b"));
  });

  test("SENT rows are what the reconciler finds", async () => {
    const { store } = await seeded();
    await store.prepareExecution(exec({ state: "SENT" }));
    const found = await store.findAmbiguousExecutions("2026-07-27T13:00:00.000Z", 10);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.executionId, "ex_1");
  });
});

describe("store — a ledger group of each kind happens at most once per intent", () => {
  test("a second FUNDING group for the same intent is refused", async () => {
    const { store, intentId } = await seeded();
    const mk = (groupId: string) =>
      fundingGroup({
        groupId,
        intentId,
        total: parseMoney("1.00", USDT0),
        treasuryRef: "t",
        createdAt: "2026-07-27T12:00:00.000Z",
      });
    await store.appendLedgerGroup(mk("g1"));
    await assert.rejects(() => store.appendLedgerGroup(mk("g2")), /already exists for intent/);
  });
});
