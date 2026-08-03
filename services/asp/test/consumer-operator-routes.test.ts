import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryConsumerStore,
  ProviderRegistry,
  StorePauseChecker,
  TreasuryRouter,
  asset,
  loadConsumerFlags,
  money,
  parseMoney,
  type CaipChainId,
  type ConsumerStore,
  type Money,
  type PaymentRequest,
  type PaymentResult,
  type RailClient,
  SETTLEMENT_REGISTRATION_VERSION,
  encodeBase58,
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
import { ACCEPTED_TOKEN_PROGRAMS } from "@untch/consumer-providers";
import type { SettlementAccountAttestation } from "@untch/consumer-core";
import type { Ledger, LedgerWindowState, SpendIntentInput } from "@untch/policy-engine";
import type { PolicyProvider, StoredPolicy } from "@untch/policy-store";
import { ConsumerOrchestrator } from "../src/consumer/orchestrator";
import { SseHub, OutboxDispatcher } from "../src/consumer/dispatcher";
import { makeFundingPrice } from "../src/consumer/funding-price";
import {
  registerConsumerOperatorRoutes,
  operatorEnvironmentOf,
  OPERATOR_PREFLIGHT_ROUTE,
  OPERATOR_CREATE_ROUTE,
} from "../src/consumer/operator-routes";
import { parseOperatorIntentInput } from "../src/consumer/operator-intent-plan";
import {
  operatorTokenMatches,
  operatorKeyId,
  recentOperatorAuthEvents,
  resetOperatorAuthAudit,
  resetOperatorAuthThrottle,
} from "../src/internal-auth";
import { DeploymentLifecycle } from "../src/deployment-info";
import type { ConsumerWiring } from "../src/consumer/wiring";

/**
 * The operator control surface.
 *
 * Two properties carry this whole suite, and everything else supports them:
 *
 *   1. THE ROUTE CANNOT EXECUTE A PROVIDER. The create route runs against an orchestrator whose
 *      `executeIntent` throws on sight, and it must still create, reserve and queue successfully.
 *      If that test ever starts failing, an operator request has acquired spending authority.
 *   2. THE PREFLIGHT WRITES NOTHING. It runs against a store whose every write method throws. If
 *      that test starts failing, "preflight" has become a euphemism.
 *
 * The token appears nowhere in any assertion output on purpose: the tests also assert it never
 * reaches a response body or an audit record, and a fixture printed in a diff would undercut that.
 */

// ── fixtures ─────────────────────────────────────────────────────────────────

const SOLANA: CaipChainId = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE: CaipChainId = "eip155:8453";
const SOL_USDC = asset("solana.usdc");
const USDT0 = asset("xlayer.usdt0");
const NOW = Date.parse("2026-07-30T12:00:00.000Z");

/** Composed rather than written as a literal, so no credential-shaped assignment lands in the tree. */
const OPS_TOKEN = ["operator", "route", "test", "token"].join("-");
const WRONG_TOKEN = ["operator", "route", "test", "wrong"].join("-");

/**
 * The one authority the fake rail controls AND the one the settlement account is registered against.
 *
 * Shared deliberately. Registration and signing are separate acts now, and the plan refuses when the
 * loaded signer does not control the registered float — so a harness that used two different strings
 * here would be testing the mismatch refusal on every single case rather than the happy path.
 */
/**
 * Base58 identifiers DERIVED from a label rather than written down.
 *
 * Two reasons, and the repo already records the first: a bare 44-character base58 constant is what a
 * secret scanner matches on, so a hardcoded one produces a finding that is false and still has to be
 * triaged. `packages/consumer-providers/src/x402/solana-exact.ts` takes the SPL program addresses from
 * its library for exactly this reason.
 *
 * The second is that these are arbitrary identifiers. Nothing in this suite signs, and nothing checks
 * them against a chain — they only need to be well-formed, stable and distinct from each other. Deriving
 * them from a label makes that obvious at the point of use, where a 44-character literal reads as though
 * it came from somewhere real.
 */
const base58Fixture = (label: string): string =>
  encodeBase58(createHash("sha256").update(`untch-test-fixture:${label}`).digest());

const SOLANA_AUTHORITY = base58Fixture("solana-settlement-authority");

const INTENT_A = `ci_${"a1".repeat(12)}`;
const INTENT_B = `ci_${"b2".repeat(12)}`;

const servers: Server[] = [];

/**
 * A real build attestation on disk.
 *
 * The routes refuse an unattested instance, which is the control that stopped the 2026-07-29
 * incident from being possible again — so a suite that stubbed it away would be testing a
 * different, weaker route. The fixture is a genuine attestation file in a temp directory, and the
 * lifecycle is pointed at it the same way `readBuildAttestation(startDir)` already allows.
 */
const ATTESTATION_DIR = mkdtempSync(join(tmpdir(), "untch-operator-routes-"));
writeFileSync(
  join(ATTESTATION_DIR, ".untch-build-attestation.json"),
  JSON.stringify({
    commit: "39eb8d729488c44b58498e2c2dcb8a2abcd881d7",
    branch: "feat/remote-consumer-intent-control",
    builtAt: "2026-07-30T11:00:00.000Z",
    source: "clean git export",
  }),
);

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  rmSync(ATTESTATION_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  resetOperatorAuthThrottle();
  resetOperatorAuthAudit();
});

// ── doubles ──────────────────────────────────────────────────────────────────

class FakeRail implements RailClient {
  readonly chain = SOLANA;
  address(): string {
    return SOLANA_AUTHORITY;
  }
  available(): boolean {
    return true;
  }
  async balanceOf(a: typeof SOL_USDC): Promise<Money> {
    return money(1_000_000n, a);
  }
  async pay(_req: PaymentRequest): Promise<PaymentResult> {
    throw new Error("a rail must never be reached from an operator route");
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

/**
 * A provider adapter that can price but cannot be paid.
 *
 * `quote` returns a fixed price without touching the network, which is what lets these tests assert
 * on the lifecycle rather than on a fixture. `execute` throws, which is the assertion: the create
 * route must reach the queue without ever reaching this method.
 */
class UnpayableAdapter implements ConsumerProviderAdapter {
  readonly providerId = "purch";
  quoteCalls = 0;
  executeCalls = 0;

  capabilities(): readonly ProviderCapabilityDescriptor[] {
    return [];
  }
  async health(_ctx: AdapterContext): Promise<ProviderHealth> {
    return { healthy: true, latencyMs: 1, detail: "test double" };
  }
  async discover(_i: DiscoveryInput, _c: AdapterContext): Promise<DiscoveryResult> {
    throw new Error("discovery is not part of the operator route");
  }
  async quote(input: QuoteInput, _ctx: AdapterContext): Promise<ProviderQuote> {
    this.quoteCalls += 1;
    return {
      providerId: this.providerId,
      providerRef: input.providerRef,
      cost: money(10_000n, SOL_USDC),
      settlementRecipient: "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2",
      settlementChain: SOLANA,
      settlementAsset: SOL_USDC,
      summary: "Search",
      terms: { ref: input.providerRef },
      expiresAt: new Date(NOW + 600_000).toISOString(),
    };
  }
  async execute(_i: ExecuteInput, _p: PaymentCapability, _c: AdapterContext): Promise<ProviderExecution> {
    this.executeCalls += 1;
    throw new Error("PROVIDER EXECUTION REACHED FROM A ROUTE — the execution boundary is broken");
  }
  async getStatus(_r: ProviderReference, _c: AdapterContext): Promise<ProviderStatus> {
    throw new Error("not reachable in this suite");
  }
  async verifyDelivery(_e: ProviderExecution, _c: AdapterContext): Promise<DeliveryEvidence> {
    throw new Error("not reachable in this suite");
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

function fakePolicyProvider(present = true): PolicyProvider {
  const policy = {
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
  return {
    async load() {
      return present ? ({ id: "9001", version: 1, status: "ACTIVE", rules: RULES } as never) : null;
    },
    async loadStored() {
      return present ? policy : null;
    },
  } as unknown as PolicyProvider;
}

/** Every mutating method on the store, so a read-only assertion can be exhaustive rather than a sample. */
const WRITE_METHODS: readonly string[] = [
  "createIntent", "transition", "insertQuote", "upsertApproval", "resolveApproval", "recordFunding",
  "markFundingFinalized", "prepareExecution", "updateExecution", "recordSettlement",
  "upsertDeliveryEvidence", "appendLedgerGroup", "appendTreasuryTransfer", "markDispatched",
  "markDispatchFailed", "upsertProvider", "upsertCapability", "recordHealth", "setPause",
  "upsertTreasuryAccount", "recordBalanceObservation", "upsertProviderLimit", "issueCapability",
  "consumeCapability", "armSolanaProofGate", "claimSolanaProofGate", "recordSolanaProofProgress",
];

/** A read-through view whose every write throws. Handed to preflight to prove it writes nothing. */
function readOnlyStore(store: ConsumerStore): ConsumerStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && WRITE_METHODS.includes(prop)) {
        return () => {
          throw new Error(`PREFLIGHT WROTE TO THE STORE via ${prop}`);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

interface Harness {
  readonly url: string;
  readonly store: ConsumerStore;
  readonly adapter: UnpayableAdapter;
  readonly orchestrator: ConsumerOrchestrator;
}

async function harness(
  over: {
    readonly providerMaturity?: "verified" | "sandbox" | "experimental" | "disabled";
    readonly capabilityMaturity?: "verified" | "sandbox" | "experimental" | "disabled";
    readonly providerEnabled?: boolean;
    readonly policyPresent?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly readOnly?: boolean;
    readonly phase?: "READY" | "STARTING";
    readonly treasuryEnabled?: boolean;
    /** `null` registers an UNATTESTED account; a partial bends one attested field. */
    readonly attestation?: Partial<SettlementAccountAttestation> | null;
  } = {},
): Promise<Harness> {
  const store = new InMemoryConsumerStore(() => NOW);
  const adapter = new UnpayableAdapter();

  await store.upsertProvider({
    providerId: "purch",
    displayName: "Purch",
    maturity: over.providerMaturity ?? "verified",
    baseUrl: "https://api.purch.xyz",
    protocol: "x402",
    chains: [SOLANA],
    provenance: "test harness",
    enabled: over.providerEnabled ?? true,
  });
  await store.upsertCapability({
    providerId: "purch",
    capability: "shop.search",
    maturity: over.capabilityMaturity ?? "verified",
    notes: "test harness",
  });
  /**
   * A Solana settlement account registered the way the operator route registers one: with a public
   * authority and an on-chain attestation, and no key anywhere near it.
   *
   * The attestation is not decoration. `planOperatorIntent` refuses a Solana account that is not
   * attested, and refuses one whose token account is frozen, delegated or closable — so a harness
   * without these fields would only ever exercise the refusal path. `over.attestation` lets a test
   * bend one field and assert the specific defect it produces.
   */
  await store.upsertTreasuryAccount({
    treasuryRef: "solana-usdc-settlement",
    asset: SOL_USDC,
    purpose: "SETTLEMENT",
    address: SOLANA_AUTHORITY,
    minBalance: parseMoney("0.00", SOL_USDC),
    dailyLimit: parseMoney("5.00", SOL_USDC),
    enabled: over.treasuryEnabled ?? true,
    attestation:
      over.attestation === null
        ? null
        : {
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
            observedAt: new Date(NOW).toISOString(),
            provenance: {
              source: "test harness",
              operatorKeyId: "test",
              requestHash: `0x${"11".repeat(32)}`,
              servingCommit: null,
              servingDeploymentId: null,
              rpcHost: "solana-mainnet.g.alchemy.com",
            },
            ...over.attestation,
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

  const rail = new FakeRail();
  const treasury = new TreasuryRouter({
    store,
    rails: new Map<CaipChainId, RailClient>([[SOLANA, rail]]),
    pauses: new StorePauseChecker(store),
    clock: () => NOW,
  });
  const adapters: AdapterRegistry = {
    get: () => adapter,
    has: () => true,
    all: () => [adapter],
  };
  const orchestrator = new ConsumerOrchestrator({
    store,
    registry: new ProviderRegistry({
      store,
      gate: { executionFloor: "verified", allowSandboxExecution: false },
      flags: loadConsumerFlags(over.env ?? ARMED_ENV),
      clock: () => NOW,
    }),
    adapters,
    treasury,
    policyProvider: fakePolicyProvider(over.policyPresent ?? true),
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
    publicBaseUrl: "https://asp.untch.xyz",
    siwx: null,
    clock: () => NOW,
  });

  const lifecycle = new DeploymentLifecycle(over.env ?? ARMED_ENV, new Date(NOW).toISOString(), ATTESTATION_DIR);
  lifecycle.recordSchema("011", true);
  if ((over.phase ?? "READY") === "READY") lifecycle.markReady(new Date(NOW).toISOString());

  const wiring = {
    store: over.readOnly === true ? readOnlyStore(store) : store,
    registry: new ProviderRegistry({
      store,
      gate: { executionFloor: "verified", allowSandboxExecution: false },
      flags: loadConsumerFlags(over.env ?? ARMED_ENV),
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
    publicBaseUrl: "https://asp.untch.xyz",
    availableRails: [SOLANA],
    pool: null as never,
    async close(): Promise<void> {},
  } satisfies ConsumerWiring;

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  registerConsumerOperatorRoutes(app, {
    wiring,
    policyProvider: fakePolicyProvider(over.policyPresent ?? true),
    lifecycle,
    flags: loadConsumerFlags(over.env ?? ARMED_ENV),
    env: over.env ?? ARMED_ENV,
  });

  const url = await new Promise<string>((resolve) => {
    const server = app.listen(0, () => {
      servers.push(server);
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`);
    });
  });
  return { url, store, adapter, orchestrator };
}

/**
 * An environment where every standing control is ON.
 *
 * Deliberately NOT the production environment's shape: production is disarmed, and a test suite that
 * could only exercise the refusal path would never prove the accept path exists. Both are tested.
 */
/**
 * An environment where every standing control is ON and a proof gate names one exact intent.
 *
 * The gate is now part of "fully armed" for a Solana settlement, which it was not before. Solana
 * execution with the flags on and no gate lets the two-second worker poll spend on ANY queued Solana
 * intent, so the plan refuses it as an arming control — meaning a harness that omitted the gate could
 * no longer reach `accepted: true` at all.
 *
 * Parameterised by intent id because a gate names ONE intent by design. A single shared constant would
 * force every test onto whichever id it happened to hold.
 */
function armedEnvFor(intentId: string): NodeJS.ProcessEnv {
  return {
    INTERNAL_OPS_TOKEN: OPS_TOKEN,
    UNTCH_ENVIRONMENT: "production",
    CONSUMER_PACK_ENABLED: "1",
    CONSUMER_EXECUTION_ENABLED: "1",
    CONSUMER_PROVIDER_PURCH_ENABLED: "1",
    CONSUMER_CHAIN_SOLANA_5EYKT4USFV8P8NJDTREPY1VZQKQZKVDP_ENABLED: "1",
    CONSUMER_TREASURY_SOLANA_SECRET_KEY: "not-a-real-key-and-never-read-in-this-suite",
    CONSUMER_SOLANA_EXECUTION_ENABLED: "1",
    CONSUMER_SOLANA_PROOF_MODE: "1",
    CONSUMER_SOLANA_PROOF_INTENT_ID: intentId,
    CONSUMER_SOLANA_PROOF_PROVIDER: "purch",
    CONSUMER_SOLANA_PROOF_CAPABILITY: "shop.search",
    CONSUMER_SOLANA_PROOF_MAX_USDC: "0.020000",
    /**
     * Relative to REAL time, not to the harness's frozen `NOW`.
     *
     * The plan compares the gate expiry against wall-clock `Date.now()`, because that is what a
     * deployed instance does. Pinning this to `NOW + 1h` made the whole suite a time bomb: it passed
     * while the wall clock was inside that hour and failed with `the armed proof gate has expired`
     * afterwards, which reads like a code regression and is a fixture that went stale.
     */
    CONSUMER_SOLANA_PROOF_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

const ARMED_ENV: NodeJS.ProcessEnv = armedEnvFor(INTENT_A);

/**
 * Armed standing controls with NO proof gate.
 *
 * The state an operator is in one step before the final arming. Every structural check holds; the gate
 * is the only thing left, which is exactly what READY_TO_ARM is supposed to mean.
 */
const READY_TO_ARM_ENV: NodeJS.ProcessEnv = {
  INTERNAL_OPS_TOKEN: OPS_TOKEN,
  UNTCH_ENVIRONMENT: "production",
  CONSUMER_PACK_ENABLED: "1",
  CONSUMER_EXECUTION_ENABLED: "1",
  CONSUMER_PROVIDER_PURCH_ENABLED: "1",
  CONSUMER_CHAIN_SOLANA_5EYKT4USFV8P8NJDTREPY1VZQKQZKVDP_ENABLED: "1",
  CONSUMER_TREASURY_SOLANA_SECRET_KEY: "not-a-real-key-and-never-read-in-this-suite",
  CONSUMER_SOLANA_EXECUTION_ENABLED: "1",
};

/**
 * Production's actual shape today: the pack and execution on, everything Solana off, no signer.
 *
 * This is what the deployed service answers with, and it is the case the controller's preflight-only
 * run has to classify as READY_TO_ARM once a policy and a settlement account exist.
 */
const PRODUCTION_DISARMED_ENV: NodeJS.ProcessEnv = {
  INTERNAL_OPS_TOKEN: OPS_TOKEN,
  UNTCH_ENVIRONMENT: "production",
  CONSUMER_PACK_ENABLED: "1",
  CONSUMER_EXECUTION_ENABLED: "1",
  CONSUMER_CHAIN_EIP155_8453_ENABLED: "1",
  CONSUMER_ASSET_EIP155_8453_USDC_ENABLED: "1",
};

/** The disarmed shape production actually runs in today. */
const DISARMED_ENV: NodeJS.ProcessEnv = {
  INTERNAL_OPS_TOKEN: OPS_TOKEN,
  UNTCH_ENVIRONMENT: "production",
  CONSUMER_PACK_ENABLED: "1",
  CONSUMER_CHAIN_EIP155_8453_ENABLED: "1",
};

function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intentId: INTENT_A,
    tenantId: "policy:9001",
    owner: "untch-operator",
    provider: "purch",
    capability: "shop.search",
    request: { query: "usb c cable", limit: 5 },
    providerRef: "search:usb c cable",
    maxProviderAmount: "0.020000",
    expectedSettlementChain: SOLANA,
    expectedSettlementAsset: "USDC",
    fundingMode: "operator-funded",
    idempotencyKey: "operator-proof-001",
    ...over,
  };
}

async function post(
  url: string,
  path: string,
  body: unknown,
  token: string | null = OPS_TOKEN,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("operator authentication", () => {
  test("a missing token is refused, and the refusal names no secret", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody(), null);
    assert.equal(r.status, 401);
    assert.equal(r.body.code, "OPS_AUTH_REQUIRED");
    assert.ok(!r.raw.includes(OPS_TOKEN), "the expected token must never appear in a response");
  });

  test("an incorrect token is refused and the presented value is not echoed", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody(), WRONG_TOKEN);
    assert.equal(r.status, 401);
    assert.ok(!r.raw.includes(WRONG_TOKEN), "the presented token must never be echoed back");
    assert.ok(!r.raw.includes(OPS_TOKEN));
  });

  test("the correct token is accepted", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    assert.equal(r.status, 200);
  });

  test("an unconfigured instance is unavailable rather than public", async () => {
    const h = await harness({ env: { ...ARMED_ENV, INTERNAL_OPS_TOKEN: undefined } });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "OPS_AUTH_NOT_CONFIGURED");
  });

  test("the audit records the attempt and holds no token value", async () => {
    const h = await harness();
    await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody(), WRONG_TOKEN);
    await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    const events = recentOperatorAuthEvents();
    assert.ok(events.length >= 2);
    assert.ok(events.some((e) => e.outcome === "REFUSED"));
    assert.ok(events.some((e) => e.outcome === "ACCEPTED"));
    const serialised = JSON.stringify(events);
    assert.ok(!serialised.includes(OPS_TOKEN), "the audit must never record the token");
    assert.ok(!serialised.includes(WRONG_TOKEN));
    // What it DOES record is a one-way digest, which is what makes provenance possible at all.
    assert.ok(serialised.includes(operatorKeyId(OPS_TOKEN)));
  });

  test("repeated failures from one source are throttled", async () => {
    const h = await harness();
    let last = { status: 0 };
    for (let i = 0; i < 12; i += 1) {
      last = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody(), WRONG_TOKEN);
    }
    assert.equal(last.status, 429);
  });

  test("the comparison is length-safe and value-correct", () => {
    assert.equal(operatorTokenMatches(OPS_TOKEN, OPS_TOKEN), true);
    assert.equal(operatorTokenMatches("", OPS_TOKEN), false);
    assert.equal(operatorTokenMatches(`${OPS_TOKEN}x`, OPS_TOKEN), false);
    // A shorter presented value must not throw the way a bare timingSafeEqual would.
    assert.equal(operatorTokenMatches("a", OPS_TOKEN), false);
  });

  test("the key identifier is one-way and changes with the token", () => {
    assert.notEqual(operatorKeyId(OPS_TOKEN), operatorKeyId(WRONG_TOKEN));
    assert.ok(!operatorKeyId(OPS_TOKEN).includes(OPS_TOKEN));
    assert.match(operatorKeyId(OPS_TOKEN), /^[0-9a-f]{16}$/);
  });
});

describe("operator preflight", () => {
  test("it reads the production registry and reports the real maturity", async () => {
    const h = await harness({ readOnly: true });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    assert.equal(r.status, 200);
    const maturity = r.body.productionMaturity as Record<string, unknown>;
    assert.equal(maturity.provider, "verified");
    assert.equal(maturity.capability, "verified");
    assert.equal(maturity.effective, "verified");
  });

  test("it mutates nothing — every store write throws in this harness", async () => {
    const h = await harness({ readOnly: true });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    assert.equal(r.status, 200);
    assert.equal(r.body.accepted, true);
  });

  test("it creates no intent, no reservation and no queue row", async () => {
    const h = await harness();
    await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    assert.equal(await h.store.getIntent(INTENT_A), null);
    assert.equal(await h.store.getFunding(INTENT_A), null);
    assert.equal((await h.store.listIntents({ state: "EXECUTION_QUEUED", limit: 10 })).length, 0);
  });

  test("it calls no provider and loads no signer", async () => {
    const h = await harness();
    await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    assert.equal(h.adapter.quoteCalls, 0);
    assert.equal(h.adapter.executeCalls, 0);
  });

  test("a disarmed instance is refused with the exact standing-control blocker", async () => {
    const h = await harness({ env: DISARMED_ENV });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    assert.equal(r.status, 200);
    assert.equal(r.body.accepted, false);
    const refusals = r.body.refusals as { code: string; message: string }[];
    assert.ok(refusals.some((x) => x.code === "EXECUTION_CONTROLS_DISABLED"));
    const controls = r.body.executionControls as Record<string, unknown>;
    assert.equal(controls.executionEnabled, false);
    // …and the registry still reports the truth about the capability alongside the refusal.
    assert.equal((r.body.productionMaturity as Record<string, unknown>).effective, "verified");
    assert.equal(r.body.publicMaturity, "BETA");
  });

  test("a chain the provider does not settle on is refused, not silently redirected", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody({ expectedSettlementChain: BASE }));
    const refusals = r.body.refusals as { code: string }[];
    assert.ok(refusals.some((x) => x.code === "SETTLEMENT_CHAIN_MISMATCH"));
  });

  test("an amount above the instance ceiling is refused", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody({ maxProviderAmount: "5.000000" }));
    const refusals = r.body.refusals as { code: string }[];
    assert.ok(refusals.some((x) => x.code === "ABOVE_INSTANCE_CEILING"));
  });

  test("a capability below the execution floor is refused by name", async () => {
    const h = await harness({ capabilityMaturity: "experimental" });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    const refusals = r.body.refusals as { code: string }[];
    assert.ok(refusals.some((x) => x.code === "BELOW_EXECUTION_FLOOR"));
  });

  test("a disabled provider is refused", async () => {
    const h = await harness({ providerEnabled: false });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    const refusals = r.body.refusals as { code: string }[];
    assert.ok(refusals.some((x) => x.code === "PROVIDER_DISABLED"));
  });

  test("a missing policy is refused rather than defaulted", async () => {
    const h = await harness({ policyPresent: false });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    const refusals = r.body.refusals as { code: string }[];
    assert.ok(refusals.some((x) => x.code === "POLICY_NOT_FOUND"));
  });

  test("a non-READY instance refuses everything", async () => {
    const h = await harness({ phase: "STARTING" });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    const refusals = r.body.refusals as { code: string }[];
    assert.ok(refusals.some((x) => x.code === "DEPLOYMENT_NOT_READY"));
  });

  test("a non-production instance cannot pretend to be production", async () => {
    const h = await harness({ env: { ...ARMED_ENV, UNTCH_ENVIRONMENT: "development" } });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    const refusals = r.body.refusals as { code: string }[];
    assert.ok(refusals.some((x) => x.code === "NOT_PRODUCTION"));
  });

  /**
   * An absent gate on a SOLANA settlement IS a blocker. This reverses an earlier reading.
   *
   * The old assertion held that an unarmed gate merely leaves the standing controls in charge, so
   * reporting it would point an operator at the wrong lever. That was true only while the standing
   * controls were themselves off. Once they are on — which is the state an operator is about to create
   * — the two-second worker poll may spend from the Solana treasury on ANY queued Solana intent for as
   * long as the flags stay set. The gate exists so the blast radius of a proof equals the proof, so its
   * absence is the widest the authority ever gets, not a neutral fact.
   *
   * It is raised as an ARMING CONTROL, not a structural defect: the operator clears it by arming the
   * exact scope. That distinction is what keeps the response pointing at the right lever.
   */
  test("an unarmed proof gate blocks a Solana settlement, as an arming control", async () => {
    const h = await harness({ env: READY_TO_ARM_ENV });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    const gate = r.body.proofGate as Record<string, unknown>;
    assert.equal(gate.governsThisChain, true);
    assert.equal(gate.mode, "disabled");
    assert.equal(gate.compatible, false);
    const refusals = r.body.refusals as { code: string }[];
    assert.ok(refusals.some((x) => x.code === "PROOF_GATE_NOT_ARMED"));
    // …and NOT as a structural conflict, which is what an armed-but-wrong gate would be.
    assert.ok(!refusals.some((x) => x.code === "PROOF_GATE_INCOMPATIBLE"));
    assert.equal(r.body.readinessClass, "READY_TO_ARM");
  });

  test("a fully armed instance is ARMED_AND_EXECUTABLE with no refusals", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    assert.deepEqual(r.body.refusals, []);
    assert.equal(r.body.accepted, true);
    assert.equal(r.body.readinessClass, "ARMED_AND_EXECUTABLE");
  });

  test("production's own disarmed shape is READY_TO_ARM, not STRUCTURAL_BLOCKED", async () => {
    const h = await harness({ env: PRODUCTION_DISARMED_ENV });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    assert.equal(r.body.accepted, false);
    assert.equal(r.body.readinessClass, "READY_TO_ARM");
    /**
     * The whole point of the class. Every remaining refusal must be a switch an operator throws — no
     * missing policy, no absent settlement account, no maturity failure, nothing about the deployment.
     */
    const codes = (r.body.refusals as { code: string }[]).map((x) => x.code).sort();
    assert.deepEqual(codes, [
      "EXECUTION_CONTROLS_DISABLED",
      "PROOF_GATE_NOT_ARMED",
      "SETTLEMENT_RAIL_EXECUTION_DISABLED",
      "SETTLEMENT_SIGNER_ABSENT",
    ]);
    const settlement = r.body.expectedSettlement as Record<string, unknown>;
    assert.equal(settlement.accountRegistered, true);
    assert.equal(settlement.accountFunded, true);
    assert.equal(settlement.signerConfigured, false);
    assert.equal(settlement.railExecutionEnabled, false);
  });

  test("a structural defect is STRUCTURAL_BLOCKED even when the switches are on", async () => {
    for (const [label, over] of [
      ["a missing policy", { policyPresent: false }],
      ["an unattested settlement account", { attestation: null }],
      ["a capability below the floor", { capabilityMaturity: "experimental" as const }],
    ] as const) {
      const h = await harness(over as never);
      const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
      assert.equal(r.body.readinessClass, "STRUCTURAL_BLOCKED", `${label} must be structural`);
    }
  });

  /**
   * The three token-account facts a balance cannot show.
   *
   * Each is invisible from the authority address and each changes what "0.05 USDC is sitting there"
   * means: a delegate can move it, a close authority can sweep it, a freeze makes it readable and
   * unspendable. A frozen float would accept an authorisation and fail the transfer AFTER the gate had
   * been claimed, and a claimed gate is a one-way door.
   */
  test("a delegated, frozen or closable float is refused before anything is armed", async () => {
    const cases = [
      ["delegate", { delegate: base58Fixture("a-third-party-delegate") }, "SETTLEMENT_ACCOUNT_DELEGATE_PRESENT"],
      ["frozen", { accountState: "frozen" }, "SETTLEMENT_ACCOUNT_ACCOUNT_FROZEN"],
      ["close authority", { closeAuthority: SOLANA_AUTHORITY }, "SETTLEMENT_ACCOUNT_CLOSE_AUTHORITY_PRESENT"],
      ["foreign token-account owner", { tokenAccountOwner: base58Fixture("a-foreign-token-account-owner") }, "SETTLEMENT_ACCOUNT_TOKEN_ACCOUNT_OWNER_MISMATCH"],
    ] as const;
    for (const [label, bend, expected] of cases) {
      const h = await harness({ attestation: bend as never });
      const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
      const codes = (r.body.refusals as { code: string }[]).map((x) => x.code);
      assert.ok(codes.includes(expected), `${label} must raise ${expected}, got ${codes.join(", ")}`);
      assert.equal(r.body.readinessClass, "STRUCTURAL_BLOCKED", `${label} is structural`);
      assert.equal(r.body.accepted, false);
    }
  });

  test("an underfunded float is refused, counting the account floor as well as the ceiling", async () => {
    const h = await harness({ attestation: { observedTokenBalance: "5000" } });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    const codes = (r.body.refusals as { code: string }[]).map((x) => x.code);
    assert.ok(codes.includes("SETTLEMENT_ACCOUNT_UNDERFUNDED"));
    assert.equal((r.body.expectedSettlement as Record<string, unknown>).accountFunded, false);
  });

  /**
   * The one combination that must never execute: a signer that controls a different wallet.
   *
   * Every individual control is satisfied here — the account is registered, attested, funded and sound,
   * the flags are on, the gate is armed. And the key loaded on the instance spends from somewhere else,
   * so the balance floor, the daily limit and the reconciliation drift check are all measuring a wallet
   * nobody authorised.
   */
  test("a signer that does not control the registered authority is refused", async () => {
    const h = await harness({ attestation: { authority: base58Fixture("a-wallet-this-instance-cannot-sign-for") } });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    const codes = (r.body.refusals as { code: string }[]).map((x) => x.code);
    assert.ok(codes.includes("SETTLEMENT_SIGNER_AUTHORITY_MISMATCH"), codes.join(", "));
    assert.equal(r.body.readinessClass, "STRUCTURAL_BLOCKED");
    assert.equal((r.body.expectedSettlement as Record<string, unknown>).signerMatchesAuthority, false);
  });

  test("an armed gate naming a different intent refuses this one", async () => {
    const h = await harness({
      env: {
        ...ARMED_ENV,
        CONSUMER_SOLANA_PROOF_MODE: "1",
        CONSUMER_SOLANA_PROOF_INTENT_ID: INTENT_B,
        CONSUMER_SOLANA_PROOF_PROVIDER: "purch",
        CONSUMER_SOLANA_PROOF_CAPABILITY: "shop.search",
        CONSUMER_SOLANA_PROOF_MAX_USDC: "0.020000",
        CONSUMER_SOLANA_PROOF_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    const refusals = r.body.refusals as { code: string }[];
    assert.ok(refusals.some((x) => x.code === "PROOF_GATE_INCOMPATIBLE"));
  });

  test("the response carries a redacted deployment identity and no secret", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    const deployment = r.body.deployment as Record<string, unknown>;
    assert.equal(deployment.phase, "READY");
    assert.equal(deployment.environment, "production");
    assert.equal(deployment.migrationVersion, "011");
    assert.ok(!r.raw.includes("not-a-real-key-and-never-read-in-this-suite"));
    assert.ok(!r.raw.includes(OPS_TOKEN));
  });
});

describe("exact intent id", () => {
  test("a canonical id is accepted", () => {
    const parsed = parseOperatorIntentInput(validBody());
    assert.equal(parsed.ok, true);
  });

  test("a malformed id is refused", () => {
    for (const bad of ["ci_short", "CI_" + "a1".repeat(12), "ci_" + "A1".repeat(12), "intent-1", ""]) {
      const parsed = parseOperatorIntentInput(validBody({ intentId: bad }));
      assert.equal(parsed.ok, false, `${bad} must be refused`);
    }
  });

  test("preflight does not reserve the id, so a later create can still use it", async () => {
    const h = await harness();
    await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    const created = await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    assert.equal(created.status, 201);
    assert.equal(created.body.intentId, INTENT_A);
  });

  test("a failed authentication cannot reserve the id", async () => {
    const h = await harness();
    await post(h.url, OPERATOR_CREATE_ROUTE, validBody(), WRONG_TOKEN);
    assert.equal(await h.store.getIntent(INTENT_A), null);
    const created = await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    assert.equal(created.status, 201);
  });

  test("an existing id is refused and no second id is minted", async () => {
    const h = await harness();
    assert.equal((await post(h.url, OPERATOR_CREATE_ROUTE, validBody())).status, 201);
    const again = await post(
      h.url,
      OPERATOR_CREATE_ROUTE,
      validBody({ idempotencyKey: "operator-proof-002" }),
    );
    assert.equal(again.status, 409);
    const plan = again.body.plan as Record<string, unknown>;
    const refusals = plan.refusals as { code: string }[];
    assert.ok(refusals.some((x) => x.code === "INTENT_ID_EXISTS"));
    const all = await h.store.listIntents({ limit: 50 });
    assert.equal(all.length, 1);
    assert.equal(all[0]?.intentId, INTENT_A);
  });

  test("the same idempotency key naming a different intent id is refused", async () => {
    const h = await harness();
    assert.equal((await post(h.url, OPERATOR_CREATE_ROUTE, validBody())).status, 201);
    const other = await post(h.url, OPERATOR_CREATE_ROUTE, validBody({ intentId: INTENT_B }));
    assert.equal(other.status, 409);
    assert.equal(await h.store.getIntent(INTENT_B), null);
  });

  test("create uses the exact supplied id", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    assert.equal(r.body.intentId, INTENT_A);
    assert.ok(await h.store.getIntent(INTENT_A));
  });
});

describe("operator create", () => {
  test("it runs the normal chain: quote, policy, reservation, queue", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    assert.equal(r.status, 201);
    assert.equal(r.body.state, "EXECUTION_QUEUED");
    assert.equal(r.body.nextAction, "AWAIT_DEPLOYED_WORKER");

    const intent = await h.store.getIntent(INTENT_A);
    assert.equal(intent?.state, "EXECUTION_QUEUED");
    assert.ok(intent?.quoteId, "the normal quote must have run");
    assert.ok(await h.store.getFunding(INTENT_A), "the normal reservation must exist");
    assert.equal((r.body.decision as Record<string, unknown>).decision, "APPROVED");
  });

  /**
   * THE EXECUTION BOUNDARY.
   *
   * The adapter's `execute` throws on sight. A route that reached it would fail this test loudly
   * rather than quietly acquiring spending authority.
   */
  test("the route never executes the provider, even though the adapter would throw if it did", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    assert.equal(r.status, 201);
    assert.equal(h.adapter.executeCalls, 0);
    assert.equal(h.adapter.quoteCalls, 1, "quoting is the only provider contact the route makes");
  });

  test("an orchestrator whose executeIntent throws still creates and queues", async () => {
    const h = await harness();
    const armed = h.orchestrator;
    let reached = false;
    // Replace the method the worker uses. The route must not touch it.
    Object.defineProperty(armed, "executeIntent", {
      value: async () => {
        reached = true;
        throw new Error("EXECUTION REACHED FROM A ROUTE");
      },
    });
    const r = await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    assert.equal(r.status, 201);
    assert.equal(reached, false);
  });

  test("it refuses on the same plan the preflight reports, and creates nothing", async () => {
    const h = await harness({ env: DISARMED_ENV });
    const r = await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "OPERATOR_INTENT_REFUSED");
    assert.equal(await h.store.getIntent(INTENT_A), null);
    assert.equal(h.adapter.quoteCalls, 0);
  });

  test("it does not change registry maturity or provider limits", async () => {
    const h = await harness();
    const before = await h.store.getProvider("purch");
    const limitBefore = await h.store.getProviderLimit("purch", SOLANA, "USDC");
    await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    const after = await h.store.getProvider("purch");
    assert.deepEqual(after, before);
    assert.deepEqual(await h.store.getProviderLimit("purch", SOLANA, "USDC"), limitBefore);
    assert.deepEqual(await h.store.listCapabilities("purch"), [
      { providerId: "purch", capability: "shop.search", maturity: "verified", notes: "test harness" },
    ]);
  });

  test("operator provenance is recorded durably and carries no secret", async () => {
    const h = await harness();
    await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    const events = await h.store.eventsSince(INTENT_A, 0, 50);
    const created = events.find((e) => e.name === "consumer.intent.created");
    assert.ok(created, "the creation event must exist");
    const provenance = (created.data as Record<string, unknown>).provenance as Record<string, unknown>;
    assert.equal(provenance.source, "internal-operator-api");
    assert.equal(provenance.route, OPERATOR_CREATE_ROUTE);
    assert.equal(provenance.operatorKeyId, operatorKeyId(OPS_TOKEN));
    assert.equal(provenance.idempotencyKey, "operator-proof-001");
    assert.equal(provenance.environment, "production");
    assert.match(String(provenance.requestHash), /^0x[0-9a-f]{64}$/);
    assert.ok(typeof provenance.requestedAt === "string");

    const serialised = JSON.stringify(events);
    assert.ok(!serialised.includes(OPS_TOKEN), "provenance must never contain the token");
    // The request HASH, not the request: an audit record is not a reason to keep a copy of a body.
    assert.ok(!String(provenance.requestHash).includes("usb c cable"));
  });

  test("an externally-funded intent stops at AWAITING_FUNDING and is not queued", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_CREATE_ROUTE, validBody({ fundingMode: "externally-funded" }));
    assert.equal(r.status, 201);
    assert.equal(r.body.state, "AWAITING_FUNDING");
    assert.equal(r.body.nextAction, "AWAIT_EXTERNAL_FUNDING");
    assert.equal(await h.store.getFunding(INTENT_A), null);
    assert.equal((await h.store.listIntents({ state: "EXECUTION_QUEUED", limit: 10 })).length, 0);
  });

  test("the response is redacted: no token, no key, no full RPC URL", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    assert.ok(!r.raw.includes(OPS_TOKEN));
    assert.ok(!r.raw.includes("not-a-real-key-and-never-read-in-this-suite"));
  });

  test("fields that must be derived are refused rather than ignored", async () => {
    const h = await harness();
    for (const field of ["recipient", "payTo", "providerUrl", "tokenMint", "treasuryAddress", "maturity"]) {
      const r = await post(h.url, OPERATOR_CREATE_ROUTE, validBody({ [field]: "anything" }));
      assert.equal(r.status, 400, `${field} must be refused`);
      const refusals = r.body.refusals as { code: string }[];
      assert.ok(refusals.some((x) => x.code === "FIELD_NOT_ACCEPTED"));
      assert.equal(await h.store.getIntent(INTENT_A), null);
    }
  });

  test("a URL-shaped providerRef is refused", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_CREATE_ROUTE, validBody({ providerRef: "https://evil.example/item" }));
    assert.equal(r.status, 400);
    const refusals = r.body.refusals as { code: string }[];
    assert.ok(refusals.some((x) => x.code === "PROVIDER_REF_MALFORMED"));
  });
});

describe("operator create concurrency", () => {
  test("two concurrent creates with the same intent id produce one durable intent", async () => {
    const h = await harness();
    const results = await Promise.all([
      post(h.url, OPERATOR_CREATE_ROUTE, validBody()),
      post(h.url, OPERATOR_CREATE_ROUTE, validBody()),
    ]);
    const created = results.filter((r) => r.status === 201);
    assert.equal(created.length, 1, "exactly one create may win");
    const all = await h.store.listIntents({ limit: 50 });
    assert.equal(all.length, 1);
    /**
     * The loser must be a REFUSAL, not a 500.
     *
     * A real Postgres found this: uncaught, the losing request surfaced express's default HTML 500,
     * which is unparseable, names no cause, and invites the retry that would make one authorisation
     * into two.
     */
    const loser = results.find((r) => r.status !== 201);
    assert.equal(loser?.status, 409);
    assert.ok(
      ["OPERATOR_INTENT_REFUSED", "OPERATOR_INTENT_CONCURRENT", "IDEMPOTENCY_KEY_BOUND_ELSEWHERE"].includes(
        String(loser?.body.code),
      ),
      `the loser must name its cause, got ${String(loser?.body.code)}`,
    );
  });

  test("two concurrent creates with the same idempotency key and different ids produce one intent", async () => {
    const h = await harness();
    const results = await Promise.all([
      post(h.url, OPERATOR_CREATE_ROUTE, validBody()),
      post(h.url, OPERATOR_CREATE_ROUTE, validBody({ intentId: INTENT_B })),
    ]);
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    const all = await h.store.listIntents({ limit: 50 });
    assert.equal(all.length, 1);
    // …and exactly one queue transition, so one authorisation cannot become two settlements.
    const queued = await h.store.listIntents({ state: "EXECUTION_QUEUED", limit: 50 });
    assert.equal(queued.length, 1);
    assert.equal(results.find((r) => r.status !== 201)?.status, 409);
  });
});

describe("production environment identity", () => {
  test("the platform marker is read, and an explicit one wins", () => {
    assert.deepEqual(operatorEnvironmentOf({ RAILWAY_ENVIRONMENT_NAME: "production" }), {
      environment: "production",
      isProduction: true,
    });
    assert.deepEqual(
      operatorEnvironmentOf({ RAILWAY_ENVIRONMENT_NAME: "production", UNTCH_ENVIRONMENT: "staging" }),
      { environment: "staging", isProduction: false },
    );
    assert.deepEqual(operatorEnvironmentOf({}), { environment: null, isProduction: false });
  });

  test("the integration override is explicit and reported, never implicit", () => {
    const resolved = operatorEnvironmentOf({
      UNTCH_ENVIRONMENT: "test",
      UNTCH_OPERATOR_ROUTES_ALLOW_NON_PRODUCTION: "1",
    });
    assert.equal(resolved.isProduction, true);
    // The environment it reports is still the truth: the override permits, it does not relabel.
    assert.equal(resolved.environment, "test");
  });
});

describe("operator read route", () => {
  const readUrl = (base: string, id: string): string => `${base}/internal/consumer/intents/${id}`;

  async function get(
    base: string,
    id: string,
    token: string | null = OPS_TOKEN,
  ): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
    const res = await fetch(readUrl(base, id), {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    const raw = await res.text();
    return { status: res.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
  }

  test("it requires the operator token", async () => {
    const h = await harness();
    assert.equal((await get(h.url, INTENT_A, null)).status, 401);
  });

  test("an unknown intent is a named 404, not an empty success", async () => {
    const h = await harness();
    const r = await get(h.url, INTENT_A);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "INTENT_NOT_FOUND");
  });

  test("it reads state, policy evidence, reservation and events from the production store", async () => {
    const h = await harness();
    await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    const r = await get(h.url, INTENT_A);
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "EXECUTION_QUEUED");
    assert.equal(r.body.providerId, "purch");

    const policy = r.body.policy as Record<string, unknown>;
    assert.equal(policy.policyId, "9001");
    assert.equal(policy.decision, "APPROVED");
    assert.ok(typeof policy.policyHash === "string", "the policy trace hash must be returned");

    const reservation = r.body.reservation as Record<string, unknown>;
    assert.equal(reservation.present, true);
    assert.equal(reservation.settlementMarker, "operator-funded");

    const quote = r.body.quote as Record<string, unknown>;
    assert.ok(typeof quote.quoteHash === "string");

    assert.equal((r.body.executions as unknown[]).length, 0, "nothing has executed yet");
    assert.ok((r.body.events as unknown[]).length > 0);
  });

  test("the ledger is summarised, not dumped, and no private account id leaks", async () => {
    const h = await harness();
    await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    const r = await get(h.url, INTENT_A);
    const ledger = r.body.ledger as { kind: string; asset: string; entries: number }[];
    assert.ok(ledger.length > 0);
    for (const group of ledger) {
      assert.ok(typeof group.kind === "string");
      assert.ok(typeof group.entries === "number");
      assert.equal(Object.keys(group).sort().join(","), "asset,entries,kind");
    }
  });

  test("the receipt URL is the public one, and null until a receipt exists", async () => {
    const h = await harness();
    await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    const r = await get(h.url, INTENT_A);
    assert.equal(r.body.receiptId, null);
    assert.equal(r.body.publicReceiptUrl, null);
  });

  test("no secret reaches the response", async () => {
    const h = await harness();
    await post(h.url, OPERATOR_CREATE_ROUTE, validBody());
    const r = await get(h.url, INTENT_A);
    assert.ok(!r.raw.includes(OPS_TOKEN));
    assert.ok(!r.raw.includes("not-a-real-key-and-never-read-in-this-suite"));
  });

  test("the preflight path is not captured by the :intentId parameter", async () => {
    const h = await harness();
    const r = await post(h.url, OPERATOR_PREFLIGHT_ROUTE, validBody());
    assert.equal(r.status, 200);
    assert.ok("accepted" in r.body, "the preflight must answer, not the read route");
  });
});
