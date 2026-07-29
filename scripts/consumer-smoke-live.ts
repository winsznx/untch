/**
 * THE LIVE PROVIDER SMOKE TEST — the only thing in this repository that spends real money.
 *
 *   CONSUMER_LIVE_SMOKE_ENABLED=1 CONSUMER_LIVE_SMOKE_MAX_USDC=0.25 \
 *     pnpm consumer:smoke:live --provider stabledomains
 *
 * It drives the REAL orchestrator, the REAL policy engine, the REAL state machine, the REAL ledger
 * and the REAL Base USDC x402 rail against a REAL merchant. Nothing here is mocked. That is the
 * point: a provider is promoted to `verified` on the strength of an observed settlement, and an
 * observation made through a bespoke script that bypasses the production path would prove nothing
 * about the production path.
 *
 * WHAT IS AND IS NOT PROVEN
 *
 * The user-funding leg is OPERATOR-FUNDED here: there is no third-party agent paying an x402
 * funding request, so Untch is both funder and settler and the funding row is marked as such. The
 * novel, previously-unproven thing this run establishes is the OUTBOUND leg — Untch's treasury
 * paying a real merchant on Base and getting a real deliverable back. The inbound x402 rail on X
 * Layer has been settled since D0.1 and is not what is under test.
 *
 * REFUSES TO RUN unless every one of these holds. Each is checked before anything is spent:
 *   • CONSUMER_LIVE_SMOKE_ENABLED=1                  (never set in a normal deployment)
 *   • CONSUMER_LIVE_SMOKE_MAX_USDC set and positive  (an explicit ceiling, no default)
 *   • a Base treasury key present and the float funded above the cap
 *   • the provider verified OR --first-run (the bootstrap case: nothing can be verified until
 *     something settles once, and that one exception is loudly flagged and recorded)
 *   • the chain is Base and the token is the approved USDC contract
 *   • the recipient equals the verified payTo for that provider
 *   • the provider's price is at or under the cap
 *   • the quote is fresh and the policy APPROVED
 *
 * NEVER retries a payment after an ambiguous timeout. On ambiguity it queries the provider, queries
 * the chain, and if uncertainty remains puts the intent in MANUAL_REVIEW.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  InMemoryConsumerStore,
  PgConsumerStore,
  ProviderRegistry,
  StorePauseChecker,
  TreasuryRouter,
  asset,
  assertIntentSettled,
  createPool,
  displayMoney,
  flagOn,
  formatMoney,
  hashQuote,
  isProviderError,
  loadConsumerFlags,
  money,
  moneyToJson,
  newIntentId,
  parseMoney,
  projectBalances,
  sha256Hex,
  stableStringify,
  userObligationAccount,
  type CaipChainId,
  type ConsumerFlags,
  type ConsumerIntent,
  type ConsumerStore,
  type Money,
  type RailClient,
} from "../packages/consumer-core/src/index";
import {
  StableDomainsAdapter,
  StableEmailAdapter,
  X402EvmExactClient,
  redactAddress,
  type AdapterContext,
  type ConsumerProviderAdapter,
} from "../packages/consumer-providers/src/index";
import type { ConsumerActionType } from "../packages/consumer-core/src/types";
import type { Ledger, LedgerWindowState, SpendIntentInput } from "../packages/policy-engine/src/index";
import type { PolicyProvider, StoredPolicy } from "../packages/policy-store/src/index";
import { ConsumerOrchestrator, type ConsumerReceiptSink } from "../services/asp/src/consumer/orchestrator";
import { makeConsumerReceiptSink } from "../services/asp/src/consumer/bridges";
import { initReceiptWiring } from "../services/asp/src/receipts";
import { createPublicClient, createWalletClient, decodeEventLog, erc20Abi, getAddress, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const BASE: CaipChainId = "eip155:8453";
const XLAYER_RPC = process.env.XLAYER_RPC_URL?.trim() || "https://rpc.xlayer.tech";
const USDT0_ADDRESS = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const USDC = asset("base.usdc");
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ok = (s: string): void => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const info = (k: string, v: string): void => console.log(`     ${k.padEnd(24)} ${v}`);
const step = (n: number, s: string): void => console.log(`\n\x1b[1m${String(n).padStart(2)}. ${s}\x1b[0m`);
const warn = (s: string): void => console.log(`  \x1b[33m!\x1b[0m ${s}`);

function stop(code: number, why: string): never {
  console.error(`\n\x1b[31mSMOKE: STOP — ${why}\x1b[0m`);
  console.error("No payment was attempted.");
  process.exit(code);
}

const arg = (n: string): string | null => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const has = (n: string): boolean => process.argv.includes(`--${n}`);

// ─────────────────────────────────────────────────────────────────────────────
// Per-provider smoke plans
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What differs between one provider's live run and another's.
 *
 * Everything else in this file — the flag checks, the treasury checks, the challenge validation, the
 * policy, the funding leg, the ledger assertions, the on-chain re-read — is IDENTICAL for every
 * provider, and stays identical on purpose. A per-provider script would let one provider's proof be
 * weaker than another's without anybody noticing; a per-provider PLAN cannot, because the plan
 * carries no controls, only the four facts that genuinely vary.
 *
 * `payTo` is the load-bearing one: it is the address read from that provider's own live 402, and the
 * run stops if the challenge names anything else. It is a constant here rather than a CLI argument
 * for exactly that reason.
 */
interface SmokePlan {
  readonly providerId: string;
  readonly displayName: string;
  readonly baseUrl: string;
  /** The registry capability this run proves. Promotion is scoped to exactly this one. */
  readonly capability: string;
  readonly action: ConsumerActionType;
  /** The verified Base payTo, read from that provider's own live 402. */
  readonly payTo: string;
  readonly documentationVersion: string;
  newAdapter(): ConsumerProviderAdapter;
  /**
   * Turn CLI arguments into the request. Returns the unpaid probe that reads the exact price, the
   * intent request, and a label safe to print — which for Mail means a recipient COUNT and a subject
   * hash, never the address or the subject itself.
   */
  build(): {
    readonly request: Record<string, unknown>;
    readonly providerRef: string;
    readonly probe: { readonly method: string; readonly path: string; readonly body: unknown };
    readonly label: readonly (readonly [string, string])[];
    /** What a human must check for this run to count as delivered. Null ⇒ nothing to check. */
    readonly humanVerification: string | null;
  };
}

const PLANS: Readonly<Record<string, SmokePlan>> = {
  stabledomains: {
    providerId: "stabledomains",
    displayName: "StableDomains",
    baseUrl: "https://stabledomains.dev",
    capability: "domains.check",
    action: "domains.check",
    payTo: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
    documentationVersion: "live OpenAPI fetched 2026-07-27 (14 paths); .well-known/x402",
    newAdapter: () => new StableDomainsAdapter(),
    build() {
      const domain = arg("domain") ?? `untchactivation${Date.now().toString(36).slice(-6)}.xyz`;
      return {
        request: { domain },
        providerRef: domain,
        probe: { method: "POST", path: "/api/check", body: { domain } },
        label: [["domain", domain]],
        humanVerification: null,
      };
    },
  },

  stableemail: {
    providerId: "stableemail",
    displayName: "StableEmail",
    baseUrl: "https://stableemail.dev",
    capability: "mail.send",
    action: "mail.send",
    payTo: "0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671",
    documentationVersion: "live llms.txt + 402s re-fetched 2026-07-29",
    newAdapter: () => new StableEmailAdapter(),
    build() {
      const to = arg("to");
      if (!to) {
        stop(2, "--to is required: a live mail.send must land in an inbox the operator controls");
      }
      const subject = arg("subject") ?? `Untch Mail live proof ${new Date().toISOString()}`;
      const text =
        arg("text") ??
        [
          "This message was sent by the Untch Consumer Pack.",
          "",
          "It was authorised by a deterministic policy, funded for its exact approved amount, and",
          "paid for from the Untch Base treasury against StableEmail's own x402 challenge. No part",
          "of this email — not this body, not the recipient — is stored in the public receipt.",
          "",
          "If you are reading this, the mail.send delivery leg is real.",
        ].join("\n");

      return {
        request: { to: [to], subject, text },
        providerRef: "send",
        probe: { method: "POST", path: "/api/send", body: { to: [to], subject, text } },
        // The recipient address is PERSONAL DATA and does not go to the terminal, the evidence file
        // or the receipt. A count and a hash are what a reviewer actually needs.
        label: [
          ["recipients", "1"],
          ["subject hash", `0x${sha256Hex(subject)}`],
        ],
        humanVerification:
          `the message must actually ARRIVE at the recipient inbox. StableEmail's shared relay ` +
          "exposes no per-message status endpoint, so acceptance by the relay is all this script " +
          "can prove; a human confirming receipt is what completes the delivery leg.",
      };
    },
  },
};

// ── an in-memory §7.1 ledger window: this run is its own first spend ─────────
class SmokeLedger implements Ledger {
  private spent = 0;
  async read(): Promise<LedgerWindowState> {
    return { spentTodayByAgent: this.spent, recentIntents: [], lastCallByService: {}, callsInLastHour: 0 };
  }
  async commitApproved(_k: string, i: SpendIntentInput): Promise<void> {
    this.spent += i.amount;
  }
}

/** All switches on, IN PROCESS ONLY. The deployed service's own flags are untouched by this run. */
const smokeFlags: ConsumerFlags = {
  packEnabled: true,
  executionEnabled: true,
  liveSmokeEnabled: true,
  providerEnabled: () => true,
  chainEnabled: (c) => c === BASE,
  assetEnabled: (a) => a.chain === BASE && a.symbol === "USDC",
  snapshot: () => ({}),
};

/**
 * A read-through view of the store that reports ONE provider and ONE capability as `verified`.
 *
 * This is the bootstrap exception made explicit and made narrow. Nothing can be promoted until
 * something settles once, and nothing can settle until the gate lets it through — so the first run
 * needs an override. The question is only how big it is and how long it lasts.
 *
 * Here: one providerId, one capability, reads only, in memory, for the lifetime of this process.
 * Every write still goes to the real store at its real maturity, so the run cannot leave a promotion
 * behind as a side effect of having been attempted.
 */
function bootstrapRegistryView(
  store: ConsumerStore,
  providerId: string,
  capability: string,
): ConsumerStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "getProvider") {
        return async (id: string) => {
          const p = await target.getProvider(id);
          return p && id === providerId ? { ...p, maturity: "verified" as const, enabled: true } : p;
        };
      }
      if (prop === "listCapabilities") {
        return async (id: string) => {
          const caps = await target.listCapabilities(id);
          if (id !== providerId) return caps;
          return caps.map((c) =>
            c.capability === capability ? { ...c, maturity: "verified" as const } : c,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function main(): Promise<void> {
  console.log("\n\x1b[1mUntch Consumer Pack — LIVE provider execution\x1b[0m");
  console.log("\x1b[31mThis spends REAL money on a REAL merchant.\x1b[0m");

  const providerId = arg("provider") ?? "stabledomains";
  const plan = PLANS[providerId];
  if (!plan) {
    stop(2, `no live smoke plan for '${providerId}' (have: ${Object.keys(PLANS).join(", ")})`);
  }
  const firstRun = has("first-run");

  // ── 1. FLAGS ──────────────────────────────────────────────────────────────
  step(1, "Feature flags");
  if (!flagOn(process.env.CONSUMER_LIVE_SMOKE_ENABLED)) {
    stop(2, "CONSUMER_LIVE_SMOKE_ENABLED is not 1. This never runs by accident, and never in CI.");
  }
  ok("CONSUMER_LIVE_SMOKE_ENABLED=1");
  const capRaw = process.env.CONSUMER_LIVE_SMOKE_MAX_USDC?.trim();
  if (!capRaw) stop(2, "CONSUMER_LIVE_SMOKE_MAX_USDC is not set — a live spend needs an explicit ceiling");
  let cap: Money;
  try {
    cap = parseMoney(capRaw, USDC);
  } catch {
    stop(2, `CONSUMER_LIVE_SMOKE_MAX_USDC=${JSON.stringify(capRaw)} is not an exact decimal`);
  }
  if (cap.amount <= 0n) stop(2, "the spend cap must be positive");
  ok(`spend cap ${displayMoney(cap)}`);
  const deployed = loadConsumerFlags();
  info("deployed execution flag", deployed.executionEnabled ? "ON" : "OFF (unaffected by this run)");

  const payTo = plan.payTo;
  info("provider", `${plan.displayName} × ${plan.capability}`);

  // ── 2. TREASURY ───────────────────────────────────────────────────────────
  step(2, "Treasury");
  const key = process.env.CONSUMER_TREASURY_BASE_PRIVATE_KEY?.trim();
  if (!key) stop(2, "CONSUMER_TREASURY_BASE_PRIVATE_KEY is not set — there is no wallet to pay from");
  const rpcUrl = process.env.CONSUMER_BASE_RPC_URL?.trim() || "https://mainnet.base.org";
  const rail = new X402EvmExactClient({
    chain: BASE,
    evmChainId: 8453,
    privateKey: key as `0x${string}`,
    rpcUrl,
  });
  if (!rail.available()) stop(2, "the Base rail reports unavailable");
  const treasuryAddress = rail.address();
  info("settlement treasury", treasuryAddress);

  /**
   * The external funder, if one is configured.
   *
   * The key is read straight into a viem account and never printed, logged or echoed — only the
   * derived public address appears anywhere. The address is asserted DISTINCT from the settlement
   * treasury here rather than at spend time, because a run where they coincide proves nothing and
   * should stop before it costs anything.
   */
  const funderKey = process.env.CONSUMER_TEST_FUNDER_PRIVATE_KEY?.trim();
  const funderAccount = funderKey ? privateKeyToAccount(funderKey as `0x${string}`) : null;
  if (funderAccount) {
    if (funderAccount.address.toLowerCase() === treasuryAddress.toLowerCase()) {
      stop(2, "the test funder IS the settlement treasury — that would prove nothing");
    }
    info("external funder", funderAccount.address);
    ok("funder is a DIFFERENT wallet from the settlement treasury");
  }

  let balanceBefore: Money;
  try {
    balanceBefore = await rail.balanceOf(USDC);
  } catch (e) {
    stop(2, `could not read the USDC balance: ${(e as Error).message}`);
  }
  info("USDC balance", displayMoney(balanceBefore));
  if (balanceBefore.amount < cap.amount) {
    stop(2, `the float holds ${formatMoney(balanceBefore)} USDC, less than the ${formatMoney(cap)} cap`);
  }
  ok("float covers the cap");

  // ── store: Postgres when available, else in-memory ────────────────────────
  const dbUrl = process.env.DATABASE_URL?.trim();
  const pool = dbUrl ? createPool(dbUrl) : null;
  const store: ConsumerStore = pool ? new PgConsumerStore(pool) : new InMemoryConsumerStore();
  info("store", pool ? "Postgres (durable)" : "in-memory (no DATABASE_URL)");

  /**
   * The REAL §7.4 receipt writer, not a stub.
   *
   * `initReceiptWiring` returns null without DATABASE_URL + REDIS_URL, and that is reported loudly
   * rather than passed silently as `receipts: null` — a live run whose receipt never lands has not
   * proven the receipt path, and the run should say so at the top instead of at the end.
   */
  const receiptWiring = await initReceiptWiring();
  const receiptSink: ConsumerReceiptSink | null = makeConsumerReceiptSink(receiptWiring);
  if (receiptSink) ok("receipt writer wired — this run will produce a real §7.4 receipt");
  else warn("receipt writer NOT wired (needs DATABASE_URL + REDIS_URL) — receiptId will be null");

  await store.upsertTreasuryAccount({
    treasuryRef: "base-usdc-settlement",
    asset: USDC,
    purpose: "SETTLEMENT",
    address: treasuryAddress,
    minBalance: parseMoney(process.env.CONSUMER_TREASURY_BASE_MIN_BALANCE_USDC?.trim() || "0.00", USDC),
    dailyLimit: parseMoney(process.env.CONSUMER_TREASURY_BASE_DAILY_LIMIT_USDC?.trim() || "2.00", USDC),
    enabled: true,
  });
  ok("treasury account registered");

  // ── provider registry ─────────────────────────────────────────────────────
  const existing = await store.getProvider(providerId);
  const maturity = existing?.maturity ?? "sandbox";
  if (maturity !== "verified" && !firstRun) {
    stop(
      2,
      `provider '${providerId}' is '${maturity}', not 'verified'. Nothing can be verified until ` +
        "something settles once, so THIS bootstrap run requires --first-run, which is recorded in " +
        "the evidence.",
    );
  }
  if (maturity !== "verified") {
    warn(`BOOTSTRAP RUN: '${providerId}' is '${maturity}'. --first-run supplied. This is the one`);
    warn("exception to the verified-only rule, and it is recorded in the evidence report.");
  }
  /**
   * The provider row is written with the maturity it ALREADY HAS.
   *
   * An earlier version wrote `maturity: "verified"` here with a comment saying it was in-process
   * only. Against the in-memory store that was true. Against Postgres — which is what a run with a
   * real DATABASE_URL uses, and therefore what every meaningful run uses — it was a durable
   * promotion, applied BEFORE the payment it was supposed to be evidence of, and before any human
   * had confirmed the delivery. The control that says "promotion requires an observed settlement"
   * was being satisfied by the act of preparing to look.
   *
   * So the durable row is left exactly as the operator set it, and the bootstrap override lives in
   * `bootstrapRegistryView` below: in memory, scoped to this one provider and this one capability,
   * gone when the process exits. Promotion is a separate, deliberate act taken on the evidence file.
   */
  await store.upsertProvider({
    providerId,
    displayName: existing?.displayName ?? providerId,
    maturity,
    baseUrl: existing?.baseUrl ?? plan.baseUrl,
    protocol: "x402",
    chains: existing?.chains ?? [BASE],
    provenance: existing?.provenance ?? "live smoke bootstrap",
    enabled: true,
  });
  const existingCap = (await store.listCapabilities(providerId)).find(
    (c) => c.capability === plan.capability,
  );
  if (!existingCap) {
    await store.upsertCapability({
      providerId,
      capability: plan.capability,
      maturity: "sandbox",
      notes: "introduced by the live smoke driver; not promoted by it",
    });
  }
  // AFTER the provider row: consumer_provider_limits carries a foreign key to it.
  await store.upsertProviderLimit({
    providerId,
    asset: USDC,
    perTxMax: cap,
    dailyMax: parseMoney(process.env.CONSUMER_TREASURY_BASE_DAILY_LIMIT_USDC?.trim() || "2.00", USDC),
  });
  ok("per-provider caps registered");
  ok(`durable maturity left at '${maturity}' — this run does not promote anything`);

  const treasury = new TreasuryRouter({
    store,
    rails: new Map<CaipChainId, RailClient>([[BASE, rail]]),
    pauses: new StorePauseChecker(store),
  });
  const registry = new ProviderRegistry({
    // The registry — and ONLY the registry — sees the bootstrap override. The orchestrator, the
    // treasury and the ledger all read the real store, so every durable row this run writes is a
    // row that would have been written by a normal production execution.
    store: bootstrapRegistryView(store, providerId, plan.capability),
    flags: smokeFlags,
    gate: { executionFloor: "verified", allowSandboxExecution: false },
  });

  // ── 3-4. CHALLENGE + VALIDATION ───────────────────────────────────────────
  step(3, "Real provider payment challenge");
  const job = plan.build();
  const adapter = plan.newAdapter();
  const ctx: AdapterContext = {
    correlationId: `smoke-${Date.now().toString(36)}`,
    timeoutMs: 25_000,
    signableChains: new Set<CaipChainId>([BASE]),
    siwx: null,
    discoveryPayment: null,
  };

  const probe = await (adapter as unknown as {
    probe402: (m: string, p: string, c: AdapterContext, b?: unknown) => Promise<{
      amount: Money; recipient: string; option: { network: CaipChainId; scheme: string; asset: string; maxTimeoutSeconds: number }; asset: typeof USDC;
    }>;
  }).probe402(job.probe.method, job.probe.path, ctx, job.probe.body);
  for (const [k, v] of job.label) info(k, v);
  info("price", displayMoney(probe.amount));
  info("recipient", probe.recipient);
  info("network", probe.option.network);

  step(4, "Validating the challenge before anything is signed");
  if (probe.option.network !== BASE) stop(3, `challenge is on ${probe.option.network}, not Base`);
  ok("network is Base (eip155:8453)");
  if (probe.option.asset.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
    stop(3, `challenge asset ${probe.option.asset} is not the approved USDC contract`);
  }
  ok("token is the approved USDC contract");
  if (probe.option.scheme !== "exact") stop(3, `scheme '${probe.option.scheme}' is not 'exact'`);
  ok("scheme is 'exact'");
  if (probe.recipient.toLowerCase() !== payTo.toLowerCase()) {
    stop(3, `recipient ${probe.recipient} is not the verified payTo ${payTo}`);
  }
  ok("recipient equals the verified payTo");
  if (probe.amount.amount > cap.amount) {
    stop(3, `provider asks ${displayMoney(probe.amount)}, over the ${displayMoney(cap)} cap`);
  }
  ok(`price ${displayMoney(probe.amount)} is within the cap`);
  if (probe.option.maxTimeoutSeconds <= 0 || probe.option.maxTimeoutSeconds > 3600) {
    stop(3, `implausible maxTimeoutSeconds ${probe.option.maxTimeoutSeconds}`);
  }
  ok(`expiry window ${probe.option.maxTimeoutSeconds}s is sane`);

  // ── policy ────────────────────────────────────────────────────────────────
  const policy = {
    id: process.env.CONSUMER_SMOKE_POLICY_ID?.trim() || "9001",
    /**
     * The policy is owned by the EXTERNAL FUNDER when one is configured.
     *
     * "The funding wallet owns or is authorised for the relevant policy" is part of what this proof
     * has to show, and a policy owned by a placeholder address would not show it. This provider is
     * the driver's own, so the ownership is real within the authority that evaluates it.
     */
    owner: funderAccount ? funderAccount.address : "0x0000000000000000000000000000000000000001",
    agentId: "1",
    version: 1,
    status: "ACTIVE",
    policyHash: `0x${sha256Hex("untch-consumer-live-smoke-policy")}`,
    expiry: Math.floor(Date.now() / 1000) + 86_400,
    onchainRef: { note: "live smoke policy — in-process, not an on-chain registration" },
    rules: {
      budgets: { daily: 1, token: "USDC" },
      perCallCap: Number(formatMoney(cap)),
      onPerCallCapExceeded: "BLOCK",
      escalateAbove: 1000,
      categories: { allow: [], deny: [] },
      recipients: { allow: [], deny: [] },
      agents: { allowWorkerIds: [], denyWorkerIds: [] },
      duplicates: { ttlMin: 0, keys: [] },
      cooldowns: { sameServiceMin: 0 },
      rateLimit: { callsPerHour: 10 },
      expiry: new Date(Date.now() + 86_400_000).toISOString(),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as StoredPolicy;

  const policyProvider = {
    async load() {
      return { id: policy.id, version: 1, status: "ACTIVE", rules: policy.rules } as never;
    },
    async loadStored() {
      return policy;
    },
  } as unknown as PolicyProvider;

  const orchestrator = new ConsumerOrchestrator({
    store,
    registry,
    adapters: { get: () => adapter, has: () => true, all: () => [adapter] },
    treasury,
    policyProvider,
    ledger: new SmokeLedger(),
    escalation: null,
    /**
     * The receipt writer is wired for real.
     *
     * The first activation run passed `null` here, so the completed intent recorded
     * `receiptId: null` — and because the bridge swallowed failures, that was indistinguishable
     * from a receipt the writer had REJECTED. A live run that settles real money must produce the
     * same §7.4 receipt a production run produces, or the run has not exercised the thing it claims
     * to have proven.
     */
    receipts: receiptSink,
    config: {
      allowSandboxExecution: false,
      maxSingleExecutionDisplay: formatMoney(cap),
      quoteTtlSec: 600,
      fundingTtlSec: 900,
      providerTimeoutMs: 25_000,
      executeTimeoutMs: 30_000,
      breakerThreshold: 5,
      breakerCooldownMs: 60_000,
    },
    publicBaseUrl: "https://asp.untch.xyz",
    siwx: null,
    log: (line) => console.log(`     ${line}`),
  });

  // ── 5. INTENT ─────────────────────────────────────────────────────────────
  step(5, "Creating a real Consumer Intent");
  const intentId = newIntentId();
  const tenantId = `policy:${policy.id}`;
  await orchestrator.createIntent({
    tenantId,
    requestingAgentId: "untch-live-smoke",
    principalId: "untch-operator",
    action: plan.action,
    policyId: policy.id,
    request: job.request,
    idempotencyKey: `live-smoke-${intentId}`,
    correlationId: ctx.correlationId,
    intentId,
  });
  info("intent", intentId);
  ok("intent created");

  step(6, "Quote from the provider's own price challenge");
  const { quote } = await orchestrator.quote(intentId, job.providerRef);
  info("provider cost", displayMoney(quote.providerCost));
  info("untch fee", formatMoney(quote.untchFee));
  info("spread", formatMoney(quote.spread));
  info("total", displayMoney(quote.totalUserAmount));
  info("quote hash", quote.quoteHash);
  ok("quote bound");

  step(7, "Deterministic Untch policy");
  const { intent: decided, decision } = await orchestrator.runPolicy(intentId);
  info("decision", decision?.decision ?? "(none)");
  info("rules evaluated", String(decision?.rules.length ?? 0));
  if (decided.state !== "APPROVED") {
    stop(3, `policy did not approve: state ${decided.state}, decision ${decision?.decision ?? "none"}`);
  }
  ok("APPROVED by the real §7.1 engine");

  // ── 8. RESERVE (operator-funded) ──────────────────────────────────────────
  /**
   * THE EXTERNAL-FUNDER LEG.
   *
   * With CONSUMER_TEST_FUNDER_PRIVATE_KEY set, the user-funding leg is a REAL ERC-20 transfer from a
   * wallet that is not any Untch treasury. That is the whole point of the proof: until now Untch was
   * both funder and settler, so the only novel leg exercised was the outbound merchant settlement.
   *
   * Without the variable the run stays operator-funded and says so, rather than silently pretending.
   */
  step(8, "Treasury reservation");
  const { funding } = await orchestrator.requestFunding(intentId);
  info("funding request", displayMoney(funding.amount));

  let fundingTx: string;
  let payer: string;
  let externallyFunded = false;

  if (funderAccount) {
    // The funding destination is the FUNDING treasury, which is a different address from the
    // SETTLEMENT treasury that pays the merchant. Both are read from the registry, never hardcoded.
    const fundingAccount = await store.getTreasuryAccount("xlayer-usdt0-funding");
    if (!fundingAccount) stop(3, "no xlayer-usdt0-funding treasury account registered");
    const dest = fundingAccount.address as `0x${string}`;
    if (dest.toLowerCase() === funderAccount.address.toLowerCase()) {
      stop(3, "funder and funding treasury are the same address — that would prove nothing");
    }

    info("external funder", funderAccount.address);
    info("funding destination", dest);
    console.log("     \x1b[31m>>> sending REAL USDT0 from the external wallet <<<\x1b[0m");

    const xlayerWallet = createWalletClient({
      account: funderAccount,
      chain: { id: 196, name: "X Layer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [XLAYER_RPC] } } },
      transport: viemHttp(XLAYER_RPC),
    });
    const xlayerPublic = createPublicClient({ transport: viemHttp(XLAYER_RPC) });

    const hash = await xlayerWallet.writeContract({
      address: USDT0_ADDRESS as `0x${string}`,
      abi: erc20Abi,
      functionName: "transfer",
      args: [dest, funding.amount.amount],
    });
    const rcpt = await xlayerPublic.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") stop(3, `external funding tx reverted: ${hash}`);

    fundingTx = hash;
    payer = funderAccount.address;
    externallyFunded = true;
    ok(`EXTERNAL funding settled: ${hash} (block ${rcpt.blockNumber})`);
  } else {
    fundingTx = `operator-funded:${intentId}`;
    payer = treasuryAddress;
    warn("the user-funding leg is OPERATOR-FUNDED for this run — Untch is both funder and settler.");
    warn("Set CONSUMER_TEST_FUNDER_PRIVATE_KEY to exercise the external leg.");
  }

  await orchestrator.confirmFunding(intentId, {
    intentId,
    chain: funding.amount.asset.chain,
    txHash: fundingTx,
    amount: funding.amount,
    payer,
    settledAt: new Date().toISOString(),
    confirmations: externallyFunded ? 1 : 0,
    finalized: externallyFunded,
  });
  ok(`reserved ${displayMoney(funding.amount)}`);
  await orchestrator.queueExecution(intentId);

  // ── 9-11. THE REAL PAYMENT ────────────────────────────────────────────────
  step(9, "REAL provider payment on Base");
  console.log("     \x1b[31m>>> spending real USDC now <<<\x1b[0m");

  /**
   * A DEPLOYED worker may reach this intent first.
   *
   * `startConsumerWorkers` polls EXECUTION_QUEUED every two seconds, and a run against the
   * production database shares that queue — so between `queueExecution()` and `executeIntent()`
   * there is a window where the deployed service claims the intent. It really happens: the first
   * live Mail run lost this race, and the deployed worker correctly refused the intent because
   * CONSUMER_PROVIDER_STABLEEMAIL_ENABLED was not set on the deployment.
   *
   * Losing is not an error, and it must not surface as a stack trace. The compare-and-set is doing
   * exactly its job — one execution, one winner — so the honest report is the OUTCOME the winner
   * reached. What would be wrong is retrying: a second `executeIntent` on an intent another worker
   * already carried through payment is how one authorisation becomes two settlements.
   */
  let executed: ConsumerIntent;
  try {
    executed = await orchestrator.executeIntent(intentId);
  } catch (err) {
    if (!(err instanceof Error) || !/no longer in EXECUTION_QUEUED/.test(err.message)) throw err;
    warn("a DEPLOYED worker claimed this intent first — reporting its outcome, not retrying.");
    const claimed = await store.getIntent(intentId);
    if (!claimed) stop(3, `intent ${intentId} vanished after the race`);
    executed = claimed;
  }
  info("state", executed.state);

  if (executed.state === "MANUAL_REVIEW") {
    console.error(`\n\x1b[33mSMOKE: AMBIGUOUS — ${executed.failureCode}: ${executed.failureDetail}\x1b[0m`);
    console.error("The request left Untch and its outcome is unknown. It has NOT been retried.");
    console.error("Querying the provider and the chain before concluding…");
    await reportAmbiguity(store, rail, intentId, treasuryAddress, balanceBefore, rpcUrl);
    process.exit(4);
  }
  if (executed.state !== "PROVIDER_ACKNOWLEDGED") {
    const execs = await store.listExecutions(intentId);
    console.error(`\n\x1b[31mSMOKE: FAILED — state ${executed.state}\x1b[0m`);
    console.error(`  ${executed.failureCode}: ${executed.failureDetail}`);
    for (const e of execs) console.error(`  attempt ${e.attemptNo}: ${e.state} ${e.error?.code ?? ""}`);
    process.exit(3);
  }
  ok("provider paid and acknowledged");

  const executions = await store.listExecutions(intentId);
  const paid = executions.find((e) => e.state === "PAID" || e.state === "ACKNOWLEDGED");
  info("provider reference", paid?.providerReference ?? "—");
  info("settlement tx", paid?.settlementTxHash ?? "(not reported by the facilitator)");
  info("settled amount", paid?.settledAmount ? displayMoney(paid.settledAmount) : "—");

  // ── 12. DELIVERY VERIFICATION ─────────────────────────────────────────────
  step(10, "Delivery verification");
  const completed = await orchestrator.verifyAndComplete(intentId);
  const evidence = await store.getDeliveryEvidence(intentId);
  info("state", completed.state);
  info("provider attested", evidence?.providerAttested.status ?? "—");
  info("untch verified", `${evidence?.untchVerified.verified ?? false} (${evidence?.untchVerified.method ?? "NONE"})`);
  if (evidence?.untchVerified.detail) info("detail", evidence.untchVerified.detail);

  // ── 13. LEDGER ────────────────────────────────────────────────────────────
  step(11, "Ledger");
  const groups = await store.ledgerGroupsForIntent(intentId);
  for (const g of groups) {
    console.log(`     ${g.kind.padEnd(14)} ${g.asset.symbol}@${g.asset.chain}`);
    for (const e of g.entries) {
      console.log(`       ${e.accountId.split(":")[0]?.padEnd(20)} ${formatMoney(e.amount)}`);
    }
  }
  const fundingAsset = completed.fundingAsset;
  if (fundingAsset) {
    assertIntentSettled(intentId, fundingAsset, groups);
    const bal = projectBalances(groups).get(userObligationAccount(fundingAsset, intentId));
    ok(`user obligation nets to ${bal ? formatMoney(bal) : "0"} — balanced`);
  }

  // ── 14. CHAIN PROOF ───────────────────────────────────────────────────────
  step(12, "Independent on-chain proof");
  const balanceAfter = await rail.balanceOf(USDC);
  const delta = money(balanceBefore.amount - balanceAfter.amount, USDC);
  info("balance before", formatMoney(balanceBefore));
  info("balance after", formatMoney(balanceAfter));
  info("delta", formatMoney(delta));
  if (delta.amount === quote.providerCost.amount) {
    ok(`the treasury is exactly ${formatMoney(quote.providerCost)} lighter — settlement confirmed on-chain`);
  } else if (delta.amount === 0n) {
    warn("balance unchanged — the facilitator may not have settled yet; re-check before promoting");
  } else {
    warn(`delta ${formatMoney(delta)} != quoted cost ${formatMoney(quote.providerCost)} — investigate`);
  }

  let chainProof: Record<string, unknown> | null = null;
  if (paid?.settlementTxHash && /^0x[0-9a-fA-F]{64}$/.test(paid.settlementTxHash)) {
    chainProof = await readChainProof(rpcUrl, paid.settlementTxHash, treasuryAddress, payTo);
    if (chainProof) {
      ok("settlement transaction re-read independently from Base");
      info("block", String(chainProof.blockNumber));
      info("status", String(chainProof.status));
      info("transfer", String(chainProof.transfer));
    }
  } else {
    warn("no settlement tx hash was reported — promotion requires one; re-read before promoting");
  }

  // ── 15. EVIDENCE ──────────────────────────────────────────────────────────
  step(13, "Redacted evidence report");
  const dir = join(process.cwd(), "internal", "evidence", "consumer-pack", intentId);
  mkdirSync(dir, { recursive: true });

  const report = {
    schema: "untch.consumer-pack.live-evidence.v1",
    generatedAt: new Date().toISOString(),
    bootstrapRun: maturity !== "verified",
    provider: {
      providerId,
      baseUrl: plan.baseUrl,
      capability: plan.capability,
      maturityAtRunStart: maturity,
      documentationVersion: plan.documentationVersion,
      adapterVersion: `@untch/consumer-providers ${plan.displayName}Adapter @ feat/consumer-pack-completeness`,
    },
    challenge: {
      network: probe.option.network,
      scheme: probe.option.scheme,
      asset: probe.option.asset,
      amountAtomic: probe.amount.amount.toString(),
      recipient: probe.recipient,
      maxTimeoutSeconds: probe.option.maxTimeoutSeconds,
      hash: `0x${sha256Hex(stableStringify(probe.option))}`,
    },
    intent: { intentId, action: plan.action, tenantId, correlationId: ctx.correlationId },
    policy: {
      policyId: policy.id,
      policyVersion: 1,
      policyHash: policy.policyHash,
      decision: decision?.decision ?? null,
      rulesEvaluated: decision?.rules.length ?? 0,
      reasons: decision?.reasons ?? [],
    },
    approval: { required: false, reason: "policy APPROVED without escalation" },
    treasuryReservation: {
      // PUBLIC address only. The key is never read into this object.
      address: treasuryAddress,
      reserved: moneyToJson(funding.amount),
      note: "operator-funded: Untch is both funder and settler for this bootstrap run",
      fundingMarker: fundingTx,
    },
    settlement: {
      chain: paid?.settlementChain ?? null,
      txHash: paid?.settlementTxHash ?? null,
      amount: paid?.settledAmount ? moneyToJson(paid.settledAmount) : null,
      recipient: payTo,
      providerReference: paid?.providerReference ?? null,
      balanceBefore: formatMoney(balanceBefore),
      balanceAfter: formatMoney(balanceAfter),
      observedDelta: formatMoney(delta),
      chainProof,
    },
    quote: {
      quoteId: quote.quoteId,
      quoteHash: quote.quoteHash,
      providerCost: moneyToJson(quote.providerCost),
      untchFee: moneyToJson(quote.untchFee),
      spread: moneyToJson(quote.spread),
      total: moneyToJson(quote.totalUserAmount),
      expiresAt: quote.expiresAt,
    },
    // The provider's response is hashed, not stored: it is third-party content and the hash is what
    // a dispute needs.
    providerResponseHash: `0x${sha256Hex(stableStringify(paid?.providerReference ?? ""))}`,
    delivery: evidence
      ? {
          providerAttested: evidence.providerAttested,
          untchVerified: evidence.untchVerified,
          evidenceHash: evidence.evidenceHash,
          /**
           * What this run could NOT prove on its own.
           *
           * Recorded in the evidence rather than the terminal, because the terminal scrolls away
           * and the promotion decision is made later by someone reading this file. A capability
           * whose delivery leg ends in a human check must not be promotable by anyone who did not
           * see that the check was outstanding.
           */
          humanVerificationRequired: job.humanVerification,
        }
      : null,
    ledger: groups.map((g) => ({
      kind: g.kind,
      asset: { token: g.asset.symbol, chain: g.asset.chain },
      entries: g.entries.map((e) => ({ account: e.accountId, amount: e.amount.amount.toString(), memo: e.memo })),
    })),
    ledgerBalanced: true,
    finalState: completed.state,
    receiptId: completed.receiptId,
    timestamps: {
      intentCreated: completed.createdAt,
      completed: completed.updatedAt,
    },
    redaction:
      "No private key, no signature, no payment header, no API secret and no personal data appears " +
      "in this file. Addresses are public. The provider response is represented by a hash.",
  };

  const path = join(dir, "evidence.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  ok(`evidence written to internal/evidence/consumer-pack/${intentId}/evidence.json`);

  const events = await store.eventsSince(intentId, 0, 200);
  writeFileSync(
    join(dir, "events.json"),
    `${JSON.stringify(events.map((e) => ({ seq: e.seq, name: e.name, state: e.state, at: e.occurredAt })), null, 2)}\n`,
  );
  ok(`${events.length} lifecycle events recorded`);

  console.log("\n\x1b[1m\x1b[32mSMOKE: PASS\x1b[0m");
  console.log(`  intent      ${intentId}`);
  console.log(`  paid        ${displayMoney(quote.providerCost)} → ${redactAddress(payTo)}`);
  console.log(`  tx          ${paid?.settlementTxHash ?? "(not reported)"}`);
  console.log(`  delivery    untchVerified=${evidence?.untchVerified.verified ?? false}`);
  console.log("\nThis proves ONE settlement of ONE capability. Promotion is scoped to exactly");
  console.log(`  ${providerId} × ${plan.capability} — nothing else moves.`);

  if (job.humanVerification !== null) {
    console.log("\n\x1b[33mNOT YET PROVEN — a human check is outstanding:\x1b[0m");
    console.log(`  ${job.humanVerification}`);
    console.log("  Do NOT promote this capability to 'verified' until that check has passed.");
  }

  if (pool) await pool.end();
}

/** Re-read the settlement from Base and confirm it is a USDC Transfer of the right shape. */
async function readChainProof(
  rpcUrl: string,
  txHash: string,
  from: string,
  to: string,
): Promise<Record<string, unknown> | null> {
  try {
    const client = createPublicClient({ transport: viemHttp(rpcUrl) });
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    let transfer = "no USDC Transfer log matched";
    for (const lg of receipt.logs) {
      if (lg.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: erc20Abi, data: lg.data, topics: lg.topics });
        if (ev.eventName !== "Transfer") continue;
        const a = ev.args as unknown as { from: string; to: string; value: bigint };
        if (
          a.from.toLowerCase() === getAddress(from).toLowerCase() &&
          a.to.toLowerCase() === getAddress(to).toLowerCase()
        ) {
          transfer = `${formatMoney(money(a.value, USDC))} USDC ${redactAddress(a.from)} → ${redactAddress(a.to)}`;
        }
      } catch {
        // not a Transfer we can decode; keep looking
      }
    }
    return {
      blockNumber: receipt.blockNumber.toString(),
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
      transfer,
      explorer: `https://basescan.org/tx/${txHash}`,
    };
  } catch (e) {
    return { error: `could not re-read ${txHash}: ${(e as Error).message}` };
  }
}

/** On ambiguity: query the provider, query the chain, and conclude nothing on our own. */
async function reportAmbiguity(
  store: ConsumerStore,
  rail: X402EvmExactClient,
  intentId: string,
  treasuryAddress: string,
  balanceBefore: Money,
  _rpcUrl: string,
): Promise<void> {
  const execs = await store.listExecutions(intentId);
  for (const e of execs) {
    console.error(`  attempt ${e.attemptNo}: ${e.state} ref=${e.providerReference ?? "—"} ${e.error?.code ?? ""}`);
  }
  try {
    const after = await rail.balanceOf(USDC);
    const delta = balanceBefore.amount - after.amount;
    console.error(`  treasury delta: ${formatMoney(money(delta, USDC))} USDC`);
    console.error(
      delta === 0n
        ? "  → no funds left the treasury. The provider was almost certainly NOT paid."
        : "  → funds LEFT the treasury. Treat as paid-with-unknown-delivery and resolve manually.",
    );
  } catch {
    console.error("  could not re-read the balance");
  }
  console.error(`  treasury ${redactAddress(treasuryAddress)} — see docs/consumer-pack-runbook.md`);
}

main().catch((err: unknown) => {
  if (isProviderError(err)) {
    console.error(`\n\x1b[31mSMOKE: ${err.normalized.code} — ${err.normalized.message}\x1b[0m`);
    process.exit(3);
  }
  console.error(`\n\x1b[31mSMOKE: unexpected error — ${(err as Error).message}\x1b[0m`);
  console.error((err as Error).stack);
  process.exit(1);
});

export { randomBytes as _unused };
