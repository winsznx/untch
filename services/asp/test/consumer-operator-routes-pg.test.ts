import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  PgConsumerStore,
  ProviderRegistry,
  StorePauseChecker,
  TreasuryRouter,
  asset,
  createPool,
  loadConsumerFlags,
  money,
  parseMoney,
  runMigrations,
  type CaipChainId,
  type Money,
  type PaymentRequest,
  type PaymentResult,
  type Pool,
  type RailClient,
} from "@untch/consumer-core";
import type {
  AdapterContext,
  AdapterRegistry,
  ConsumerProviderAdapter,
  DeliveryEvidence,
  DiscoveryInput,
  DiscoveryResult,
  ExecuteInput,
  NormalizedProviderError,
  PaymentCapability,
  ProviderCapabilityDescriptor,
  ProviderExecution,
  ProviderHealth,
  ProviderQuote,
  ProviderReference,
  ProviderStatus,
  QuoteInput,
} from "@untch/consumer-providers";
import type { Ledger, LedgerWindowState, SpendIntentInput } from "@untch/policy-engine";
import type { PolicyProvider, StoredPolicy } from "@untch/policy-store";
import { ConsumerOrchestrator } from "../src/consumer/orchestrator";
import { SseHub, OutboxDispatcher } from "../src/consumer/dispatcher";
import { makeFundingPrice } from "../src/consumer/funding-price";
import {
  registerConsumerOperatorRoutes,
  OPERATOR_CREATE_ROUTE,
  OPERATOR_PREFLIGHT_ROUTE,
} from "../src/consumer/operator-routes";
import { resetOperatorAuthAudit, resetOperatorAuthThrottle } from "../src/internal-auth";
import { DeploymentLifecycle } from "../src/deployment-info";
import type { ConsumerWiring } from "../src/consumer/wiring";

/**
 * The operator routes against a REAL Postgres.
 *
 * The in-memory suite proves the decisions. It cannot prove the two properties that only a real
 * database has, and those are the ones that matter most for a route that names an intent id in
 * advance:
 *
 *   • UNIQUENESS IS ENFORCED BY THE STORE, not by a check-then-write in the route. Two concurrent
 *     creates of the same id must produce one row, and the loser must lose at the constraint rather
 *     than at a race the route happened to win.
 *   • IDEMPOTENCY IS CLAIMED DURABLY, keyed (tenant, key), so a duplicate key naming a different
 *     intent cannot create a second one.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent — and set in CI,
 * because a skipped integration test on the one machine that gates merges is a test that does not
 * exist.
 *
 * WHY THIS SUITE SETTLES ON BASE
 *
 * It used to settle on Solana, which stopped working when a Solana settlement began requiring an armed
 * one-shot proof gate naming ONE exact intent id. Every test here mints a RANDOM id, so a single
 * app-wide gate cannot name them, and the suite would have had to rebuild the server per test to satisfy
 * a control that has nothing to do with what it measures.
 *
 * Uniqueness and durable idempotency are properties of the STORE. They do not vary by rail. Base has no
 * one-shot gate — its authority is standing rather than bounded — so the durability assertions run
 * unchanged on a rail whose configuration does not move underneath them. The Solana arming semantics are
 * covered where they belong: in the in-memory operator suite, and end to end in
 * `consumer-proof-controller-two-process.test.ts`, which runs a real worker against a real gate.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();

/** Base, deliberately. See the header: this suite measures the store, not the arming controls. */
const SETTLEMENT_CHAIN: CaipChainId = "eip155:8453";
const SETTLEMENT_ASSET = asset("base.usdc");
const USDT0 = asset("xlayer.usdt0");
const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const OPS_TOKEN = ["operator", "pg", "suite", "token"].join("-");

const ATTESTATION_DIR = mkdtempSync(join(tmpdir(), "untch-operator-pg-"));
writeFileSync(
  join(ATTESTATION_DIR, ".untch-build-attestation.json"),
  JSON.stringify({
    commit: "39eb8d729488c44b58498e2c2dcb8a2abcd881d7",
    branch: "feat/remote-consumer-intent-control",
    builtAt: "2026-07-30T11:00:00.000Z",
    source: "clean git export",
  }),
);

const ENV: NodeJS.ProcessEnv = {
  INTERNAL_OPS_TOKEN: OPS_TOKEN,
  UNTCH_ENVIRONMENT: "production",
  CONSUMER_PACK_ENABLED: "1",
  CONSUMER_EXECUTION_ENABLED: "1",
  CONSUMER_PROVIDER_PURCH_ENABLED: "1",
  CONSUMER_CHAIN_EIP155_8453_ENABLED: "1",
  CONSUMER_ASSET_EIP155_8453_USDC_ENABLED: "1",
  /**
   * What makes the Base rail's signer report present. Never read as a key.
   *
   * `FakeRail` stands in for the client and this suite settles nothing on chain, so the only property
   * that matters is that the variable is non-empty — `railSignerConfigured` checks presence, not shape.
   * A plausible-looking hex string would be a secret-scanner finding that is false and still has to be
   * triaged, so this says what it is instead.
   */
  CONSUMER_TREASURY_BASE_PRIVATE_KEY: "not-a-key-this-suite-never-signs",
};

class FakeRail implements RailClient {
  readonly chain = SETTLEMENT_CHAIN;
  address(): string {
    return "0x0e79371813e88F31c2B60C80bad391a952039095";
  }
  available(): boolean {
    return true;
  }
  async balanceOf(a: typeof SETTLEMENT_ASSET): Promise<Money> {
    return money(1_000_000n, a);
  }
  async pay(_r: PaymentRequest): Promise<PaymentResult> {
    throw new Error("a rail must never be reached from an operator route");
  }
}

class MemoryLedger implements Ledger {
  private spent = 0;
  async read(): Promise<LedgerWindowState> {
    return { spentTodayByAgent: this.spent, recentIntents: [], lastCallByService: {}, callsInLastHour: 0 };
  }
  async commitApproved(_k: string, i: SpendIntentInput): Promise<void> {
    this.spent += i.amount;
  }
}

class UnpayableAdapter implements ConsumerProviderAdapter {
  readonly providerId = "purch";
  executeCalls = 0;
  capabilities(): readonly ProviderCapabilityDescriptor[] {
    return [];
  }
  async health(_c: AdapterContext): Promise<ProviderHealth> {
    return { healthy: true, latencyMs: 1, detail: "test double" };
  }
  async discover(_i: DiscoveryInput, _c: AdapterContext): Promise<DiscoveryResult> {
    throw new Error("not reachable");
  }
  async quote(input: QuoteInput, _c: AdapterContext): Promise<ProviderQuote> {
    return {
      providerId: this.providerId,
      providerRef: input.providerRef,
      cost: money(10_000n, SETTLEMENT_ASSET),
      settlementRecipient: new FakeRail().address(),
      settlementChain: SETTLEMENT_CHAIN,
      settlementAsset: SETTLEMENT_ASSET,
      summary: "Search",
      terms: { ref: input.providerRef },
      expiresAt: new Date(NOW + 600_000).toISOString(),
    };
  }
  async execute(_i: ExecuteInput, _p: PaymentCapability, _c: AdapterContext): Promise<ProviderExecution> {
    this.executeCalls += 1;
    throw new Error("PROVIDER EXECUTION REACHED FROM A ROUTE");
  }
  async getStatus(_r: ProviderReference, _c: AdapterContext): Promise<ProviderStatus> {
    throw new Error("not reachable");
  }
  async verifyDelivery(_e: ProviderExecution, _c: AdapterContext): Promise<DeliveryEvidence> {
    throw new Error("not reachable");
  }
  normalizeError(err: unknown): NormalizedProviderError {
    return { code: "PROVIDER_UNAVAILABLE", message: String(err), retryable: false, providerCode: null, retryAfterMs: null };
  }
}

const RULES = {
  budgets: { daily: 1000, token: "USDT0" },
  perCallCap: 500,
  onPerCallCapExceeded: "BLOCK",
  escalateAbove: 1000,
  categories: { allow: [], deny: [] },
  recipients: { allow: [], deny: [] },
  agents: { allowWorkerIds: [], denyWorkerIds: [] },
  duplicates: { ttlMin: 0, keys: [] },
  cooldowns: { sameServiceMin: 0 },
  rateLimit: { callsPerHour: 100 },
  expiry: "2027-01-01T00:00:00.000Z",
};

const POLICY_PROVIDER = {
  async load() {
    return { id: "9001", version: 1, status: "ACTIVE", rules: RULES } as never;
  },
  async loadStored() {
    return {
      id: "9001",
      owner: "0x0000000000000000000000000000000000000001",
      agentId: "1",
      version: 1,
      status: "ACTIVE",
      policyHash: `0x${"cd".repeat(32)}`,
      expiry: 2_000_000_000,
      onchainRef: {},
      rules: RULES,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as StoredPolicy;
  },
} as unknown as PolicyProvider;

let pool: Pool | null = null;
let store: PgConsumerStore | null = null;
let adapter: UnpayableAdapter | null = null;
let baseUrl = "";
const servers: Server[] = [];

async function boot(): Promise<void> {
  const p = createPool(TEST_DB as string);
  pool = p;
  await runMigrations(p);
  const s = new PgConsumerStore(p);
  store = s;
  const a = new UnpayableAdapter();
  adapter = a;

  await s.upsertProvider({
    providerId: "purch",
    displayName: "Purch",
    maturity: "verified",
    baseUrl: "https://api.purch.xyz",
    protocol: "x402",
    chains: [SETTLEMENT_CHAIN],
    provenance: "pg integration harness",
    enabled: true,
  });
  await s.upsertCapability({
    providerId: "purch",
    capability: "shop.search",
    maturity: "verified",
    notes: "pg integration harness",
  });
  await s.upsertTreasuryAccount({
    treasuryRef: "base-usdc-settlement",
    asset: SETTLEMENT_ASSET,
    purpose: "SETTLEMENT",
    address: new FakeRail().address(),
    minBalance: parseMoney("0.00", SETTLEMENT_ASSET),
    dailyLimit: parseMoney("5.00", SETTLEMENT_ASSET),
    enabled: true,
  });
  await s.upsertTreasuryAccount({
    treasuryRef: "xlayer-usdt0-funding",
    asset: USDT0,
    purpose: "FUNDING",
    address: "0x0000000000000000000000000000000000000002",
    minBalance: parseMoney("0.00", USDT0),
    dailyLimit: parseMoney("0.00", USDT0),
    enabled: true,
  });

  const rail = new FakeRail();
  const treasury = new TreasuryRouter({
    store: s,
    rails: new Map<CaipChainId, RailClient>([[SETTLEMENT_CHAIN, rail]]),
    pauses: new StorePauseChecker(s),
    clock: () => NOW,
  });
  const adapters: AdapterRegistry = { get: () => a, has: () => true, all: () => [a] };
  const config = {
    allowSandboxExecution: false,
    maxSingleExecutionDisplay: "1.00",
    quoteTtlSec: 600,
    fundingTtlSec: 900,
    providerTimeoutMs: 5_000,
    executeTimeoutMs: 5_000,
    breakerThreshold: 5,
    breakerCooldownMs: 60_000,
  };
  const orchestrator = new ConsumerOrchestrator({
    store: s,
    registry: new ProviderRegistry({
      store: s,
      gate: { executionFloor: "verified", allowSandboxExecution: false },
      flags: loadConsumerFlags(ENV),
      clock: () => NOW,
    }),
    adapters,
    treasury,
    policyProvider: POLICY_PROVIDER,
    ledger: new MemoryLedger(),
    escalation: null,
    receipts: null,
    config,
    publicBaseUrl: "https://asp.untch.xyz",
    siwx: null,
    clock: () => NOW,
  });

  const lifecycle = new DeploymentLifecycle(ENV, new Date(NOW).toISOString(), ATTESTATION_DIR);
  lifecycle.recordSchema("011", true);
  lifecycle.markReady(new Date(NOW).toISOString());

  const wiring = {
    store: s,
    registry: new ProviderRegistry({
      store: s,
      gate: { executionFloor: "verified", allowSandboxExecution: false },
      flags: loadConsumerFlags(ENV),
    }),
    adapters,
    treasury,
    orchestrator,
    dispatcher: new OutboxDispatcher({ store: s, hub: new SseHub() }),
    hub: new SseHub(),
    fundingPrice: makeFundingPrice({ store: s }),
    config,
    publicBaseUrl: "https://asp.untch.xyz",
    availableRails: [SETTLEMENT_CHAIN],
    pool: p,
    async close(): Promise<void> {},
  } satisfies ConsumerWiring;

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  registerConsumerOperatorRoutes(app, {
    wiring,
    policyProvider: POLICY_PROVIDER,
    lifecycle,
    flags: loadConsumerFlags(ENV),
    env: ENV,
  });
  baseUrl = await new Promise<string>((resolve) => {
    const server = app.listen(0, () => {
      servers.push(server);
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`);
    });
  });
}

function newId(): string {
  return `ci_${randomBytes(12).toString("hex")}`;
}

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intentId: newId(),
    tenantId: "policy:9001",
    owner: "untch-operator",
    provider: "purch",
    capability: "shop.search",
    request: { query: "usb c cable", limit: 5 },
    providerRef: "search:usb c cable",
    maxProviderAmount: "0.020000",
    expectedSettlementChain: SETTLEMENT_CHAIN,
    expectedSettlementAsset: "USDC",
    fundingMode: "operator-funded",
    idempotencyKey: `pg-${randomBytes(6).toString("hex")}`,
    ...over,
  };
}

async function post(path: string, b: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPS_TOKEN}` },
    body: JSON.stringify(b),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe(
  "operator routes against a real Postgres",
  { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" },
  () => {
    before(async () => {
      resetOperatorAuthThrottle();
      resetOperatorAuthAudit();
      await boot();
    });

    after(async () => {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await pool?.end();
      rmSync(ATTESTATION_DIR, { recursive: true, force: true });
    });

    test("preflight reads the durable registry and writes nothing", async () => {
      const b = body();
      const r = await post(OPERATOR_PREFLIGHT_ROUTE, b);
      assert.equal(r.status, 200);
      assert.equal(r.body.accepted, true);
      assert.equal((r.body.productionMaturity as Record<string, unknown>).effective, "verified");
      assert.equal(await store?.getIntent(String(b.intentId)), null);
    });

    test("create writes the EXACT supplied id, durably", async () => {
      const b = body();
      const r = await post(OPERATOR_CREATE_ROUTE, b);
      assert.equal(r.status, 201);
      assert.equal(r.body.intentId, b.intentId);
      const durable = await store?.getIntent(String(b.intentId));
      assert.equal(durable?.intentId, b.intentId);
      assert.equal(durable?.state, "EXECUTION_QUEUED");
      assert.equal(durable?.tenantId, "policy:9001");
    });

    test("the reservation and the queue row are durable, and no provider was executed", async () => {
      const b = body();
      await post(OPERATOR_CREATE_ROUTE, b);
      assert.ok(await store?.getFunding(String(b.intentId)));
      assert.equal(adapter?.executeCalls, 0);
      const executions = await store?.listExecutions(String(b.intentId));
      assert.equal(executions?.length, 0, "no provider execution row may exist");
    });

    test("operator provenance survives a round trip through Postgres", async () => {
      const b = body();
      await post(OPERATOR_CREATE_ROUTE, b);
      const events = await store?.eventsSince(String(b.intentId), 0, 50);
      const created = events?.find((e) => e.name === "consumer.intent.created");
      const provenance = (created?.data as Record<string, unknown>).provenance as Record<string, unknown>;
      assert.equal(provenance.source, "internal-operator-api");
      assert.equal(provenance.servingCommit, "39eb8d729488c44b58498e2c2dcb8a2abcd881d7");
      assert.match(String(provenance.requestHash), /^0x[0-9a-f]{64}$/);
      assert.ok(!JSON.stringify(events).includes(OPS_TOKEN));
    });

    test("a second create on the same id is refused by the durable store", async () => {
      const b = body();
      assert.equal((await post(OPERATOR_CREATE_ROUTE, b)).status, 201);
      const again = await post(OPERATOR_CREATE_ROUTE, { ...b, idempotencyKey: `pg-${randomBytes(6).toString("hex")}` });
      assert.equal(again.status, 409);
    });

    /**
     * The property the in-memory store cannot prove.
     *
     * Both requests pass the pre-check, so exactly one of them must lose at the DATABASE — either on
     * the intents primary key or on the idempotency record. If both ever succeeded, one authorised
     * spend would have become two queued ones.
     */
    test("two concurrent creates of the same id produce exactly one durable intent", async () => {
      const b = body();
      const results = await Promise.all([post(OPERATOR_CREATE_ROUTE, b), post(OPERATOR_CREATE_ROUTE, b)]);
      const created = results.filter((r) => r.status === 201);
      assert.equal(created.length, 1, `exactly one create may win, got ${JSON.stringify(results.map((r) => r.status))}`);
      const durable = await store?.getIntent(String(b.intentId));
      assert.ok(durable);
      assert.equal(durable?.state, "EXECUTION_QUEUED");
    });

    test("two concurrent creates sharing an idempotency key produce exactly one durable intent", async () => {
      const key = `pg-shared-${randomBytes(6).toString("hex")}`;
      const first = body({ idempotencyKey: key });
      const second = body({ idempotencyKey: key });
      const results = await Promise.all([
        post(OPERATOR_CREATE_ROUTE, first),
        post(OPERATOR_CREATE_ROUTE, second),
      ]);
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      const a = await store?.getIntent(String(first.intentId));
      const bIntent = await store?.getIntent(String(second.intentId));
      assert.equal([a, bIntent].filter(Boolean).length, 1, "only one of the two ids may exist");
    });

    test("the status read comes from the same production store", async () => {
      const b = body();
      await post(OPERATOR_CREATE_ROUTE, b);
      const scoped = await store?.getIntentForTenant("policy:9001", String(b.intentId));
      assert.equal(scoped?.intentId, b.intentId);
      // …and tenant isolation still holds for the read the controller will use.
      assert.equal(await store?.getIntentForTenant("policy:9999", String(b.intentId)), null);
    });
  },
);
