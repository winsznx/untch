import { canonUrl } from "@untch/canon";
import type {
  Decision,
  Ledger,
  LedgerWindowState,
  RecentIntent,
  SpendIntentInput,
} from "@untch/policy-engine";
import type { Hex } from "viem";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  §7.1 LEDGER-WINDOW STATE + intent cache — the ephemeral part of preflight.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The POLICY is no longer here: as of the policy-store work, preflight_payment loads real, durable
 * policies from Postgres by policyId (see `@untch/policy-store` + `handlers.ts`). What remains in this
 * file is the §7.1 STATE_ASSEMBLY window state (daily budget, rolling-hour rate, duplicate TTL,
 * per-service cooldown) and the intentHash→intent cache. Both keep REAL window/dedup logic but
 * EPHEMERAL storage — they reset on restart. Making that state durable (Redis + a Postgres backstop,
 * §7.1/§8 `replay_nonces`/`ledger_entries`) is a separate later step; only the policy was fixture, and
 * it has been replaced.
 */

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
 * A real, correct in-memory implementation of `@untch/policy-engine`'s `Ledger`. `read` assembles the
 * exact `LedgerWindowState` the engine expects; `commitApproved` (called by the engine ONLY on an
 * APPROVED decision, inside the per-agent lock) records the spend so the next intent for that agent
 * observes it. Correct window math (daily reset, rolling hour, duplicate/cooldown clocks) — ephemeral
 * storage only. Injectable clock so unit tests are deterministic.
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

/**
 * Lets `preflight_payment` accept a bare `intentHash` (from a prior `create_spend_intent` on the SAME
 * running instance). Demo-grade: a bounded, ephemeral `Map` — NOT the on-chain `SpendIntentRegistry`
 * (§10.2, not built) and NOT a database. Resets on restart; an `intentHash` created on another
 * instance or before a restart misses (the caller then resubmits the inline intent). Bounded to avoid
 * unbounded growth on a long-lived process.
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

/** One shared bundle of ephemeral §7.1 state for the running server; tests build isolated instances. */
export interface LedgerState {
  readonly ledger: InMemoryLedger;
  readonly intentStore: InMemoryIntentStore;
}

export function createLedgerState(now: () => number = Date.now): LedgerState {
  return {
    ledger: new InMemoryLedger(now),
    intentStore: new InMemoryIntentStore(),
  };
}
