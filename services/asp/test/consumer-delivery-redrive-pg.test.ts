import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  PgConsumerStore,
  ProviderRegistry,
  StorePauseChecker,
  TreasuryRouter,
  asset,
  createPool,
  money,
  parseMoney,
  runMigrations,
  sha256Hex,
  stableStringify,
  type ConsumerIntentState,
  type ConsumerQuote,
  type ConsumerStore,
  type Pool,
  type ProviderExecutionRecord,
} from "@untch/consumer-core";
import { PROVIDER_SEEDS, PURCH_ENDPOINT_CLASS_SEARCH } from "@untch/consumer-providers";
import type { AdapterRegistry } from "@untch/consumer-providers";
import type { Ledger } from "@untch/policy-engine";
import type { PolicyProvider } from "@untch/policy-store";
import { ConsumerOrchestrator } from "../src/consumer/orchestrator";

/**
 * The redrive against a REAL Postgres.
 *
 * The in-memory suite proves the DECISIONS: what verifies, what refuses, and that nothing reaches a
 * rail. It cannot prove the two properties that only a real database has, and those are the ones the
 * production redrive rests on:
 *
 *   • IDEMPOTENCY IS ENFORCED BY THE PRIMARY KEY, not by a read-then-write in the orchestrator. Two
 *     redrives over identical evidence must collide at `(intent_id, verifier_version, evidence_digest)`
 *     and leave ONE row, whichever wins the race.
 *   • THE ROW IS IMMUTABLE. A repeat writes nothing new, so a verification cannot be quietly restated
 *     with different content under an id someone has already cited.
 *
 * Both matter because the production redrive runs against an intent that moved real money on Solana
 * mainnet, and a second conflicting claim about that settlement would be worse than no claim at all.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();

/**
 * This suite's OWN database.
 *
 * `node --test` runs files in parallel and every Postgres suite writes the same tables. This one
 * registers `purch` on Solana; `consumer-operator-routes-pg.test.ts` registers it on Base. Sharing a
 * database means each overwrites the other's registry row, both pass alone, and the failure reads as
 * flakiness. Isolation fixes the class rather than the case.
 */
const OWN_DATABASE = "untch_test_delivery_redrive";

function ownDatabaseUrl(): string {
  const url = new URL(TEST_DB as string);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_USDC = asset("solana.usdc");
const PAY_TO = "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2";
const TREASURY = "FSW47vP9xHqPZbBqA1Vtn6HDMPQvXPvXvHqZoR2mGz3k";
const TX = "63cbzAEuDkMFs41TwuGKjYC3YWz3e8FeYbQVfrt2WGmvWotdUMmiJCf3yzyd8EypPDikfQjWAxWGUa5rDTJLrhVK";
const QUERY = "usb-c cable";
const NOW = Date.parse("2026-07-30T18:00:00.000Z");

/** One intent id per test, so no test can pass on another's row. */
const intentId = (): string => `ci_${randomBytes(12).toString("hex")}`;

const PRODUCTS = [
  { asin: "B0AAA00001", title: "USB-C cable, 2 m", price: "9.99", currency: "USD", source: "amazon", productUrl: "https://example.com/a", imageUrl: "https://example.com/a.jpg" },
] as const;

const ATTESTED = {
  query: QUERY,
  count: PRODUCTS.length,
  products: PRODUCTS,
  resultHash: `0x${sha256Hex(
    stableStringify({
      query: QUERY,
      products: [{ asin: "B0AAA00001", title: "USB-C cable, 2 m", price: "9.99", currency: "USD", source: "amazon", url: "https://example.com/a", imageUrl: "https://example.com/a.jpg" }],
    } as unknown as Record<string, unknown>),
  )}`,
};

/** Every collaborator a payment would need, rigged to throw. A redrive that pays fails loudly. */
const explode = <T,>(what: string): T =>
  new Proxy({} as object, {
    get(_t, prop) {
      throw new Error(`THE REDRIVE REACHED ${what} via ${String(prop)}`);
    },
  }) as T;

let pool: Pool | null = null;

async function seed(store: ConsumerStore, id: string, over: { settledAtomic?: bigint } = {}): Promise<void> {
  /**
   * The REAL seed row, not a hand-built one.
   *
   * A fixture that spelled out its own provider would drift from the shipped registry, and the redrive
   * resolves the execution shape through exactly that registry.
   */
  const purch = PROVIDER_SEEDS.find((s) => s.provider.providerId === "purch");
  assert.ok(purch, "the purch seed must exist");
  await store.upsertProvider({ ...purch.provider, maturity: "verified" });
  for (const cap of purch.capabilities) {
    await store.upsertCapability({
      ...cap,
      maturity: "verified",
      ...(cap.capability === "shop.search" ? { executionShape: "PAID_READ" as const } : {}),
    });
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
    quoteId: `cq_${randomBytes(8).toString("hex")}`,
    intentId: id,
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
    quoteHash: `0x${randomBytes(32).toString("hex")}`,
    expiresAt: new Date(NOW + 600_000).toISOString(),
    createdAt: new Date(NOW).toISOString(),
  } as unknown as ConsumerQuote;

  await store.createIntent(
    {
      intentId: id,
      tenantId: "policy:12",
      requestingAgentId: "agent-1",
      principalId: "principal-1",
      action: "shop.search",
      category: "shop",
      request: { query: QUERY },
      policyId: "12",
      correlationId: `corr-${id}`,
      idempotencyKey: `idem-${id}`,
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
  let from: ConsumerIntentState = "CREATED";
  for (const to of path) {
    await store.transition(
      id, from, to,
      from === "CREATED" ? { providerId: "purch", quoteId: quote.quoteId, quoteHash: quote.quoteHash } : {},
      { name: `consumer.intent.${to.toLowerCase()}`, data: {} },
    );
    from = to;
  }

  const execution = {
    executionId: `ex_${randomBytes(8).toString("hex")}`,
    intentId: id,
    providerId: "purch",
    idempotencyKey: `exec-${id}`,
    attemptNo: 1,
    state: "PAID",
    providerReference: `search-${id}`,
    settlementTxHash: TX,
    settlementChain: SOLANA,
    settledAmount: money(over.settledAtomic ?? 10_000n, SOL_USDC),
    error: null,
    startedAt: new Date(NOW).toISOString(),
    finishedAt: new Date(NOW).toISOString(),
  } as unknown as ProviderExecutionRecord;
  await store.prepareExecution(execution);
  await store.updateExecution(execution.executionId, {
    state: "PAID",
    settlementTxHash: TX,
    settlementChain: SOLANA,
    settledAmount: execution.settledAmount,
  });

  await store.upsertDeliveryEvidence({
    intentId: id,
    providerId: "purch",
    providerAttested: {
      status: "fulfilled",
      reference: `search-${id}`,
      fields: ATTESTED,
      attestedAt: new Date(NOW).toISOString(),
    },
    untchVerified: { verified: false, method: "NONE", detail: "no shape-aware check existed at settlement", verifiedAt: null },
    evidenceHash: `0x${sha256Hex(stableStringify({ intentId: id, attested: ATTESTED } as unknown as Record<string, unknown>))}`,
  });
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

describe(
  "delivery redrive — real Postgres",
  { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" },
  () => {
    before(async () => {
      const admin = createPool(TEST_DB as string);
      try {
        // CREATE DATABASE cannot run in a transaction, and a duplicate is not worth failing on.
        await admin.query(`CREATE DATABASE ${OWN_DATABASE}`).catch((err: unknown) => {
          if ((err as { code?: string }).code !== "42P04") throw err;
        });
      } finally {
        await admin.end();
      }
      pool = createPool(ownDatabaseUrl());
      await runMigrations(pool);
    });

    after(async () => {
      await pool?.end();
    });

    const storeNow = (): ConsumerStore => new PgConsumerStore(pool as Pool, () => NOW);

    test("migration 014 applies and the table is keyed for idempotency", async () => {
      // #given the migrated database
      // #when the primary key is read back from the catalogue
      const { rows } = await (pool as Pool).query<{ column_name: string }>(
        `SELECT a.attname AS column_name
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'consumer_delivery_verifications'::regclass AND i.indisprimary
          ORDER BY a.attname`,
      );
      // #then it is the triple that makes an identical redrive collide rather than duplicate
      assert.deepEqual(rows.map((r) => r.column_name), ["evidence_digest", "intent_id", "verifier_version"]);
    });

    test("a verification round-trips through Postgres with every field intact", async () => {
      const id = intentId();
      const store = storeNow();
      await seed(store, id);

      const { record } = await orchestratorOver(store).redriveDeliveryVerification(id);
      assert.equal(record.verified, true, JSON.stringify(record.refusals));

      // Read back through a FRESH store, so nothing is served from an object still in memory.
      const readBack = await storeNow().latestDeliveryVerification(id);
      assert.equal(readBack?.verificationId, record.verificationId);
      assert.equal(readBack?.verifierVersion, record.verifierVersion);
      assert.equal(readBack?.evidenceDigest, record.evidenceDigest);
      assert.equal(readBack?.method, "PAID_READ_RESULT_BINDING");
      assert.equal(readBack?.settlementTx, TX);
      assert.equal(readBack?.settledAmount, "10000");
      assert.equal(readBack?.settlementChain, SOLANA);
      assert.deepEqual(readBack?.refusals, []);
    });

    /**
     * The constraint does the work, not the orchestrator.
     *
     * Four redrives at once is the shape of an operator retrying a command that appeared to hang. If
     * idempotency lived in a read-then-write, all four would read "absent" and all four would insert.
     */
    test("four concurrent redrives leave exactly one row", async () => {
      const id = intentId();
      const store = storeNow();
      await seed(store, id);

      const results = await Promise.all(
        Array.from({ length: 4 }, () => orchestratorOver(storeNow()).redriveDeliveryVerification(id)),
      );

      const { rows } = await (pool as Pool).query<{ n: string }>(
        "SELECT count(*)::text AS n FROM consumer_delivery_verifications WHERE intent_id = $1",
        [id],
      );
      assert.equal(rows[0]?.n, "1", "the primary key must collapse identical redrives to one row");

      // All four callers agree on which verification is on record.
      const ids = new Set(results.map((r) => r.record.verificationId));
      assert.equal(ids.size, 1, "every caller must be told about the same row");
      // …and at most one of them wrote it.
      assert.equal(results.filter((r) => !r.alreadyRecorded).length <= 1, true);
    });

    test("a repeat writes nothing new, and cannot restate an id someone has already cited", async () => {
      const id = intentId();
      const store = storeNow();
      await seed(store, id);

      const first = await orchestratorOver(store).redriveDeliveryVerification(id);
      const beforeRow = (
        await (pool as Pool).query("SELECT * FROM consumer_delivery_verifications WHERE intent_id = $1", [id])
      ).rows[0];

      const second = await orchestratorOver(storeNow()).redriveDeliveryVerification(id);
      const afterRow = (
        await (pool as Pool).query("SELECT * FROM consumer_delivery_verifications WHERE intent_id = $1", [id])
      ).rows[0];

      assert.equal(second.alreadyRecorded, true);
      assert.equal(second.record.verificationId, first.record.verificationId);
      assert.deepEqual(afterRow, beforeRow, "the stored row must be byte-identical after a repeat");
    });

    test("a newer verifier version writes its own row and leaves the old verdict standing", async () => {
      const id = intentId();
      const store = storeNow();
      await seed(store, id);
      const { record } = await orchestratorOver(store).redriveDeliveryVerification(id);

      await store.recordDeliveryVerification({
        ...record,
        verificationId: `dv_${randomBytes(10).toString("hex")}`,
        verifierVersion: "purch-paid-read/2.0.0",
        verified: false,
        detail: "a later verifier disagreed",
        refusals: [{ code: "STRICTER_CHECK", detail: "added in 2.0.0" }],
      });

      const all = await store.listDeliveryVerifications(id);
      assert.equal(all.length, 2, "a disagreement between versions must stay visible, not be resolved by order");
      assert.ok(all.some((r) => r.verifierVersion === "purch-paid-read/1.0.0" && r.verified));
      assert.ok(all.some((r) => r.verifierVersion === "purch-paid-read/2.0.0" && !r.verified));
    });

    test("a refusal persists its grounds as structured JSON, not as prose", async () => {
      const id = intentId();
      const store = storeNow();
      // A settlement far above the authorised quote — a verification that must not be established.
      await seed(store, id, { settledAtomic: 500_000n });

      const { record } = await orchestratorOver(store).redriveDeliveryVerification(id);
      assert.equal(record.verified, false);

      const readBack = await storeNow().latestDeliveryVerification(id);
      assert.ok(readBack?.refusals.some((r) => r.code === "ABOVE_AUTHORISED_QUOTE"));
      assert.equal(typeof readBack?.refusals[0]?.detail, "string");

      // The honest `false` on the projection is preserved rather than upgraded by a failed check.
      const evidence = await storeNow().getDeliveryEvidence(id);
      assert.equal(evidence?.untchVerified.verified, false);
      assert.equal(evidence?.untchVerified.method, "NONE");
    });

    test("the intent row, its receipt id and its timestamps are untouched by a redrive", async () => {
      const id = intentId();
      const store = storeNow();
      await seed(store, id);

      const before = (await (pool as Pool).query("SELECT * FROM consumer_intents WHERE intent_id = $1", [id])).rows[0] as Record<string, unknown>;
      await orchestratorOver(store).redriveDeliveryVerification(id);
      const after = (await (pool as Pool).query("SELECT * FROM consumer_intents WHERE intent_id = $1", [id])).rows[0] as Record<string, unknown>;

      for (const column of ["state", "receipt_id", "created_at", "quote_hash", "spend_intent_hash", "policy_id"]) {
        assert.deepEqual(after[column], before[column], `consumer_intents.${column} must not move`);
      }
    });

    test("no execution row and no ledger group is written by a redrive", async () => {
      const id = intentId();
      const store = storeNow();
      await seed(store, id);

      const executionsBefore = await store.listExecutions(id);
      await orchestratorOver(store).redriveDeliveryVerification(id);

      assert.deepEqual(await storeNow().listExecutions(id), executionsBefore);
      assert.deepEqual(await storeNow().ledgerGroupsForIntent(id), []);
    });
  },
);
