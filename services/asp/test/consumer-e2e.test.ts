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
  assertIntentSettled,
  isProviderError,
  money,
  parseMoney,
  projectBalances,
  userObligationAccount,
  type CaipChainId,
  type ConsumerStore,
  type Money,
  type PaymentRequest,
  type PaymentResult,
  type ConsumerFlags,
  type RailClient,
} from "@untch/consumer-core";
import {
  PROVIDER_SEEDS,
  StableDomainsAdapter,
  buildAdapterRegistry,
  type AdapterRegistry,
} from "@untch/consumer-providers";
import type { Decision, Ledger, LedgerWindowState, SpendIntentInput } from "@untch/policy-engine";
import type { PolicyProvider, StoredPolicy } from "@untch/policy-store";
import { ConsumerOrchestrator, type ConsumerEscalationGateway } from "../src/consumer/orchestrator";
import { makeFundingPrice, intentIdFromFundingPath, FundingPriceError } from "../src/consumer/funding-price";
import { OutboxDispatcher, SseHub } from "../src/consumer/dispatcher";

/**
 * The end-to-end suite. It drives the REAL orchestrator, the REAL policy engine, the REAL ledger and
 * the REAL state machine — only the network and the signer are faked, because those are the only two
 * things a test cannot honestly own.
 *
 * Each `describe` below maps to one of the acceptance criteria in
 * internal/consumer-pack-implementation-plan.md §13.
 */

const FIXTURES = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "..", "..",
      "packages", "consumer-providers", "fixtures", "live-challenges.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;

const BASE: CaipChainId = "eip155:8453";
const USDC = asset("base.usdc");
const USDT0 = asset("xlayer.usdt0");
const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const RECIPIENT = "0xABcb091D90419E1c8AD4818f1B33FC4645501892";

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeRail implements RailClient {
  readonly chain = BASE;
  readonly payments: PaymentRequest[] = [];
  constructor(private readonly balance = 1_000_000_000n) {}
  address(): string {
    return "0x00000000000000000000000000000000000000AA";
  }
  available(): boolean {
    return true;
  }
  async balanceOf(a: typeof USDC): Promise<Money> {
    return money(this.balance, a);
  }
  async pay(req: PaymentRequest): Promise<PaymentResult> {
    this.payments.push(req);
    return {
      paymentHeader: "FAKE",
      headerName: "X-PAYMENT",
      txHash: "0xsettled",
      amount: req.amount,
      recipient: req.recipient,
      chain: BASE,
    };
  }
}

class MemoryLedger implements Ledger {
  private spent = 0;
  private calls = 0;
  async read(): Promise<LedgerWindowState> {
    return {
      budgetUsage: { settledToday: 0, reservedActiveToday: this.spent, effectiveToday: this.spent },
      recentIntents: [],
      lastCallByService: {},
      callsInLastHour: this.calls,
    };
  }
  async commitApproved(_key: string, intent: SpendIntentInput): Promise<void> {
    this.spent += intent.amount;
    this.calls += 1;
  }
}

const RULES = {
  budgets: { daily: 1000, token: "USDT0" },
  perCallCap: 500,
  escalateAbove: 100,
  categories: { allow: [], deny: [] },
  recipients: { allow: [], deny: [] },
  agents: { allowWorkerIds: [], denyWorkerIds: [] },
  duplicates: { ttlMin: 0, keys: [] },
  cooldowns: { sameServiceMin: 0 },
  rateLimit: { callsPerHour: 100 },
  expiry: "2027-01-01T00:00:00.000Z",
};

function storedPolicy(over: Partial<StoredPolicy> = {}): StoredPolicy {
  return {
    id: "42",
    owner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
    agentId: "1",
    version: 1,
    status: "ACTIVE",
    policyHash: `0x${"ab".repeat(32)}`,
    expiry: 2_000_000_000,
    onchainRef: {},
    rules: RULES,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as unknown as StoredPolicy;
}

function fakePolicyProvider(policy: StoredPolicy | null): PolicyProvider {
  return {
    async load() {
      return policy === null ? null : ({ id: policy.id, version: policy.version, status: "ACTIVE", rules: RULES } as never);
    },
    async loadStored() {
      return policy;
    },
  } as unknown as PolicyProvider;
}

/** A scripted provider fetch: the register 402, then a success body. */
function domainsFetch(over: { registerBody?: unknown; failPaidRetry?: Error } = {}): typeof fetch {
  let call = 0;
  return (async (_url: string | URL, _init?: RequestInit): Promise<Response> => {
    call += 1;
    const challenge = Buffer.from(JSON.stringify(FIXTURES.stabledomainsRegister402), "utf8").toString("base64");
    if (call === 1) {
      // The unpaid 402 probe used by quote().
      return new Response("{}", { status: 402, headers: { "payment-required": challenge } });
    }
    if (call === 2) {
      return new Response("{}", { status: 402, headers: { "payment-required": challenge } });
    }
    if (over.failPaidRetry) throw over.failPaidRetry;
    return new Response(
      JSON.stringify(
        over.registerBody ?? {
          domain: "untchprobe.com",
          status: "pending",
          registrationEmailSent: true,
          next: {},
          orderId: "ord_live_1",
        },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

/** A StableDomains adapter whose paid check reports a verified registrant profile. */
class TestDomainsAdapter extends StableDomainsAdapter {
  override async quote(input: Parameters<StableDomainsAdapter["quote"]>[0], ctx: Parameters<StableDomainsAdapter["quote"]>[1]) {
    // Skip the paid /api/check leg (it needs its own capability); go straight to the price probe,
    // and declare the prerequisite satisfied so execute() is reachable in the test.
    const priced = await (this as unknown as {
      probe402: (m: string, p: string, c: unknown, b?: unknown) => Promise<{
        amount: Money; recipient: string; option: { network: CaipChainId }; asset: typeof USDC;
      }>;
    }).probe402("POST", "/api/register", ctx, { domain: input.providerRef });
    return {
      providerId: this.providerId,
      providerRef: input.providerRef,
      cost: priced.amount,
      settlementRecipient: priced.recipient,
      settlementChain: priced.option.network,
      settlementAsset: priced.asset,
      summary: `Register ${input.providerRef}`,
      terms: { domain: input.providerRef, readyToRegister: true, profileNote: "verified" },
      expiresAt: new Date(NOW + 600_000).toISOString(),
    };
  }
}

interface Harness {
  store: ConsumerStore;
  orchestrator: ConsumerOrchestrator;
  rail: FakeRail;
  treasury: TreasuryRouter;
  adapters: AdapterRegistry;
}

async function harness(
  over: {
    policy?: StoredPolicy | null;
    escalation?: ConsumerEscalationGateway | null;
    fetchImpl?: typeof fetch;
    maturity?: "verified" | "sandbox";
    allowSandbox?: boolean;
    railBalance?: bigint;
    flagsOff?: boolean;
  } = {},
): Promise<Harness> {
  const store = new InMemoryConsumerStore(() => NOW);
  const rail = new FakeRail(over.railBalance ?? 1_000_000_000n);

  for (const seed of PROVIDER_SEEDS) {
    await store.upsertProvider({ ...seed.provider, maturity: over.maturity ?? "verified" });
    for (const cap of seed.capabilities) {
      await store.upsertCapability({ ...cap, maturity: over.maturity ?? "verified" });
    }
  }
  await store.upsertTreasuryAccount({
    treasuryRef: "base-usdc-settlement",
    asset: USDC,
    purpose: "SETTLEMENT",
    address: rail.address(),
    minBalance: parseMoney("0.00", USDC),
    dailyLimit: parseMoney("0.00", USDC),
    enabled: true,
  });

  const treasury = new TreasuryRouter({
    store,
    rails: new Map([[BASE, rail]]),
    pauses: new StorePauseChecker(store),
    clock: () => NOW,
  });

  const baseAdapters = buildAdapterRegistry();
  const testDomains = new TestDomainsAdapter();
  const adapters: AdapterRegistry = {
    get: (id) => (id === "stabledomains" ? testDomains : baseAdapters.get(id)),
    has: (id) => baseAdapters.has(id),
    all: () => baseAdapters.all(),
  };

  const orchestrator = new ConsumerOrchestrator({
    store,
    registry: new ProviderRegistry({
      store,
      gate: { executionFloor: "verified", allowSandboxExecution: over.allowSandbox ?? false },
      // Execution defaults OFF in every environment, so the harness must switch it on explicitly.
      // `flagsOff: true` exercises the opposite: that an otherwise-perfect intent still refuses.
      flags: over.flagsOff === true ? allFlagsOff : allFlagsOn,
      clock: () => NOW,
    }),
    adapters,
    treasury,
    policyProvider: fakePolicyProvider(over.policy === undefined ? storedPolicy() : over.policy),
    ledger: new MemoryLedger(),
    escalation: over.escalation ?? null,
    receipts: null,
    config: {
      allowSandboxExecution: over.allowSandbox ?? false,
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

  // Every adapter call in this suite runs through the injected fetch and a public-looking DNS answer.
  const originalCtx = (orchestrator as unknown as { ctx: unknown }).ctx;
  (orchestrator as unknown as { ctx: (...a: unknown[]) => unknown }).ctx = function patched(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    const base = (originalCtx as (...a: unknown[]) => Record<string, unknown>).apply(this, args);
    return {
      ...base,
      ...(over.fetchImpl ? { fetchImpl: over.fetchImpl } : {}),
      resolveHost: async () => ["104.18.0.1"],
    };
  };

  return { store, orchestrator, rail, treasury, adapters };
}

async function toQuoted(h: Harness): Promise<string> {
  const { intent } = await h.orchestrator.createIntent({
    tenantId: "policy:42",
    requestingAgentId: "1",
    principalId: "user-1",
    action: "domains.register",
    policyId: "42",
    request: { domain: "untchprobe.com" },
    idempotencyKey: `k-${Math.random().toString(36).slice(2)}`,
    correlationId: "cor_1",
    intentId: `ci_${Math.random().toString(16).slice(2).padEnd(24, "0").slice(0, 24)}`,
  });
  await h.orchestrator.quote(intent.intentId, "untchprobe.com");
  return intent.intentId;
}

/** Every switch on — what a deliberately-activated production instance looks like. */
const allFlagsOn: ConsumerFlags = {
  packEnabled: true,
  executionEnabled: true,
  liveSmokeEnabled: false,
  providerEnabled: () => true,
  chainEnabled: () => true,
  assetEnabled: () => true,
  snapshot: () => ({}),
};

/** Every switch off — the default posture of a fresh deployment. */
const allFlagsOff: ConsumerFlags = {
  packEnabled: false,
  executionEnabled: false,
  liveSmokeEnabled: false,
  providerEnabled: () => false,
  chainEnabled: () => false,
  assetEnabled: () => false,
  snapshot: () => ({}),
};

const alwaysApprove: ConsumerEscalationGateway = {
  async requestApproval() {
    return { escalationId: "esc_1" };
  },
  async pollApproval() {
    return "APPROVED";
  },
};

// ─────────────────────────────────────────────────────────────────────────────

describe("AC3 + AC4 — every paid action passes policy, and value is separate from the call fee", () => {
  test("a $20 registration escalates (policy escalateAbove = 100? no — 20.50 < 100 so it approves)", async () => {
    const h = await harness({ fetchImpl: domainsFetch() });
    const intentId = await toQuoted(h);
    const { intent, decision } = await h.orchestrator.runPolicy(intentId);
    assert.ok(decision, "a decision must have been produced by the real engine");
    assert.equal(decision.decision, "APPROVED");
    assert.equal(intent.state, "APPROVED");
    // The decision is stored VERBATIM — the engine's own rule trace, not a summary.
    assert.ok(Array.isArray((intent.policyDecision as { rules?: unknown[] }).rules));
  });

  test("the quote separates provider cost, fee and spread, and the TOTAL is what the user funds", async () => {
    const h = await harness({ fetchImpl: domainsFetch() });
    const intentId = await toQuoted(h);
    const intent = await h.store.getIntent(intentId);
    assert.ok(intent?.quoteId);
    const quote = await h.store.getQuote(intent.quoteId);
    assert.ok(quote);
    // Provider asks 20.000000; fee 150bp = 0.300000; spread 50bp = 0.100000; total 20.400000.
    assert.equal(quote.providerCost.amount, 20_000_000n);
    assert.equal(quote.untchFee.amount, 300_000n);
    assert.equal(quote.spread.amount, 100_000n);
    assert.equal(quote.totalUserAmount.amount, 20_400_000n);
    // And the funding leg asks for exactly that total, not the provider's figure.
    assert.equal(intent.fundingAmount?.amount, 20_400_000n);
  });

  test("a policy that ESCALATES holds the spend and never auto-approves", async () => {
    const h = await harness({
      fetchImpl: domainsFetch(),
      policy: storedPolicy({ rules: { ...RULES, escalateAbove: 1 } } as Partial<StoredPolicy>),
      escalation: null,
    });
    const intentId = await toQuoted(h);
    const { intent, decision } = await h.orchestrator.runPolicy(intentId);
    assert.equal(decision?.decision, "ESCALATED_THRESHOLD");
    assert.equal(intent.state, "AWAITING_APPROVAL");
    // No escalation pipeline is wired, so it WAITS. It must not have advanced.
    const still = await h.store.getIntent(intentId);
    assert.equal(still?.state, "AWAITING_APPROVAL");
  });

  test("a BLOCKED policy decision stops the intent dead", async () => {
    const h = await harness({
      fetchImpl: domainsFetch(),
      policy: storedPolicy({ rules: { ...RULES, perCallCap: 1, onPerCallCapExceeded: "BLOCK" } } as Partial<StoredPolicy>),
    });
    const intentId = await toQuoted(h);
    const { intent, decision } = await h.orchestrator.runPolicy(intentId);
    assert.equal(decision?.decision, "BLOCKED_PER_CALL_CAP");
    assert.equal(intent.state, "BLOCKED");
  });

  test("a missing policy fails CLOSED with an honest null decision", async () => {
    const h = await harness({ fetchImpl: domainsFetch(), policy: null });
    const intentId = await toQuoted(h);
    const { intent, decision } = await h.orchestrator.runPolicy(intentId);
    assert.equal(intent.state, "BLOCKED");
    // Null, not a fabricated rule trace for an evaluation that never ran.
    assert.equal(decision, null);
  });
});

describe("AC1 + AC7 + AC8 — a full governed action produces a complete receipt", () => {
  test("quote → policy → fund → execute → verify → complete", async () => {
    const h = await harness({ fetchImpl: domainsFetch(), escalation: alwaysApprove });
    const intentId = await toQuoted(h);

    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    assert.equal(funding.amount.amount, 20_400_000n);
    assert.match(funding.url, /\/consumer\/fund\/ci_/);

    const funded = await h.orchestrator.confirmFunding(intentId, {
      intentId,
      chain: "eip155:196",
      txHash: "0xfundingtx",
      amount: funding.amount,
      payer: null,
      settledAt: new Date(NOW).toISOString(),
      confirmations: 12,
      finalized: true,
    });
    assert.equal(funded.state, "FUNDED");

    await h.orchestrator.queueExecution(intentId);
    const executed = await h.orchestrator.executeIntent(intentId);
    assert.equal(executed.state, "PROVIDER_ACKNOWLEDGED");
    assert.equal(h.rail.payments.length, 1);
    assert.equal(h.rail.payments[0]?.amount.amount, 20_000_000n, "the PROVIDER gets its cost, not the total");
    assert.equal(h.rail.payments[0]?.recipient, RECIPIENT);

    const completed = await h.orchestrator.verifyAndComplete(intentId);
    assert.equal(completed.state, "COMPLETED");

    // AC7/AC8: the ledger closes out, and every leg is recorded.
    const groups = await h.store.ledgerGroupsForIntent(intentId);
    assert.deepEqual(groups.map((g) => g.kind).sort(), ["FUNDING", "RECOGNITION", "SETTLEMENT"]);
    assertIntentSettled(intentId, USDT0, groups);
    const balances = projectBalances(groups);
    assert.equal(balances.get(userObligationAccount(USDT0, intentId))?.amount, 0n);
  });

  test("the event stream records the whole lifecycle in order, gaplessly", async () => {
    const h = await harness({ fetchImpl: domainsFetch(), escalation: alwaysApprove });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await h.orchestrator.confirmFunding(intentId, {
      intentId, chain: "eip155:196", txHash: "0xtx2", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    });
    await h.orchestrator.queueExecution(intentId);
    await h.orchestrator.executeIntent(intentId);
    await h.orchestrator.verifyAndComplete(intentId);

    const events = await h.store.eventsSince(intentId, 0, 100);
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "seq must be gapless");
    const names = events.map((e) => e.name);
    assert.ok(names.includes("consumer.intent.created"));
    assert.ok(names.includes("consumer.quote.created"));
    assert.ok(names.includes("consumer.funding.confirmed"));
    assert.ok(names.includes("consumer.provider.paid"));
    assert.ok(names.includes("consumer.delivery.verified"));
    assert.equal(names[names.length - 1], "consumer.completed");
  });

  test("SSE resume from a cursor returns only what followed it", async () => {
    const h = await harness({ fetchImpl: domainsFetch() });
    const intentId = await toQuoted(h);
    const all = await h.store.eventsSince(intentId, 0, 100);
    const resumed = await h.store.eventsSince(intentId, 1, 100);
    assert.equal(resumed.length, all.length - 1);
    assert.equal(resumed[0]?.seq, 2);
  });

  test("the dispatcher publishes to live subscribers and marks rows dispatched", async () => {
    const h = await harness({ fetchImpl: domainsFetch() });
    const intentId = await toQuoted(h);
    const hub = new SseHub();
    const frames: string[] = [];
    hub.subscribe({ intentId, write: (c) => frames.push(c), close: () => undefined });
    const dispatcher = new OutboxDispatcher({ store: h.store, hub, clock: () => NOW });

    const delivered = await dispatcher.drain(100);
    assert.ok(delivered > 0);
    assert.equal((await h.store.pendingOutbox(100)).length, 0, "nothing may be left undispatched");
    assert.ok(frames.length > 0);
    assert.match(frames[0] ?? "", /^id: \d+\nevent: consumer\./);
  });
});

describe("AC6 — execution is idempotent, and a duplicate request never buys twice", () => {
  test("an identical create request replays the SAME intent", async () => {
    const h = await harness({ fetchImpl: domainsFetch() });
    const req = {
      tenantId: "policy:42",
      requestingAgentId: "1",
      principalId: "u",
      action: "domains.register" as const,
      policyId: "42",
      request: { domain: "untchprobe.com" },
      idempotencyKey: "same-key",
      correlationId: "cor",
      intentId: "ci_000000000000000000000001",
    };
    const first = await h.orchestrator.createIntent(req);
    const second = await h.orchestrator.createIntent({ ...req, intentId: "ci_000000000000000000000002" });
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.intent.intentId, first.intent.intentId);
  });

  test("executeIntent on an already-executing intent is a no-op, not a second payment", async () => {
    const h = await harness({ fetchImpl: domainsFetch(), escalation: alwaysApprove });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await h.orchestrator.confirmFunding(intentId, {
      intentId, chain: "eip155:196", txHash: "0xtx3", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    });
    await h.orchestrator.queueExecution(intentId);
    await h.orchestrator.executeIntent(intentId);
    await h.orchestrator.executeIntent(intentId);
    assert.equal(h.rail.payments.length, 1, "exactly one payment may reach the rail");
  });

  test("a duplicate funding settlement is ignored rather than double-credited", async () => {
    const h = await harness({ fetchImpl: domainsFetch() });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    const receipt = {
      intentId, chain: "eip155:196" as CaipChainId, txHash: "0xdup", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    };
    await h.orchestrator.confirmFunding(intentId, receipt);
    await h.orchestrator.confirmFunding(intentId, receipt);
    const groups = await h.store.ledgerGroupsForIntent(intentId);
    assert.equal(groups.filter((g) => g.kind === "FUNDING").length, 1);
  });
});

describe("AC9 + AC10 — failure before payment refunds; ambiguity after payment goes to a human", () => {
  test("a pre-payment refusal reaches REFUND_PENDING and the obligation is discharged", async () => {
    // A paused provider is refused at the gate, AFTER funding — the classic "we have their money and
    // cannot spend it" case.
    const h = await harness({ fetchImpl: domainsFetch(), escalation: alwaysApprove });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await h.orchestrator.confirmFunding(intentId, {
      intentId, chain: "eip155:196", txHash: "0xtx4", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    });
    await h.orchestrator.queueExecution(intentId);

    await h.store.setPause({
      scope: "PROVIDER", target: "stabledomains", paused: true,
      reason: "operator test", setBy: "op", updatedAt: new Date(NOW).toISOString(),
    });

    const failed = await h.orchestrator.executeIntent(intentId);
    assert.equal(failed.state, "REFUND_PENDING");
    assert.equal(h.rail.payments.length, 0, "no payment may have been attempted");
    const groups = await h.store.ledgerGroupsForIntent(intentId);
    assert.ok(groups.some((g) => g.kind === "REFUND"));
    assertIntentSettled(intentId, USDT0, groups);
  });

  test("an AMBIGUOUS paid retry lands in MANUAL_REVIEW with the money in SUSPENSE", async () => {
    const h = await harness({
      fetchImpl: domainsFetch({ failPaidRetry: Object.assign(new Error("socket hang up"), { name: "TypeError" }) }),
      escalation: alwaysApprove,
    });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await h.orchestrator.confirmFunding(intentId, {
      intentId, chain: "eip155:196", txHash: "0xtx5", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    });
    await h.orchestrator.queueExecution(intentId);

    const reviewed = await h.orchestrator.executeIntent(intentId);
    assert.equal(reviewed.state, "MANUAL_REVIEW");
    assert.equal(reviewed.failureCode, "PAYMENT_AMBIGUOUS");

    // The execution row survives with its ambiguity recorded — that is what the reconciler finds.
    const executions = await h.store.listExecutions(intentId);
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.state, "AMBIGUOUS");

    // And the money is parked, not lost and not spent.
    const groups = await h.store.ledgerGroupsForIntent(intentId);
    assert.ok(groups.some((g) => g.kind === "SUSPENSE_MOVE"));
    assertIntentSettled(intentId, USDT0, groups);
  });

  test("an ambiguous outcome is NEVER retried — the executor refuses to re-enter", async () => {
    const h = await harness({
      fetchImpl: domainsFetch({ failPaidRetry: Object.assign(new Error("timeout"), { name: "AbortError" }) }),
      escalation: alwaysApprove,
    });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await h.orchestrator.confirmFunding(intentId, {
      intentId, chain: "eip155:196", txHash: "0xtx6", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    });
    await h.orchestrator.queueExecution(intentId);
    await h.orchestrator.executeIntent(intentId);

    // A worker sweep would call this again. MANUAL_REVIEW is not EXECUTION_QUEUED, so it returns
    // unchanged — and the state machine forbids the edge back anyway.
    const again = await h.orchestrator.executeIntent(intentId);
    assert.equal(again.state, "MANUAL_REVIEW");
    assert.equal((await h.store.listExecutions(intentId)).length, 1);
  });
});

describe("feature flags — execution is OFF unless every switch says otherwise", () => {
  test("a fully verified, funded, approved intent STILL refuses when execution is switched off", async () => {
    // The default posture of every fresh deployment. Nothing about the intent is wrong; the
    // instance simply has not been told it may spend.
    const h = await harness({ fetchImpl: domainsFetch(), escalation: alwaysApprove, flagsOff: true });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await h.orchestrator.confirmFunding(intentId, {
      intentId, chain: "eip155:196", txHash: "0xflagoff", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    });
    await h.orchestrator.queueExecution(intentId);
    const failed = await h.orchestrator.executeIntent(intentId);
    assert.equal(failed.failureCode, "PROVIDER_NOT_EXECUTABLE");
    assert.match(failed.failureDetail ?? "", /CONSUMER_PACK_ENABLED|CONSUMER_EXECUTION_ENABLED/);
    assert.equal(h.rail.payments.length, 0, "no payment may be attempted with execution disabled");
  });
});

describe("AC12 + AC17 — kill switches, and nothing executes above its proven maturity", () => {
  test("a SANDBOX provider cannot execute by default", async () => {
    const h = await harness({ fetchImpl: domainsFetch(), maturity: "sandbox", escalation: alwaysApprove });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await h.orchestrator.confirmFunding(intentId, {
      intentId, chain: "eip155:196", txHash: "0xtx7", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    });
    await h.orchestrator.queueExecution(intentId);
    const failed = await h.orchestrator.executeIntent(intentId);
    assert.equal(failed.state, "REFUND_PENDING");
    assert.equal(failed.failureCode, "PROVIDER_NOT_EXECUTABLE");
    assert.equal(h.rail.payments.length, 0);
  });

  test("a GLOBAL pause stops execution and refunds", async () => {
    const h = await harness({ fetchImpl: domainsFetch(), escalation: alwaysApprove });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await h.orchestrator.confirmFunding(intentId, {
      intentId, chain: "eip155:196", txHash: "0xtx8", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    });
    await h.orchestrator.queueExecution(intentId);
    await h.store.setPause({
      scope: "GLOBAL", target: "*", paused: true, reason: "kill switch",
      setBy: "op", updatedAt: new Date(NOW).toISOString(),
    });
    const failed = await h.orchestrator.executeIntent(intentId);
    assert.equal(failed.failureCode, "PAUSED");
    assert.equal(h.rail.payments.length, 0);
  });
});

describe("the approval binds to what was approved, and nothing else", () => {
  test("a policy edited AFTER approval invalidates it", async () => {
    let policy = storedPolicy({ rules: { ...RULES, escalateAbove: 1 } } as Partial<StoredPolicy>);
    const h = await harness({ fetchImpl: domainsFetch(), escalation: alwaysApprove, policy });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    await h.orchestrator.resolveApproval(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await h.orchestrator.confirmFunding(intentId, {
      intentId, chain: "eip155:196", txHash: "0xtx9", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    });
    await h.orchestrator.queueExecution(intentId);

    // The operator revises the policy between approval and execution.
    policy = storedPolicy({ version: 2, policyHash: `0x${"cd".repeat(32)}` });
    (h.orchestrator as unknown as { d: { policyProvider: PolicyProvider } }).d.policyProvider =
      fakePolicyProvider(policy);

    const failed = await h.orchestrator.executeIntent(intentId);
    assert.equal(failed.failureCode, "PROVIDER_UNAUTHORIZED");
    assert.match(failed.failureDetail ?? "", /changed after approval/);
    assert.equal(h.rail.payments.length, 0);
  });

  test("a stale quote blocks execution", async () => {
    const h = await harness({ fetchImpl: domainsFetch(), escalation: alwaysApprove });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await h.orchestrator.confirmFunding(intentId, {
      intentId, chain: "eip155:196", txHash: "0xtxA", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    });
    await h.orchestrator.queueExecution(intentId);
    // Wind the clock past the quote's TTL.
    (h.orchestrator as unknown as { clock: () => number }).clock = () => NOW + 3_600_000;
    const failed = await h.orchestrator.executeIntent(intentId);
    assert.equal(failed.failureCode, "QUOTE_EXPIRED");
    assert.equal(h.rail.payments.length, 0);
  });
});

describe("AC4 — the funding price function", () => {
  test("it quotes the intent's EXACT authorised amount", async () => {
    const h = await harness({ fetchImpl: domainsFetch() });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    await h.orchestrator.requestFunding(intentId);

    const price = makeFundingPrice({ store: h.store, clock: () => NOW });
    const quoted = await price({ path: `/consumer/fund/${intentId}` });
    assert.equal(quoted.amount, "20400000");
    assert.equal(quoted.asset, USDT0.address);
  });

  for (const [label, prepare, expectedCode] of [
    ["an unknown intent", async () => "ci_doesnotexist000000000", "INTENT_NOT_FOUND"],
    [
      "an intent that has not reached AWAITING_FUNDING",
      async (h: Harness) => toQuoted(h),
      "INTENT_NOT_AWAITING_FUNDING",
    ],
  ] as const) {
    test(`it REFUSES ${label} rather than falling back to a default price`, async () => {
      const h = await harness({ fetchImpl: domainsFetch() });
      const intentId = await prepare(h);
      const price = makeFundingPrice({ store: h.store, clock: () => NOW });
      await assert.rejects(() => price({ path: `/consumer/fund/${intentId}` }), (e: unknown) => {
        assert.ok(e instanceof FundingPriceError);
        assert.equal(e.code, expectedCode);
        return true;
      });
    });
  }

  test("it refuses an intent that has ALREADY been funded", async () => {
    const h = await harness({ fetchImpl: domainsFetch() });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await h.orchestrator.confirmFunding(intentId, {
      intentId, chain: "eip155:196", txHash: "0xtxB", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    });
    const price = makeFundingPrice({ store: h.store, clock: () => NOW });
    await assert.rejects(() => price({ path: `/consumer/fund/${intentId}` }), /ALREADY_FUNDED|not AWAITING_FUNDING/);
  });

  test("it refuses an EXPIRED funding window", async () => {
    const h = await harness({ fetchImpl: domainsFetch() });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    await h.orchestrator.requestFunding(intentId);
    const price = makeFundingPrice({ store: h.store, clock: () => NOW + 7_200_000 });
    await assert.rejects(() => price({ path: `/consumer/fund/${intentId}` }), (e: unknown) => {
      assert.ok(e instanceof FundingPriceError);
      assert.ok(e.code === "FUNDING_EXPIRED" || e.code === "QUOTE_EXPIRED");
      return true;
    });
  });

  test("it refuses a malformed path", async () => {
    const h = await harness({ fetchImpl: domainsFetch() });
    const price = makeFundingPrice({ store: h.store, clock: () => NOW });
    await assert.rejects(() => price({ path: "/consumer/fund/" }), (e: unknown) => {
      assert.ok(e instanceof FundingPriceError);
      assert.equal(e.code, "BAD_FUNDING_PATH");
      return true;
    });
  });

  test("the path parser accepts only a plausible intent id", () => {
    assert.equal(intentIdFromFundingPath("/consumer/fund/ci_abc123"), "ci_abc123");
    assert.equal(intentIdFromFundingPath("/consumer/fund/ci_abc123?x=1"), "ci_abc123");
    assert.equal(intentIdFromFundingPath("/consumer/fund/../../etc/passwd"), null);
    assert.equal(intentIdFromFundingPath("/other/path"), null);
  });
});

describe("underpayment and treasury exhaustion", () => {
  test("funding LESS than the authorised amount is refused", async () => {
    const h = await harness({ fetchImpl: domainsFetch() });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await assert.rejects(
      () =>
        h.orchestrator.confirmFunding(intentId, {
          intentId, chain: "eip155:196", txHash: "0xshort",
          amount: money(funding.amount.amount - 1n, funding.amount.asset),
          payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
        }),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "PAYMENT_FAILED");
        return true;
      },
    );
    assert.equal((await h.store.getIntent(intentId))?.state, "AWAITING_FUNDING");
  });

  test("an insufficient provider float refuses BEFORE payment and refunds", async () => {
    const h = await harness({ fetchImpl: domainsFetch(), escalation: alwaysApprove, railBalance: 1n });
    const intentId = await toQuoted(h);
    await h.orchestrator.runPolicy(intentId);
    const { funding } = await h.orchestrator.requestFunding(intentId);
    await h.orchestrator.confirmFunding(intentId, {
      intentId, chain: "eip155:196", txHash: "0xtxC", amount: funding.amount,
      payer: null, settledAt: new Date(NOW).toISOString(), confirmations: 12, finalized: true,
    });
    await h.orchestrator.queueExecution(intentId);
    const failed = await h.orchestrator.executeIntent(intentId);
    assert.equal(failed.failureCode, "TREASURY_INSUFFICIENT");
    assert.equal(h.rail.payments.length, 0);
  });
});

describe("expiry sweep", () => {
  test("a lapsed intent expires and never executes", async () => {
    const h = await harness({ fetchImpl: domainsFetch() });
    const intentId = await toQuoted(h);
    (h.orchestrator as unknown as { clock: () => number }).clock = () => NOW + 7_200_000;
    const expired = await h.orchestrator.expireStale(10);
    assert.equal(expired, 1);
    assert.equal((await h.store.getIntent(intentId))?.state, "EXPIRED");
  });
});
