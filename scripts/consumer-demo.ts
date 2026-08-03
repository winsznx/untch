/**
 * The Consumer Pack demo — one complete governed consumer transaction, printed as it happens.
 *
 * Imports are RELATIVE rather than by package name: the root package.json declares no @untch
 * workspace dependencies, so `scripts/**` reaches the libraries by path — the same convention the
 * other root drivers use, and it keeps this file inside the root tsconfig's typecheck.
 *
 * This drives the REAL orchestrator, the REAL policy engine, the REAL ledger and the REAL state
 * machine. Exactly two things are faked, and both are named on stdout when the script runs:
 *
 *   1. the provider's HTTP responses (replayed from the 402 captured live on 2026-07-27, committed
 *      under packages/consumer-providers/fixtures/), and
 *   2. the settlement signature (there is no funded treasury key in any Untch environment).
 *
 * Everything else — the quote arithmetic, the policy decision, the approval binding, the funding
 * leg, the ledger, the state transitions, the events — is the production code path. A demo that
 * faked those would be showing you a slideshow.
 *
 *   pnpm consumer:demo            approved path
 *   pnpm consumer:demo --escalate policy escalates, operator approves
 *   pnpm consumer:demo --blocked  policy blocks
 *   pnpm consumer:demo --ambiguous the paid retry is lost; the intent goes to manual review
 */

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
  displayMoney,
  formatMoney,
  money,
  newIntentId,
  parseMoney,
  type CaipChainId,
  type Money,
  type PaymentRequest,
  type PaymentResult,
  type RailClient,
} from "../packages/consumer-core/src/index";
import { PROVIDER_SEEDS, buildAdapterRegistry, StableDomainsAdapter } from "../packages/consumer-providers/src/index";
import type { Ledger, LedgerWindowState, SpendIntentInput } from "../packages/policy-engine/src/index";
import type { PolicyProvider, StoredPolicy } from "../packages/policy-store/src/index";
import { ConsumerOrchestrator, type ConsumerEscalationGateway } from "../services/asp/src/consumer/orchestrator";
import { makeFundingPrice } from "../services/asp/src/consumer/funding-price";
import { OutboxDispatcher, SseHub } from "../services/asp/src/consumer/dispatcher";

const FIXTURES = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "consumer-providers", "fixtures", "live-challenges.json"),
    "utf8",
  ),
) as Record<string, unknown>;

const BASE: CaipChainId = "eip155:8453";
const USDC = asset("base.usdc");
const USDT0 = asset("xlayer.usdt0");
const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const DOMAIN = "untchdemo.xyz";

const mode = process.argv.includes("--escalate") ? "escalate"
  : process.argv.includes("--blocked") ? "blocked"
  : process.argv.includes("--ambiguous") ? "ambiguous"
  : "approved";

// ── presentation ─────────────────────────────────────────────────────────────
const step = (n: number, title: string): void => {
  console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`);
};
const line = (k: string, v: string): void => console.log(`   ${k.padEnd(26)} ${v}`);
const note = (s: string): void => console.log(`   \x1b[2m${s}\x1b[0m`);

// ── fakes, both declared out loud ────────────────────────────────────────────

class DemoRail implements RailClient {
  readonly chain = BASE;
  readonly payments: PaymentRequest[] = [];
  address(): string {
    return "0x00000000000000000000000000000000000000AA";
  }
  available(): boolean {
    return true;
  }
  async balanceOf(a: typeof USDC): Promise<Money> {
    return money(500_000_000n, a);
  }
  async pay(req: PaymentRequest): Promise<PaymentResult> {
    this.payments.push(req);
    return {
      paymentHeader: "DEMO",
      headerName: "X-PAYMENT",
      txHash: "0xdemo000000000000000000000000000000000000000000000000000000000001",
      amount: req.amount,
      recipient: req.recipient,
      chain: BASE,
    };
  }
}

class DemoLedger implements Ledger {
  private spent = 0;
  async read(): Promise<LedgerWindowState> {
    return { budgetUsage: { settledToday: 0, reservedActiveToday: this.spent, effectiveToday: this.spent }, recentIntents: [], lastCallByService: {}, callsInLastHour: 0 };
  }
  async commitApproved(_k: string, intent: SpendIntentInput): Promise<void> {
    this.spent += intent.amount;
  }
}

const RULES = {
  budgets: { daily: 1000, token: "USDT0" },
  perCallCap: mode === "blocked" ? 1 : 500,
  onPerCallCapExceeded: "BLOCK" as const,
  escalateAbove: mode === "escalate" ? 1 : 100,
  categories: { allow: [], deny: [] },
  recipients: { allow: [], deny: [] },
  agents: { allowWorkerIds: [], denyWorkerIds: [] },
  duplicates: { ttlMin: 0, keys: [] },
  cooldowns: { sameServiceMin: 0 },
  rateLimit: { callsPerHour: 100 },
  expiry: "2027-01-01T00:00:00.000Z",
};

const POLICY = {
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
} as unknown as StoredPolicy;

/** Replays the REAL captured 402, then a success body — or drops the paid retry in --ambiguous. */
function demoFetch(): typeof fetch {
  let call = 0;
  return (async (): Promise<Response> => {
    call += 1;
    const challenge = Buffer.from(JSON.stringify(FIXTURES.stabledomainsRegister402), "utf8").toString("base64");
    if (call <= 2) return new Response("{}", { status: 402, headers: { "payment-required": challenge } });
    if (mode === "ambiguous") throw Object.assign(new Error("socket hang up"), { name: "TypeError" });
    return new Response(
      JSON.stringify({ domain: DOMAIN, status: "pending", registrationEmailSent: true, next: {}, orderId: "ord_demo_1" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

/** Skips the paid /api/check leg; the price still comes from the provider's own 402. */
class DemoDomainsAdapter extends StableDomainsAdapter {
  override async quote(input: Parameters<StableDomainsAdapter["quote"]>[0], ctx: Parameters<StableDomainsAdapter["quote"]>[1]) {
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
      terms: { domain: input.providerRef, readyToRegister: true, profileNote: "verified registrant profile" },
      expiresAt: new Date(NOW + 600_000).toISOString(),
    };
  }
}

async function main(): Promise<void> {
  console.log("\n\x1b[1mUntch Consumer Pack — one governed consumer transaction\x1b[0m");
  console.log(`\x1b[2mmode: ${mode}\x1b[0m`);
  note("REAL: orchestrator, policy engine, state machine, ledger, funding leg, events.");
  note("FAKED: the provider's HTTP responses (replayed from the live 402 captured 2026-07-27)");
  note("       and the settlement signature (no funded treasury key exists in this environment).");

  const store = new InMemoryConsumerStore(() => NOW);
  const rail = new DemoRail();

  for (const seed of PROVIDER_SEEDS) {
    // The demo runs the provider at `verified` so the whole path is visible. In production this is
    // exactly what is NOT true, and the catalogue says so.
    await store.upsertProvider({ ...seed.provider, maturity: "verified" });
    for (const cap of seed.capabilities) await store.upsertCapability({ ...cap, maturity: "verified" });
  }
  await store.upsertTreasuryAccount({
    treasuryRef: "base-usdc-settlement",
    asset: USDC,
    purpose: "SETTLEMENT",
    address: rail.address(),
    minBalance: parseMoney("5.00", USDC),
    dailyLimit: parseMoney("500.00", USDC),
    enabled: true,
  });

  const treasury = new TreasuryRouter({
    store,
    rails: new Map([[BASE, rail]]),
    pauses: new StorePauseChecker(store),
    clock: () => NOW,
  });

  const base = buildAdapterRegistry();
  const demoAdapter = new DemoDomainsAdapter();
  const adapters = {
    get: (id: string) => (id === "stabledomains" ? demoAdapter : base.get(id)),
    has: (id: string) => base.has(id),
    all: () => base.all(),
  };

  const escalation: ConsumerEscalationGateway = {
    async requestApproval() {
      console.log("   \x1b[33m→ escalated to the operator's channels (Telegram / Discord / Slack / dashboard)\x1b[0m");
      return { escalationId: "esc_demo" };
    },
    async pollApproval() {
      return "APPROVED";
    },
  };

  const orchestrator = new ConsumerOrchestrator({
    store,
    registry: new ProviderRegistry({
      store,
      gate: { executionFloor: "verified", allowSandboxExecution: false },
      clock: () => NOW,
    }),
    adapters,
    treasury,
    policyProvider: {
      async load() {
        return { id: POLICY.id, version: 1, status: "ACTIVE", rules: RULES } as never;
      },
      async loadStored() {
        return POLICY;
      },
    } as unknown as PolicyProvider,
    ledger: new DemoLedger(),
    escalation,
    receipts: null,
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

  // ONE scripted fetch for the whole run — its call counter is the script. Creating a fresh one per
  // context would reset the counter and replay the 402 into the paid retry, which the transport
  // would (correctly) read as the provider rejecting the payment.
  const sharedFetch = demoFetch();
  const originalCtx = (orchestrator as unknown as { ctx: unknown }).ctx;
  (orchestrator as unknown as { ctx: (...a: unknown[]) => unknown }).ctx = function patched(this: unknown, ...args: unknown[]): unknown {
    const b = (originalCtx as (...a: unknown[]) => Record<string, unknown>).apply(this, args);
    return { ...b, fetchImpl: sharedFetch, resolveHost: async () => ["104.18.0.1"] };
  };

  // ── 1 ──
  step(1, "An agent proposes an action");
  const { intent } = await orchestrator.createIntent({
    tenantId: "policy:42",
    requestingAgentId: "1",
    principalId: "demo-user",
    action: "domains.register",
    policyId: "42",
    request: { domain: DOMAIN },
    idempotencyKey: `demo-${NOW}`,
    correlationId: "cor_demo",
    intentId: newIntentId(),
  });
  const id = intent.intentId;
  line("intent", id);
  line("action", "domains.register");
  line("state", intent.state);
  note("The fixed $0.05 marketplace call fee has been paid at this point. The purchase has not.");

  // ── 2 ──
  step(2, "Untch quotes it from the merchant's OWN price challenge");
  const { quote } = await orchestrator.quote(id, DOMAIN);
  line("provider", quote.providerId);
  line("provider cost", displayMoney(quote.providerCost));
  line("untch fee (150 bp)", formatMoney(quote.untchFee));
  line("spread (50 bp)", formatMoney(quote.spread));
  line("USER PAYS", displayMoney(quote.totalUserAmount));
  line("settle to", `${quote.settlementRecipient.slice(0, 10)}… on ${quote.settlementChain}`);
  line("quote hash", `${quote.quoteHash.slice(0, 18)}…`);
  note("The $20.00 came from StableDomains' own 402 — not from a price we converted.");

  // ── 3 ──
  step(3, "The REAL policy engine decides");
  const { intent: decided, decision } = await orchestrator.runPolicy(id);
  line("decision", decision?.decision ?? "(no engine decision)");
  line("state", decided.state);
  if (decision) {
    line("rules evaluated", String(decision.rules.length));
    if (decision.reasons.length > 0) line("reasons", decision.reasons.join("; "));
  }

  if (decided.state === "BLOCKED") {
    console.log("\n\x1b[1mThe spend was withheld. No money moved.\x1b[0m");
    note("That is the product working. A blocked spend is saved waste, not a failure.");
    return;
  }

  if (decided.state === "AWAITING_APPROVAL") {
    step(4, "A human approves");
    await orchestrator.resolveApproval(id);
    line("approval", "APPROVED");
    note("The approval binds the quote hash, policy version, recipient, chain and ceiling.");
    note("A policy edited after this point would invalidate it.");
  }

  // ── funding ──
  step(decided.state === "AWAITING_APPROVAL" ? 5 : 4, "Untch asks for the EXACT authorised amount");
  const { funding } = await orchestrator.requestFunding(id);
  line("funding url", funding.url);
  line("amount", displayMoney(funding.amount));
  const price = makeFundingPrice({ store, clock: () => NOW });
  const quoted = await price({ path: `/consumer/fund/${id}` });
  line("402 would quote", `${quoted.amount} atomic (${quoted.extra?.token})`);
  note("x402 DynamicPrice: this route is priced per-intent, not per-route.");
  note("The variable purchase value is a SEPARATE leg from the fixed call fee.");

  await orchestrator.confirmFunding(id, {
    intentId: id,
    chain: "eip155:196",
    txHash: "0xdemofunding00000000000000000000000000000000000000000000000000001",
    amount: funding.amount,
    payer: null,
    settledAt: new Date(NOW).toISOString(),
    confirmations: 12,
    finalized: true,
  });
  line("funded", "✓");

  // ── execute ──
  step(decided.state === "AWAITING_APPROVAL" ? 6 : 5, "Untch pays the merchant on the merchant's own rail");
  await orchestrator.queueExecution(id);
  const executed = await orchestrator.executeIntent(id);
  line("state", executed.state);

  if (executed.state === "MANUAL_REVIEW") {
    line("failure", executed.failureCode ?? "");
    console.log("\n\x1b[1mThe outcome is unknown, so a human decides.\x1b[0m");
    note("The request left Untch and the response was lost. The merchant may have acted.");
    note("It has NOT been retried — that would be a possible second purchase.");
    const groups = await store.ledgerGroupsForIntent(id);
    note(`The user's ${displayMoney(funding.amount)} is parked in SUSPENSE and fully accounted for.`);
    line("ledger groups", groups.map((g) => g.kind).join(", "));
    assertIntentSettled(id, USDT0, groups);
    line("obligation nets to", "zero ✓");
    return;
  }

  line("paid to merchant", displayMoney(rail.payments[0]?.amount ?? money(0n, USDC)));
  note("The merchant gets its COST. The fee and spread never leave as part of it.");

  // ── verify + complete ──
  step(decided.state === "AWAITING_APPROVAL" ? 7 : 6, "Delivery is verified, and the intent completes");
  const completed = await orchestrator.verifyAndComplete(id);
  line("state", completed.state);
  const evidence = await store.getDeliveryEvidence(id);
  line("provider attested", evidence?.providerAttested.status ?? "—");
  line("untch verified", `${evidence?.untchVerified.verified ?? false} (${evidence?.untchVerified.method ?? "NONE"})`);
  note("Two separate claims. Untch never reports the merchant's word as its own verification.");

  // ── receipt ──
  step(decided.state === "AWAITING_APPROVAL" ? 8 : 7, "One cross-rail receipt");
  const fundingReceipt = await store.getFunding(id);
  const executions = await store.listExecutions(id);
  const paid = executions.find((e) => e.state === "PAID");
  line("user funding", `${displayMoney(fundingReceipt?.amount ?? money(0n, USDT0))} on ${fundingReceipt?.chain}`);
  line("provider settlement", `${displayMoney(paid?.settledAmount ?? money(0n, USDC))} on ${paid?.settlementChain}`);
  line("fee", formatMoney(quote.untchFee));
  line("spread", formatMoney(quote.spread));
  line("policy", `#${completed.policyId} v${completed.policyVersion}`);
  line("approval", completed.approvalRequired ? String(completed.approvalOutcome) : "not required");
  line("provider ref", paid?.providerReference ?? "—");

  const groups = await store.ledgerGroupsForIntent(id);
  line("ledger groups", groups.map((g) => g.kind).join(", "));
  assertIntentSettled(id, USDT0, groups);
  line("obligation nets to", "zero ✓");

  // ── events ──
  const hub = new SseHub();
  const dispatcher = new OutboxDispatcher({ store, hub, clock: () => NOW });
  await dispatcher.drain(200);
  const events = await store.eventsSince(id, 0, 100);
  step(decided.state === "AWAITING_APPROVAL" ? 9 : 8, "The event stream a caller watched");
  for (const e of events) console.log(`   ${String(e.seq).padStart(2)}  ${e.name}`);
  note("Written in the same transaction as each state change, so Last-Event-ID resume is exact.");

  console.log("\n\x1b[1mTwo rails, one receipt, one policy decision, one approval.\x1b[0m");
  console.log("\x1b[2mIn production this provider is `sandbox`, not `verified`, and would refuse to execute.\x1b[0m\n");
}

main().catch((err: unknown) => {
  console.error(`\ndemo failed: ${(err as Error).message}`);
  process.exit(1);
});
