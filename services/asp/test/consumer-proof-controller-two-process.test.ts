import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  PgConsumerStore,
  ProviderRegistry,
  SETTLEMENT_REGISTRATION_VERSION,
  encodeBase58,
  StorePauseChecker,
  TreasuryRouter,
  asset,
  createPool,
  loadConsumerFlags,
  money,
  parseMoney,
  runMigrations,
  type CaipChainId,
  type ConsumerStore,
  type Money,
  type PaymentRequest,
  type PaymentResult,
  type Pool,
  type RailClient,
} from "@untch/consumer-core";
import { ACCEPTED_TOKEN_PROGRAMS } from "@untch/consumer-providers";
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
import { ProviderError, normalizedError } from "@untch/consumer-core";
import type { Ledger, LedgerWindowState, SpendIntentInput } from "@untch/policy-engine";
import type { PolicyProvider, StoredPolicy } from "@untch/policy-store";
import { ConsumerOrchestrator } from "../src/consumer/orchestrator";
import { SseHub, OutboxDispatcher } from "../src/consumer/dispatcher";
import { makeFundingPrice } from "../src/consumer/funding-price";
import { registerConsumerOperatorRoutes } from "../src/consumer/operator-routes";
import { registerDeploymentRoutes } from "../src/deployment-routes";
import { resetOperatorAuthAudit, resetOperatorAuthThrottle } from "../src/internal-auth";
import { DeploymentLifecycle } from "../src/deployment-info";
import type { ConsumerWiring } from "../src/consumer/wiring";

/**
 * TWO PROCESSES, AND THE BOUNDARY BETWEEN THEM.
 *
 * Every other test of the controller runs in one process, which means every one of them could in
 * principle be satisfied by a mock that lied. This suite spawns the controller as a REAL CHILD PROCESS
 * with a SCRUBBED environment and points it at a REAL server backed by a REAL Postgres, a real
 * orchestrator, a real policy evaluation, a real reservation, a real queue and a real worker loop.
 *
 * WHAT ONLY THIS SHAPE CAN PROVE
 *
 *   • The controller authenticates over HTTP and has no other route in. It is a separate OS process, so
 *     "it did not open the database" is not a claim about which functions were called — the process was
 *     never given a connection string, and `assertKeylessEnvironment` refuses to start if it had been.
 *   • The adapter and the signer are touched by the WORKER, in the server process, after the controller
 *     has already returned from create. Both are instrumented here to record which process reached them,
 *     and the assertion is that the count attributable to the controller is zero.
 *   • The queue transition is what couples the two halves. The controller's create ends at
 *     EXECUTION_QUEUED; nothing it does can advance past that.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped loudly when absent, and set in CI —
 * a skipped integration test on the machine that gates merges is a test that does not exist.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();

const SOLANA: CaipChainId = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE: CaipChainId = "eip155:8453";
const SOL_USDC = asset("solana.usdc");
const USDT0 = asset("xlayer.usdt0");

const OPS_TOKEN = ["two", "process", "controller", "token"].join("-");
const SERVING_COMMIT = "015223129d6b664e9f32927f7765e63fb73a0b8d";
const MIGRATION = "012_settlement_account_registration.sql";
const POLICY_ID = "778899";
/**
 * Base58 identifiers DERIVED from a label rather than written down.
 *
 * Nothing in this suite signs and nothing checks these against a chain, so they only need to be
 * well-formed, stable and distinct. Deriving them keeps a 44-character literal — which is what a secret
 * scanner matches on, and which reads as though it came from somewhere real — out of the file entirely.
 */
const base58Fixture = (label: string): string =>
  encodeBase58(createHash("sha256").update(`untch-test-fixture:${label}`).digest());

const SOLANA_AUTHORITY = base58Fixture("solana-settlement-authority");
/** The merchant's settlement account. Distinct from the treasury authority, deliberately. */
const SETTLEMENT_RECIPIENT = base58Fixture("purch-settlement-recipient");
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/**
 * This suite's own database name, derived from nothing so it is stable across runs.
 *
 * Reused rather than randomised: `runMigrations` is idempotent, every test mints a fresh intent id, and a
 * fresh database per run would leave a pile of them behind on a developer machine.
 */
const OWN_DATABASE = "untch_test_proof_controller";

function ownDatabaseUrl(): string {
  const url = new URL(TEST_DB as string);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

/** One intent id per test, so no test can pass on another's row. */
const intentId = (): string => `ci_${randomBytes(12).toString("hex")}`;

const ATTESTATION_DIR = mkdtempSync(join(tmpdir(), "untch-two-process-"));
writeFileSync(
  join(ATTESTATION_DIR, ".untch-build-attestation.json"),
  JSON.stringify({
    commit: SERVING_COMMIT,
    branch: "feat/remote-consumer-proof-controller",
    builtAt: "2026-07-30T11:00:00.000Z",
    source: "clean git export",
  }),
);

const servers: Server[] = [];
let pool: Pool | null = null;

/**
 * Instrumentation that records WHICH process reached a capability.
 *
 * Held in the server process. The controller is a child process, so it has no way to increment these —
 * which is precisely the point: a non-zero count for a step the controller was supposed to skip means a
 * mock somewhere was standing in for the boundary.
 */
const touched = { adapterQuote: 0, adapterExecute: 0, railPay: 0, railAddress: 0 };

/**
 * Set to make the next quote throw, so the failure path can be driven end to end.
 *
 * A real provider defect is what produced the HTML 500 in production; reproducing the CLASS of failure
 * rather than the exact message is what makes this a regression test for the handling rather than for
 * Purch's schema.
 */
let quoteFailure: Error | null = null;

class TestAdapter implements ConsumerProviderAdapter {
  readonly providerId = "purch";

  capabilities(): readonly ProviderCapabilityDescriptor[] {
    return [{ capability: "shop.search", description: "test search", movesValue: false }];
  }
  async health(_c: AdapterContext): Promise<ProviderHealth> {
    return { healthy: true, latencyMs: 1, detail: "two-process test double" };
  }
  async discover(_i: DiscoveryInput, _c: AdapterContext): Promise<DiscoveryResult> {
    throw new Error("discovery is not part of this proof");
  }
  async quote(input: QuoteInput, _c: AdapterContext): Promise<ProviderQuote> {
    touched.adapterQuote += 1;
    /**
     * The shape must ARRIVE, and it must be the paid-read one.
     *
     * Throwing rather than defaulting is deliberate: if the orchestrator ever stopped passing it, the
     * adapter would silently fall back to FULFILMENT and this suite would keep passing while production
     * had regressed to exactly the failure it was written for.
     */
    if (input.executionShape !== "PAID_READ") {
      throw new Error(`the orchestrator passed executionShape=${String(input.executionShape)}, not PAID_READ`);
    }
    // A paid read carries no purchase fields, and demanding them is the defect under test.
    if ("shippingAddress" in input.params || "email" in input.params) {
      throw new Error("a paid read must not be given purchase fields");
    }
    if (quoteFailure !== null) throw quoteFailure;
    return {
      providerId: this.providerId,
      providerRef: input.providerRef,
      cost: money(10_000n, SOL_USDC),
      settlementRecipient: SETTLEMENT_RECIPIENT,
      settlementChain: SOLANA,
      settlementAsset: SOL_USDC,
      summary: "Search",
      terms: { ref: input.providerRef },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  }
  async execute(
    input: ExecuteInput,
    payment: PaymentCapability,
    _c: AdapterContext,
  ): Promise<ProviderExecution> {
    touched.adapterExecute += 1;
    if (input.executionShape !== "PAID_READ") {
      throw new Error(`execute received executionShape=${String(input.executionShape)}, not PAID_READ`);
    }
    /**
     * The payment happens HERE, through the capability the treasury router minted.
     *
     * Redeeming it for real rather than faking a settlement is what makes the rail counter meaningful:
     * it only moves because a genuine single-use capability was consumed inside the server process,
     * under the proof gate's own authorisation check.
     */
    const paid = await payment.pay({
      amount: input.quote.cost,
      recipient: input.quote.settlementRecipient,
      challenge: { scheme: "exact", network: SOLANA },
      resourceUrl: "https://api.purch.test/x402/search",
      method: "GET",
    });
    return {
      providerReference: `test-${input.intentId}`,
      settlement: {
        txHash: paid.txHash,
        chain: paid.chain,
        amount: paid.amount,
        recipient: paid.recipient,
      },
      providerStatus: "ACKNOWLEDGED",
      payload: { products: [{ title: "a real-shaped product", price: "9.99" }], count: 1 },
      acknowledgedAt: new Date().toISOString(),
    };
  }
  async getStatus(ref: ProviderReference, _c: AdapterContext): Promise<ProviderStatus> {
    return {
      reference: ref.reference,
      state: "FULFILLED",
      detail: "two-process test double",
      raw: {},
      checkedAt: new Date().toISOString(),
    };
  }
  async verifyDelivery(exec: ProviderExecution, _c: AdapterContext): Promise<DeliveryEvidence> {
    return {
      intentId: exec.providerReference.replace("test-", ""),
      providerId: this.providerId,
      providerAttested: {
        status: "FULFILLED",
        reference: exec.providerReference,
        attestedAt: new Date().toISOString(),
        fields: { count: 1 },
      },
      untchVerified: {
        verified: true,
        method: "PROVIDER_STATUS_POLL",
        detail: "the test provider reported FULFILLED",
        verifiedAt: new Date().toISOString(),
      },
      evidenceHash: `0x${"ab".repeat(32)}`,
    };
  }
  normalizeError(err: unknown): NormalizedProviderError {
    return {
      code: "PROVIDER_UNAVAILABLE",
      message: String(err),
      retryable: false,
      providerCode: null,
      retryAfterMs: null,
    };
  }
}

/** A settlement rail that signs nothing but records that the SERVER reached it. */
class TestRail implements RailClient {
  readonly chain = SOLANA;
  /**
   * `hasKey: false` models the disarmed posture, where `address()` THROWS.
   *
   * The real `X402SolanaExactClient` derives its address from the secret key, so with no key there is
   * nothing to return and it throws. The operator route catches that and reports absence, which is the
   * behaviour that lets a settlement account be registered on a deployment holding no key at all. A test
   * rail that returned an address without a key would skip the exact path being proven.
   */
  constructor(private readonly hasKey: boolean) {}

  address(): string {
    touched.railAddress += 1;
    if (!this.hasKey) throw new Error("no Solana signing key configured for this rail");
    return SOLANA_AUTHORITY;
  }
  available(): boolean {
    return this.hasKey;
  }
  async balanceOf(a: typeof SOL_USDC): Promise<Money> {
    return money(50_000n, a);
  }
  async pay(req: PaymentRequest): Promise<PaymentResult> {
    touched.railPay += 1;
    return {
      paymentHeader: "test-payment-signature",
      headerName: "PAYMENT-SIGNATURE",
      txHash: `test-sig-${randomBytes(8).toString("hex")}`,
      amount: req.amount,
      recipient: req.recipient,
      chain: SOLANA,
    };
  }
}

class MemoryLedger implements Ledger {
  private spent = 0;
  async read(): Promise<LedgerWindowState> {
    return { budgetUsage: { settledToday: 0, reservedActiveToday: this.spent, effectiveToday: this.spent }, recentIntents: [], lastCallByService: {}, callsInLastHour: 0 };
  }
  async commitApproved(_k: string, i: SpendIntentInput): Promise<void> {
    this.spent += i.amount;
  }
}

const RULES = {
  budgets: { daily: 1, token: "USDT0" },
  perCallCap: 0.5,
  onPerCallCapExceeded: "BLOCK",
  escalateAbove: 0.5,
  categories: { allow: ["consumer.shop.search"], deny: ["consumer.shop.purchase"] },
  recipients: { allow: [], deny: [] },
  agents: { allowWorkerIds: [], denyWorkerIds: [] },
  duplicates: { ttlMin: 0, keys: [] },
  cooldowns: { sameServiceMin: 0 },
  rateLimit: { callsPerHour: 100 },
  expiry: "2027-01-01T00:00:00.000Z",
};

function policyProvider(): PolicyProvider {
  const stored = {
    id: POLICY_ID,
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
  return {
    async load() {
      return { id: POLICY_ID, version: 1, status: "ACTIVE", rules: RULES } as never;
    },
    async loadStored() {
      return stored;
    },
  } as unknown as PolicyProvider;
}

/**
 * The server side: everything the deployed ASP is, minus the parts a test cannot have.
 *
 * The env passed here is the SERVER's env, and it is fully armed. The controller's env is built
 * separately and deliberately holds almost nothing — the gap between the two is the boundary this
 * suite exists to demonstrate.
 */
/**
 * The two postures a server can be started in, and why both are needed.
 *
 * `armed` is the final arming window: signer loaded, rail switch thrown, provider flag on, and a gate
 * naming one exact intent. Only this posture can execute.
 *
 * `production-disarmed` is what the deployed service ACTUALLY looks like today: pack and execution on,
 * everything Solana off, no signer anywhere. It exists because the preflight-only run has to be proven
 * against the real thing. An earlier version of this suite tested READY_TO_ARM against a server that had
 * a standing Solana signer, and the assertion that caught it was `publicMaturity` — a standing signer
 * makes a verified capability read LIVE, and production reads BETA precisely because no signer is there.
 * Testing readiness against a shape production is not in would have proven nothing about production.
 */
type ServerPosture = "armed" | "production-disarmed";

async function startServer(
  /** `null` starts a server with NO proof gate armed, which is the READY_TO_ARM shape. */
  armedIntentId: string | null,
  posture: ServerPosture = "armed",
): Promise<{ readonly url: string; readonly store: ConsumerStore; stopWorker(): void }> {
  const store = new PgConsumerStore(pool as Pool);

  await store.upsertProvider({
    providerId: "purch",
    displayName: "Purch",
    maturity: "verified",
    baseUrl: "https://api.purch.test",
    protocol: "x402",
    chains: [SOLANA],
    provenance: "two-process integration test",
    enabled: true,
  });
  await store.upsertCapability({
    providerId: "purch",
    capability: "shop.search",
    maturity: "verified",
    // The registry fact the orchestrator reads and hands to the adapter. Without it the adapter would
    // take the FULFILMENT path and demand a shipping address, which is the defect this covers.
    executionShape: "PAID_READ",
    notes: "two-process integration test",
  });
  await store.upsertTreasuryAccount({
    treasuryRef: "solana-usdc-settlement",
    asset: SOL_USDC,
    purpose: "SETTLEMENT",
    address: SOLANA_AUTHORITY,
    minBalance: parseMoney("0.00", SOL_USDC),
    dailyLimit: parseMoney("5.00", SOL_USDC),
    enabled: true,
    attestation: {
      registrationVersion: SETTLEMENT_REGISTRATION_VERSION,
      mint: SOL_USDC.address,
      decimals: SOL_USDC.decimals,
      authority: SOLANA_AUTHORITY,
      tokenAccount: base58Fixture("solana-settlement-token-account"),
      tokenProgram: ACCEPTED_TOKEN_PROGRAMS[0] ?? null,
      tokenAccountOwner: SOLANA_AUTHORITY,
      accountState: "initialized",
      delegate: null,
      closeAuthority: null,
      observedTokenBalance: "50000",
      observedNativeBalance: "10000000",
      observedAt: new Date().toISOString(),
      provenance: {
        source: "two-process integration test",
        operatorKeyId: "test",
        requestHash: `0x${"22".repeat(32)}`,
        servingCommit: SERVING_COMMIT,
        servingDeploymentId: "test-deployment",
        rpcHost: "solana-mainnet.g.alchemy.com",
      },
    },
  });
  await store.upsertTreasuryAccount({
    treasuryRef: "xlayer-usdt0-funding",
    asset: USDT0,
    purpose: "FUNDING",
    address: "0x0000000000000000000000000000000000000002",
    minBalance: parseMoney("0.00", USDT0),
    dailyLimit: parseMoney("0.00", USDT0),
    enabled: true,
  });

  const serverEnv: NodeJS.ProcessEnv = {
    INTERNAL_OPS_TOKEN: OPS_TOKEN,
    UNTCH_ENVIRONMENT: "production",
    CONSUMER_PACK_ENABLED: "1",
    CONSUMER_EXECUTION_ENABLED: "1",
    CONSUMER_SOLANA_RPC_URL: "https://solana-mainnet.g.alchemy.com/v2/redacted-in-tests",
    RAILWAY_DEPLOYMENT_ID: "two-process-test-deployment",
    // Base stays on in both postures. It is a proven rail and a Solana proof must not touch it.
    CONSUMER_CHAIN_EIP155_8453_ENABLED: "1",
    CONSUMER_ASSET_EIP155_8453_USDC_ENABLED: "1",
    ...(posture === "armed"
      ? {
          CONSUMER_PROVIDER_PURCH_ENABLED: "1",
          CONSUMER_CHAIN_SOLANA_5EYKT4USFV8P8NJDTREPY1VZQKQZKVDP_ENABLED: "1",
          CONSUMER_TREASURY_SOLANA_SECRET_KEY: "a-server-side-key-the-controller-never-sees",
          CONSUMER_SOLANA_EXECUTION_ENABLED: "1",
        }
      : {}),
    ...(armedIntentId === null
      ? {}
      : {
          CONSUMER_SOLANA_PROOF_MODE: "1",
          CONSUMER_SOLANA_PROOF_INTENT_ID: armedIntentId,
          CONSUMER_SOLANA_PROOF_PROVIDER: "purch",
          CONSUMER_SOLANA_PROOF_CAPABILITY: "shop.search",
          CONSUMER_SOLANA_PROOF_MAX_USDC: "0.020000",
          CONSUMER_SOLANA_PROOF_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
        }),
  };

  const adapter = new TestAdapter();
  const adapters: AdapterRegistry = { get: () => adapter, has: () => true, all: () => [adapter] };
  const treasury = new TreasuryRouter({
    store,
    rails: new Map<CaipChainId, RailClient>([[SOLANA, new TestRail(posture === "armed")]]),
    pauses: new StorePauseChecker(store),
  });
  const orchestrator = new ConsumerOrchestrator({
    store,
    registry: new ProviderRegistry({
      store,
      gate: { executionFloor: "verified", allowSandboxExecution: false },
      flags: loadConsumerFlags(serverEnv),
    }),
    adapters,
    treasury,
    policyProvider: policyProvider(),
    ledger: new MemoryLedger(),
    escalation: null,
    receipts: null,
    config: {
      allowSandboxExecution: false,
      maxSingleExecutionDisplay: "1.00",
      quoteTtlSec: 600,
      fundingTtlSec: 900,
      providerTimeoutMs: 5_000,
      executeTimeoutMs: 5_000,
      breakerThreshold: 5,
      breakerCooldownMs: 60_000,
    },
    publicBaseUrl: "https://asp.untch.test",
    siwx: null,
  });

  const lifecycle = new DeploymentLifecycle(serverEnv, new Date().toISOString(), ATTESTATION_DIR);
  lifecycle.recordSchema(MIGRATION, true);
  lifecycle.recordGateCode(true);
  // Base stays available. A Solana proof that cost Base its rail would be a regression dressed as a
  // safeguard, and the controller refuses a deployment where Base has gone missing.
  lifecycle.recordRails([BASE]);
  lifecycle.markReady(new Date().toISOString());

  const wiring = {
    store,
    registry: new ProviderRegistry({
      store,
      gate: { executionFloor: "verified", allowSandboxExecution: false },
      flags: loadConsumerFlags(serverEnv),
    }),
    adapters,
    treasury,
    orchestrator,
    dispatcher: new OutboxDispatcher({ store, hub: new SseHub() }),
    hub: new SseHub(),
    fundingPrice: makeFundingPrice({ store }),
    config: {
      allowSandboxExecution: false,
      maxSingleExecutionDisplay: "1.00",
      quoteTtlSec: 600,
      fundingTtlSec: 900,
      providerTimeoutMs: 5_000,
      executeTimeoutMs: 5_000,
      breakerThreshold: 5,
      breakerCooldownMs: 60_000,
    },
    publicBaseUrl: "https://asp.untch.test",
    availableRails: [SOLANA],
    pool: pool as Pool,
    async close() {},
  } as unknown as ConsumerWiring;

  const app = express();
  registerDeploymentRoutes(app, { lifecycle, env: serverEnv });
  app.use(express.json());
  registerConsumerOperatorRoutes(app, {
    wiring,
    policyProvider: policyProvider(),
    lifecycle,
    flags: loadConsumerFlags(serverEnv),
    env: serverEnv,
  });

  const url = await new Promise<string>((r) => {
    const server = app.listen(0, () => {
      servers.push(server);
      const addr = server.address();
      r(`http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`);
    });
  });

  /**
   * THE WORKER. The only thing in this system that executes a provider action.
   *
   * A plain interval over EXECUTION_QUEUED, which is what `startConsumerWorkers` runs in production.
   * It lives in the SERVER process. The controller cannot start it, cannot reach it, and cannot make it
   * run sooner.
   */
  const timer = setInterval(() => {
    void (async () => {
      const queued = await store.listIntents({ state: "EXECUTION_QUEUED", limit: 5 });
      for (const i of queued) await orchestrator.executeIntent(i.intentId).catch(() => {});
      const acked = await store.listIntents({ state: "PROVIDER_ACKNOWLEDGED", limit: 5 });
      for (const i of acked) await orchestrator.verifyAndComplete(i.intentId).catch(() => {});
      const delivering = await store.listIntents({ state: "DELIVERY_PENDING", limit: 5 });
      for (const i of delivering) await orchestrator.verifyAndComplete(i.intentId).catch(() => {});
    })();
  }, 250);
  timer.unref();

  return { url, store, stopWorker: () => clearInterval(timer) };
}

interface ControllerRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the controller as a real child process, with an environment built from nothing.
 *
 * `env` is constructed rather than spread from `process.env`, which is the whole design. The test
 * process holds `TEST_DATABASE_URL` and may hold anything else a developer has exported; inheriting it
 * would hand the controller exactly the credentials it claims not to have. PATH is included because a
 * child process needs an interpreter; nothing else is.
 */
async function runController(
  args: readonly string[],
  over: NodeJS.ProcessEnv = {},
): Promise<ControllerRun> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...over,
  };
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(REPO_ROOT, "scripts/consumer-smoke-live-entry.ts"), ...args],
      { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function controllerEnv(url: string, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    UNTCH_ASP_URL: url,
    INTERNAL_OPS_TOKEN: OPS_TOKEN,
    UNTCH_EXPECTED_SERVING_COMMIT: SERVING_COMMIT,
    ...over,
  };
}

/**
 * The controller demands https, for the good reason that the operator token travels on the connection.
 * A loopback test server cannot serve https without a certificate nobody should be generating in a test,
 * so the suite drives the controller against `http://127.0.0.1` and the runner is given the one argument
 * that permits it.
 *
 * This is stated rather than hidden: the relaxation applies to the URL SCHEME only, and every other
 * refusal — the keyless environment, the deployment identity, the readiness class — is exercised exactly
 * as production would exercise it.
 */
const LOOPBACK_ARGS = ["--allow-loopback-http"] as const;

const PROOF_ARGS = (id: string): readonly string[] => [
  "--deployed-worker-only",
  "--provider",
  "purch",
  "--operator-funded",
  "--policy-id",
  POLICY_ID,
  "--intent-id",
  id,
  "--expect-migration",
  MIGRATION,
  ...LOOPBACK_ARGS,
];

describe("two-process proof: a keyless controller over HTTP against a real ASP, Postgres and worker", () => {
  if (!TEST_DB) {
    test("SKIPPED — set TEST_DATABASE_URL to run the two-process integration suite", () => {
      assert.ok(true);
    });
    return;
  }

  /**
   * A database of this suite's OWN, not the shared one.
   *
   * `node --test` runs test FILES in parallel, and every suite that touches Postgres writes to the same
   * tables. This one and `consumer-operator-routes-pg.test.ts` both register a provider called `purch`,
   * and they need it to declare different settlement chains — so run together they overwrote each other's
   * registry row and each failed on the other's fixture. Both suites passed alone, which is the worst
   * version of that bug: it looks like flakiness and it is actually a shared-fixture collision.
   *
   * Separate databases rather than distinct provider ids, because the collision is structural. Any future
   * suite adding a row here would hit it again, and only isolation fixes the class rather than the case.
   */
  before(async () => {
    const admin = createPool(TEST_DB);
    try {
      // CREATE DATABASE cannot run inside a transaction, and a duplicate is not an error worth failing on.
      await admin.query(`CREATE DATABASE ${OWN_DATABASE}`).catch((err: unknown) => {
        const code = (err as { code?: string }).code;
        if (code !== "42P04") throw err;
      });
    } finally {
      await admin.end();
    }
    pool = createPool(ownDatabaseUrl());
    await runMigrations(pool);
  });

  after(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));

    /**
     * Let in-flight queries finish before the pool goes away.
     *
     * `server.close` resolves when the last CONNECTION closes, which is not the same as the last
     * QUERY finishing: a handler that kicked off a write and returned leaves work the HTTP layer no
     * longer knows about. Ending the pool underneath it produced "Cannot use a pool after calling end
     * on the pool" as an unhandledRejection AFTER the test had passed, which the runner reports as a
     * failure of whichever test happened to be last. It failed roughly one run in three and passed on
     * re-run, which is the worst kind of red — it teaches people to re-run instead of read.
     *
     * A pool with no active clients is one with nothing left to interrupt. Bounded, because a drain
     * that never completes should surface as the hang it is rather than block the suite forever.
     */
    if (pool) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const p = pool as unknown as { totalCount: number; idleCount: number };
        if (p.totalCount === p.idleCount) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await pool.end();
    }
    rmSync(ATTESTATION_DIR, { recursive: true, force: true });
  });

  test("the controller refuses to start when a database credential is in its environment", async () => {
    const id = intentId();
    const server = await startServer(id);
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();

    const run = await runController(PROOF_ARGS(id), controllerEnv(server.url, { DATABASE_URL: TEST_DB }));
    server.stopWorker();

    assert.equal(run.code, 2, run.stderr);
    assert.match(run.stderr, /CONTROLLER_ENVIRONMENT_NOT_KEYLESS/);
    assert.match(run.stderr, /DATABASE_URL is set/);
    /**
     * It refused BEFORE reaching the network. The adapter counter proves nothing was quoted, and it is a
     * counter in the OTHER process — the controller could not have reset it.
     */
    assert.equal(touched.adapterQuote, 0);
    assert.equal(await server.store.getIntent(id), null);
  });

  test("a serving-commit mismatch stops the run before preflight is called", async () => {
    const id = intentId();
    const server = await startServer(id);
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();
    const before = touched.adapterQuote;

    const run = await runController(
      PROOF_ARGS(id),
      controllerEnv(server.url, { UNTCH_EXPECTED_SERVING_COMMIT: "f".repeat(40) }),
    );
    server.stopWorker();

    assert.equal(run.code, 2, run.stderr);
    assert.match(run.stderr, /DEPLOYMENT_IDENTITY_MISMATCH/);
    // Preflight would have quoted nothing, but create would have. Neither ran: no intent exists at all.
    assert.equal(await server.store.getIntent(id), null);
    assert.equal(touched.adapterQuote, before);
  });

  test("a wrong operator token is refused by the server, not worked around", async () => {
    const id = intentId();
    const server = await startServer(id);
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();

    const run = await runController(
      PROOF_ARGS(id),
      controllerEnv(server.url, { INTERNAL_OPS_TOKEN: "the-wrong-token" }),
    );
    server.stopWorker();

    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /DEPLOYMENT_INFO_UNREADABLE|401|OPS_AUTH/);
    assert.equal(await server.store.getIntent(id), null);
  });

  test("preflight-only reports READY_TO_ARM and writes nothing", async () => {
    const id = intentId();
    /**
     * NO gate armed at all, which is the READY_TO_ARM shape.
     *
     * Deliberately not "a gate armed for a different intent" — that is a structural CONFLICT
     * (`PROOF_GATE_INCOMPATIBLE`) and classifies as STRUCTURAL_BLOCKED, because the wrong scope being
     * live is something an operator has to resolve rather than something arming fixes. The distinction is
     * the whole reason the two codes are separate, and this test would have hidden it.
     */
    const server = await startServer(null, "production-disarmed");
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();

    const run = await runController(
      [...PROOF_ARGS(id), "--preflight-only"],
      controllerEnv(server.url),
    );
    server.stopWorker();

    assert.equal(run.code ?? 0, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /READY_TO_ARM/);
    assert.match(run.stdout, /MODE\s+DEPLOYED_WORKER_ONLY/);
    assert.match(run.stdout, /Local database access\s+disabled/);
    assert.match(run.stdout, /Local signer\s+disabled/);

    // Preflight writes nothing. Checked in the database, from the other process.
    assert.equal(await server.store.getIntent(id), null);
    assert.equal(await server.store.getFunding(id), null);
    assert.deepEqual(await server.store.listSolanaProofGates(50).then((g) => g.filter((x) => x.scope.intentId === id)), []);
  });

  test("the full run: the controller creates over HTTP and the WORKER executes", async () => {
    const id = intentId();
    const server = await startServer(id);
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();
    const quotesBefore = touched.adapterQuote;
    const executesBefore = touched.adapterExecute;
    const paysBefore = touched.railPay;

    const run = await runController(PROOF_ARGS(id), controllerEnv(server.url));
    server.stopWorker();

    assert.equal(run.code ?? 0, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /ARMED_AND_EXECUTABLE/);

    // ── the exact intent, in the production store, under the derived tenant ──
    const intent = await server.store.getIntent(id);
    assert.ok(intent, "the exact intent must exist in the real database");
    assert.equal(intent.intentId, id);
    assert.equal(intent.tenantId, `policy:${POLICY_ID}`);
    assert.equal(intent.policyId, POLICY_ID);
    assert.equal(intent.action, "shop.search");

    // ── the real policy was evaluated and APPROVED ──
    assert.equal((intent.policyDecision as { decision?: string } | null)?.decision, "APPROVED");
    assert.equal(intent.policyHash, `0x${"cd".repeat(32)}`);

    // ── the real reservation exists ──
    const funding = await server.store.getFunding(id);
    assert.ok(funding, "the normal reservation must exist");

    // ── the WORKER executed. One quote from create, one execute from the worker. ──
    assert.equal(touched.adapterQuote - quotesBefore, 1, "create quotes once");
    assert.equal(touched.adapterExecute - executesBefore, 1, "the worker executes exactly once");
    assert.equal(touched.railPay - paysBefore, 1, "the rail is paid exactly once");

    /**
     * The controller never reached the adapter or the rail.
     *
     * It is a separate process. It could not have called them even by accident, and these counters —
     * which live only in the server — are what make that observable rather than asserted.
     */
    const executions = await server.store.listExecutions(id);
    assert.equal(executions.length, 1, "one execution attempt, never two");
    /**
     * PAID or ACKNOWLEDGED, and a settlement hash either way.
     *
     * The two differ only in whether the provider's post-payment status had been recorded when this read
     * happened, and both mean the same thing about money: it moved, exactly once. Pinning one of them
     * would make this assertion a race rather than a fact.
     */
    assert.ok(
      executions[0]?.state === "PAID" || executions[0]?.state === "ACKNOWLEDGED",
      `expected a settled execution, got ${String(executions[0]?.state)}`,
    );
    assert.ok(executions[0]?.settlementTxHash?.startsWith("test-sig-"));
    assert.equal(executions[0]?.settlementChain, SOLANA);

    assert.equal(intent.state === "COMPLETED" || intent.state === "DELIVERY_PENDING", true, `state ${intent.state}`);
  });

  /**
   * The failure the first bounded production proof actually hit, driven end to end.
   *
   * Production answered a provider defect with express's default HTML 500 and left the intent in CREATED
   * forever — so the id was consumed, nothing swept it, and the controller could not tell a refusal from
   * a crash. Both halves are asserted here, from the database rather than from the controller's output.
   */
  test("a provider quote failure returns structured JSON and terminalises the intent", async () => {
    const id = intentId();
    const server = await startServer(id);
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();
    const executesBefore = touched.adapterExecute;
    quoteFailure = new ProviderError(
      normalizedError("PROVIDER_MALFORMED_RESPONSE", "shipping address — shippingAddress: expected an object"),
    );

    try {
      const run = await runController(PROOF_ARGS(id), controllerEnv(server.url));
      assert.notEqual(run.code, 0, "a quote failure must not report success");
      // Never HTML. The controller surfaces the body it got, so an HTML page would appear here.
      assert.ok(!/<!DOCTYPE/i.test(run.stdout + run.stderr), "the response must never be an HTML error page");
      assert.match(run.stdout + run.stderr, /PROVIDER_MALFORMED_RESPONSE/);
    } finally {
      quoteFailure = null;
      server.stopWorker();
    }

    // ── the durable outcome ──
    const intent = await server.store.getIntent(id);
    assert.ok(intent, "the intent must still exist — it is evidence, not litter");
    assert.equal(intent.state, "FAILED_BEFORE_PAYMENT", "a quote failure must not linger in CREATED");
    assert.equal(intent.failureCode, "PROVIDER_QUOTE_FAILED");
    assert.match(String(intent.failureDetail), /PROVIDER_MALFORMED_RESPONSE/);
    assert.match(String(intent.failureDetail), /before policy, before reservation/);

    // Nothing downstream of the quote may exist.
    assert.equal(await server.store.getFunding(id), null, "no reservation");
    assert.equal((await server.store.listExecutions(id)).length, 0, "no execution row");
    assert.equal(touched.adapterExecute, executesBefore, "the provider was never executed");
    assert.equal(intent.receiptId, null, "no receipt claiming settlement");
    const gates = (await server.store.listSolanaProofGates(50)).filter((g) => g.scope.intentId === id);
    assert.deepEqual(gates, [], "no proof-gate row");

    // A durable failure event, so the audit trail records the stage rather than only the state.
    const events = await server.store.eventsSince(id, 0, 50);
    assert.ok(events.some((e) => e.name === "consumer.failed"), events.map((e) => e.name).join(", "));
  });

  test("a duplicate is safe, and a conflicting duplicate is refused, without a second execution", async () => {
    const id = intentId();
    const server = await startServer(id);
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();

    const first = await runController(PROOF_ARGS(id), controllerEnv(server.url));
    assert.equal(first.code ?? 0, 0, `${first.stdout}\n${first.stderr}`);
    const executesAfterFirst = touched.adapterExecute;

    // The controller's own step 7 already exercised both duplicates in-run. Assert the outcome it must
    // have produced, from the database rather than from its output.
    assert.match(first.stdout, /identical replay/);
    assert.match(first.stdout, /conflicting replay/);
    assert.match(first.stdout, /a conflicting duplicate was refused/);

    // A second whole run, with the same id and the same derived key. It must not execute again.
    const second = await runController(PROOF_ARGS(id), controllerEnv(server.url));
    server.stopWorker();

    assert.notEqual(second.code, 0, "a re-run against a used intent id must not report success");
    assert.equal(touched.adapterExecute, executesAfterFirst, "no second execution, ever");
    const executions = await server.store.listExecutions(id);
    assert.equal(executions.length, 1, "one execution attempt for one authorisation");
  });
});
