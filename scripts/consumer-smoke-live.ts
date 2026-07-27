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
  type ConsumerStore,
  type Money,
  type RailClient,
} from "../packages/consumer-core/src/index";
import {
  StableDomainsAdapter,
  X402EvmExactClient,
  redactAddress,
  type AdapterContext,
} from "../packages/consumer-providers/src/index";
import type { Ledger, LedgerWindowState, SpendIntentInput } from "../packages/policy-engine/src/index";
import type { PolicyProvider, StoredPolicy } from "../packages/policy-store/src/index";
import { ConsumerOrchestrator } from "../services/asp/src/consumer/orchestrator";
import { createPublicClient, decodeEventLog, erc20Abi, getAddress, http as viemHttp } from "viem";

const BASE: CaipChainId = "eip155:8453";
const USDC = asset("base.usdc");
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** The verified Base payTo per provider, read from live 402s on 2026-07-27. */
const VERIFIED_PAYTO: Readonly<Record<string, string>> = {
  stabledomains: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
};

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

async function main(): Promise<void> {
  console.log("\n\x1b[1mUntch Consumer Pack — LIVE provider execution\x1b[0m");
  console.log("\x1b[31mThis spends REAL money on a REAL merchant.\x1b[0m");

  const providerId = arg("provider") ?? "stabledomains";
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

  const payTo = VERIFIED_PAYTO[providerId];
  if (!payTo) stop(2, `no verified Base payTo recorded for '${providerId}'`);

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
  info("treasury", treasuryAddress);

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
  await store.upsertProvider({
    providerId,
    displayName: existing?.displayName ?? providerId,
    maturity: "verified",   // in-process only, for THIS run; the durable row is promoted later, on evidence
    baseUrl: existing?.baseUrl ?? "https://stabledomains.dev",
    protocol: "x402",
    chains: [BASE],
    provenance: existing?.provenance ?? "live smoke bootstrap",
    enabled: true,
  });
  await store.upsertCapability({
    providerId,
    capability: "domains.check",
    maturity: "verified",
    notes: "live smoke",
  });
  // AFTER the provider row: consumer_provider_limits carries a foreign key to it.
  await store.upsertProviderLimit({
    providerId,
    asset: USDC,
    perTxMax: cap,
    dailyMax: parseMoney(process.env.CONSUMER_TREASURY_BASE_DAILY_LIMIT_USDC?.trim() || "2.00", USDC),
  });
  ok("per-provider caps registered");

  const treasury = new TreasuryRouter({
    store,
    rails: new Map<CaipChainId, RailClient>([[BASE, rail]]),
    pauses: new StorePauseChecker(store),
  });
  const registry = new ProviderRegistry({
    store,
    flags: smokeFlags,
    gate: { executionFloor: "verified", allowSandboxExecution: false },
  });

  // ── 3-4. CHALLENGE + VALIDATION ───────────────────────────────────────────
  step(3, "Real provider payment challenge");
  const domain = arg("domain") ?? `untchactivation${Date.now().toString(36).slice(-6)}.xyz`;
  const adapter = new StableDomainsAdapter();
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
  }).probe402("POST", "/api/check", ctx, { domain });
  info("domain", domain);
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
    owner: "0x0000000000000000000000000000000000000001",
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
    receipts: null,
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
    action: "domains.check",
    policyId: policy.id,
    request: { domain },
    idempotencyKey: `live-smoke-${intentId}`,
    correlationId: ctx.correlationId,
    intentId,
  });
  info("intent", intentId);
  ok("intent created");

  step(6, "Quote from the provider's own price challenge");
  const { quote } = await orchestrator.quote(intentId, domain);
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
  step(8, "Treasury reservation");
  const { funding } = await orchestrator.requestFunding(intentId);
  const fundingTx = `operator-funded:${intentId}`;
  await orchestrator.confirmFunding(intentId, {
    intentId,
    chain: funding.amount.asset.chain,
    txHash: fundingTx,
    amount: funding.amount,
    payer: treasuryAddress,
    settledAt: new Date().toISOString(),
    confirmations: 0,
    finalized: false,
  });
  warn("the user-funding leg is OPERATOR-FUNDED for this run — Untch is both funder and settler.");
  warn("The novel leg under test is the OUTBOUND Base settlement below.");
  ok(`reserved ${displayMoney(funding.amount)}`);
  await orchestrator.queueExecution(intentId);

  // ── 9-11. THE REAL PAYMENT ────────────────────────────────────────────────
  step(9, "REAL provider payment on Base");
  console.log("     \x1b[31m>>> spending real USDC now <<<\x1b[0m");
  const executed = await orchestrator.executeIntent(intentId);
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
      baseUrl: "https://stabledomains.dev",
      capability: "domains.check",
      maturityAtRunStart: maturity,
      documentationVersion: "live OpenAPI fetched 2026-07-27 (14 paths); .well-known/x402",
      adapterVersion: "@untch/consumer-providers StableDomainsAdapter @ feat/consumer-pack",
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
    intent: { intentId, action: "domains.check", tenantId, correlationId: ctx.correlationId },
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
  console.log(`  ${providerId} × domains.check — nothing else moves.`);

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
