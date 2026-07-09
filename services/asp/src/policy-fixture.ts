import { canonUrl, hashCanonicalJson } from "@untch/canon";
import type {
  Decision,
  Ledger,
  LedgerWindowState,
  Policy,
  PolicyRules,
  RecentIntent,
  SpendIntentInput,
} from "@untch/policy-engine";
import type { Hex } from "viem";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  DEMO-GRADE FIXTURE STATE — read this before trusting any preflight decision.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `preflight_payment` runs the REAL `@untch/policy-engine` (deterministic, no LLM — I1) against:
 *   1. ONE hardcoded demo policy (`FIXTURE_POLICY` below), and
 *   2. an IN-MEMORY ledger (`InMemoryLedger`) that resets on every process restart.
 *
 * The *engine* and its *rules* are real and race-safe. What is fixture here is the DATA they run
 * against: there is no Postgres/Redis, no per-operator policy store, no persistence. This is
 * stated so nobody mistakes a demo APPROVE/BLOCK for a production authorization. The ledger LOGIC
 * is correct (daily budget window, rolling-hour rate limit, duplicate TTL, per-service cooldown) —
 * it is only the STORAGE that is ephemeral. Real Postgres/Redis wiring is a later step (§8/§7.1).
 */

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURE POLICY — one hardcoded PolicyRules (§8 JSON shape, extended by Step-1b)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Demo policy rules. Field names + nesting mirror PRD §8 `policies.rules`, including the two
 * Step-1b additions (`recipients`, `onPerCallCapExceeded`). The concrete values below are chosen
 * for the demo and documented inline. Tuned so a clean small A2MCP call (e.g. $0.05, category
 * `market-data`, worker agent 0) sails through as APPROVED, while each block/escalate path is
 * still reachable by an intent that trips exactly one rule (see the unit tests).
 */
export const FIXTURE_RULES: PolicyRules = {
  // Daily budget 25 USDT (the §8 example value). Ephemeral: the day's running total lives in
  // memory and resets on restart.
  budgets: { daily: 25, token: "USDT" },
  // Per-call cap 1.00 USDT (§8 example). A single call above $1.00 trips the per-call rule.
  perCallCap: 1.0,
  // Step-1b selector. DEMO CHOICE: ESCALATE (route an over-cap call to human approval rather than
  // hard-block it) — so an over-cap intent demonstrates the ESCALATED_PER_CALL_CAP path. §8's
  // example used "BLOCK"; either is valid, the field exists precisely to make this per-policy.
  onPerCallCapExceeded: "ESCALATE",
  // Spends strictly above 5.00 USDT route to approval (§8 example escalateAbove 5.0).
  escalateAbove: 5.0,
  // Category allowlist (§8 example set). An intent whose category is outside this set is blocked.
  categories: { allow: ["market-data", "security", "research"], deny: [] },
  // Step-1b addition. Empty allow ⇒ every recipient permitted; deny is empty for the demo.
  recipients: { allow: [], deny: [] },
  // Empty worker allow/deny ⇒ any worker permitted; A2MCP endpoint calls carry workerAgentId 0
  // and skip this rule entirely.
  agents: { allowWorkerIds: [], denyWorkerIds: [] },
  // Duplicate = same (taskHash, endpoint, paramsHash) seen within 60 minutes (§8 example).
  duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
  // 5-minute cooldown between two calls to the same service host (§8 example).
  cooldowns: { sameServiceMin: 5 },
  // 40 calls/hour per agent (§8 example).
  rateLimit: { callsPerHour: 40 },
  // §8 example expiry. NOTE: past this instant the policy correctly becomes inactive and the
  // engine fail-closes to BLOCKED_NO_ACTIVE_POLICY (I2). Still in the future as of this build
  // (2026-07-09); a production policy would be re-issued before lapse.
  expiry: "2026-12-31T00:00:00Z",
};

/**
 * The active-policy record the engine looks up. `id` is a decimal string (uint256-compatible, §9);
 * this demo uses "1". Real lookups come from Postgres later — here it is injected.
 */
export const FIXTURE_POLICY: Policy = {
  id: "1",
  version: 1,
  status: "ACTIVE",
  rules: FIXTURE_RULES,
};

/**
 * keccak256 over the canonical JSON of the fixture rules (`@untch/canon` Surface A). The engine
 * does NOT verify an intent's `policyHash` against this in the current slice, but exposing it lets
 * a caller bind an intent to exactly this policy (set the intent's §8.1 `policyHash` to this
 * value), which the real end-to-end proof does. Deterministic — same rules ⇒ same hash everywhere.
 */
export const FIXTURE_POLICY_HASH: Hex = hashCanonicalJson(FIXTURE_RULES as unknown as Record<string, unknown>);

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY LEDGER — real window logic, ephemeral storage (§7.1 STATE_ASSEMBLY)
// ─────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
/** Prune duplicate-tracking records older than this (generous vs any sane duplicate TTL). */
const RECENT_INTENT_PRUNE_MS = 24 * HOUR_MS;

/** The service identity for the cooldown rule — an endpoint's canonical host (matches rules.ts). */
function serviceHost(endpoint: string): string {
  return new URL(canonUrl(endpoint)).host;
}

/** UTC day bucket key (`YYYY-MM-DD`) for the daily-budget window. */
function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

interface AgentBucket {
  spendByDay: Map<string, number>;
  recentIntents: RecentIntent[];
  lastCallByService: Record<string, number>;
  callTimestamps: number[];
}

/**
 * A real, correct in-memory implementation of `@untch/policy-engine`'s `Ledger`. `read` assembles
 * the exact `LedgerWindowState` the engine expects; `commitApproved` (called by the engine ONLY on
 * an APPROVED decision, inside the per-agent lock) records the spend so the next intent for that
 * agent observes it. Correct window math (daily reset, rolling hour, duplicate/cooldown clocks) —
 * ephemeral storage only. Injectable clock so unit tests are deterministic.
 */
export class InMemoryLedger implements Ledger {
  private readonly agents = new Map<string, AgentBucket>();

  constructor(private readonly now: () => number = Date.now) {}

  private bucket(agentKey: string): AgentBucket {
    let b = this.agents.get(agentKey);
    if (!b) {
      b = { spendByDay: new Map(), recentIntents: [], lastCallByService: {}, callTimestamps: [] };
      this.agents.set(agentKey, b);
    }
    return b;
  }

  read(agentKey: string): LedgerWindowState {
    const nowMs = this.now();
    const b = this.bucket(agentKey);
    const today = utcDay(nowMs);

    // Prune stale records (bounds memory; does not change any decision the rules would make).
    b.recentIntents = b.recentIntents.filter((r) => nowMs - r.createdAtMs < RECENT_INTENT_PRUNE_MS);
    b.callTimestamps = b.callTimestamps.filter((t) => nowMs - t < HOUR_MS);

    return {
      spentTodayByAgent: b.spendByDay.get(today) ?? 0,
      recentIntents: [...b.recentIntents],
      lastCallByService: { ...b.lastCallByService },
      callsInLastHour: b.callTimestamps.length,
    };
  }

  commitApproved(agentKey: string, intent: SpendIntentInput, decision: Decision): void {
    const nowMs = this.now();
    const b = this.bucket(agentKey);
    const today = utcDay(nowMs);

    b.spendByDay.set(today, (b.spendByDay.get(today) ?? 0) + intent.amount);
    b.recentIntents.push({
      intentId: `pi_${decision.intentHash.slice(2, 10)}`,
      taskHash: intent.taskHash,
      endpoint: intent.endpoint,
      paramsHash: intent.paramsHash,
      createdAtMs: nowMs,
    });
    b.lastCallByService[serviceHost(intent.endpoint)] = nowMs;
    b.callTimestamps.push(nowMs);
  }

  /** Test/ops helper — seed an agent's window directly (used by unit tests to trigger blocks). */
  seed(agentKey: string, partial: Partial<AgentBucket>): void {
    const b = this.bucket(agentKey);
    if (partial.spendByDay) b.spendByDay = partial.spendByDay;
    if (partial.recentIntents) b.recentIntents = partial.recentIntents;
    if (partial.lastCallByService) b.lastCallByService = partial.lastCallByService;
    if (partial.callTimestamps) b.callTimestamps = partial.callTimestamps;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY INTENT STORE — resolve `preflight_payment`'s `intentHash` input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lets `preflight_payment` accept a bare `intentHash` (from a prior `create_spend_intent` on the
 * SAME running instance). Demo-grade: a bounded, ephemeral `Map` — NOT the on-chain
 * `SpendIntentRegistry` (which does not exist yet, §10.2) and NOT a database. Resets on restart;
 * an `intentHash` created on another instance or before a restart will miss (the caller then
 * resubmits the inline intent). Bounded to avoid unbounded growth on a long-lived process.
 */
export class InMemoryIntentStore {
  private readonly map = new Map<string, SpendIntentInput>();

  constructor(private readonly maxEntries = 1000) {}

  put(intentHash: Hex, intent: SpendIntentInput): void {
    const key = intentHash.toLowerCase();
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, intent);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get(intentHash: string): SpendIntentInput | undefined {
    return this.map.get(intentHash.toLowerCase());
  }
}

/** One shared bundle of demo state for the running server; tests build isolated instances. */
export interface FixtureState {
  readonly policy: Policy;
  readonly policyHash: Hex;
  readonly ledger: InMemoryLedger;
  readonly intentStore: InMemoryIntentStore;
}

export function createFixtureState(now: () => number = Date.now): FixtureState {
  return {
    policy: FIXTURE_POLICY,
    policyHash: FIXTURE_POLICY_HASH,
    ledger: new InMemoryLedger(now),
    intentStore: new InMemoryIntentStore(),
  };
}
