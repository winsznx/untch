import type { Address, Hex } from "viem";

/**
 * Types for the Untch policy engine — the PARTIAL slice defined in the package README.
 *
 * Field names and nesting mirror PRD §8 (data model) and §8.2 (decision-trace schema) so the
 * objects this package emits are the exact shape a later receipt writer will consume. Where a
 * §8 structure has more fields than this slice reads, only the read fields appear here — the
 * narrowing is deliberate and documented, never a silent omission.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Outcomes (§7.1 terminal states)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The terminal decision codes THIS slice can emit. The complete engine (§7.1) also emits
 * REJECTED_UNAUTHENTICATED, REJECTED_STALE_INTENT, BLOCKED_COOLDOWN, BLOCKED_REPLAY,
 * BLOCKED_RECIPIENT, BLOCKED_AGENT, BLOCKED_CATEGORY, BLOCKED_VENDOR_RISK, BLOCKED_INTENT_BOUND,
 * BLOCKED_RATE, and the ESCALATED_* family — none of which this slice produces yet (their rules
 * are stubbed, see `rules.ts`). Fail-closed (I2): every code here except APPROVED withholds.
 */
export type DecisionOutcome =
  | "REJECTED_MALFORMED"
  | "BLOCKED_NO_ACTIVE_POLICY"
  | "BLOCKED_FAIL_CLOSED"
  | "BLOCKED_DUPLICATE"
  | "BLOCKED_BUDGET"
  | "APPROVED";

export type RuleResult = "PASS" | "FAIL";

// ─────────────────────────────────────────────────────────────────────────────
// Policy (active-policy lookup input; §8 `policies` row, narrowed)
// ─────────────────────────────────────────────────────────────────────────────

/** §8 `policies.status`. */
export type PolicyStatus = "ACTIVE" | "PAUSED" | "REVOKED" | "EXPIRED";

/**
 * The slice of §8 `policies.rules` JSON this partial engine reads. Nesting mirrors §8 exactly;
 * only the fields the duplicate + budget rules need are present. `budgets` here is deliberately
 * just `{ daily, token }` — §8 also carries `weekly`, `total`; enforcing those is part of the
 * full budget rule and is deferred.
 */
export interface PolicyRules {
  readonly budgets: {
    /** §8 `budgets.daily` — daily spend limit, in DISPLAY units of `budgets.token`. */
    readonly daily: number;
    /** §8 `budgets.token`. */
    readonly token: string;
  };
  readonly duplicates: {
    /** §8 `duplicates.ttlMin` — minutes within which a repeat counts as a duplicate. */
    readonly ttlMin: number;
    /** §8 `duplicates.keys` — the tuple identifying a duplicate, e.g. taskHash+endpoint+paramsHash. */
    readonly keys: readonly string[];
  };
  /** §8 `rules.expiry` — ISO-8601 UTC. The policy is inactive once this instant passes. */
  readonly expiry: string;
}

/**
 * The active-policy record supplied to the engine (§8 `policies` row, narrowed). Real Postgres
 * lookup is a later step; here the caller injects it so this package needs no database.
 */
export interface Policy {
  /** §8 `policies.id` — uint256-compatible, carried as a decimal string (§9 numeric policy). */
  readonly id: string;
  /** §8 `policies.version`. */
  readonly version: number;
  /** §8 `policies.status`. */
  readonly status: PolicyStatus;
  readonly rules: PolicyRules;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent input (§8.1 struct + the extra §8 `spend_intents` fields this slice reads)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Preflight input for one spend. The first eleven fields ARE the §8.1 `SpendIntent` struct and
 * are hashed verbatim by `@untch/canon`'s `hashSpendIntent` to produce the `intentHash` that
 * threads through decision → signature → vault spend → receipt. The trailing fields are §8
 * `spend_intents` columns the duplicate and budget rules read.
 *
 * Two money representations coexist by design, exactly as the PRD splits them:
 *   • `maxAmount` — base units (bigint), the §8.1 struct field, used ONLY for the intentHash.
 *   • `amount`    — DISPLAY units (number), used by the budget rule, matching §8.2's display trace.
 */
export interface SpendIntentInput {
  /** operator wallet (§8.1) */
  readonly owner: Address;
  readonly buyerAgentId: bigint;
  /** 0 for an A2MCP endpoint call (§8.1) */
  readonly workerAgentId: bigint;
  readonly token: Address;
  /** base units (§8.1) — hashed, not the budget amount */
  readonly maxAmount: bigint;
  readonly taskHash: Hex;
  /** committed acceptance criteria; 0x0 ⇒ hygiene event (§8.1) */
  readonly acceptanceHash: Hex;
  readonly schemaHash: Hex;
  readonly policyHash: Hex;
  /** unix seconds (§8.1) */
  readonly deadline: bigint;
  readonly nonce: bigint;

  /** §8 `endpoint`/`resource_url`, normalized (canon `canonUrl`) — a duplicate-key component. */
  readonly endpoint: string;
  /** §8 `params_hash` — a duplicate-key component. */
  readonly paramsHash: Hex;
  /** This call's spend in DISPLAY units of `budgets.token` — the value the budget rule checks. */
  readonly amount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger window state (§7.1 STATE_ASSEMBLY; injected — no DB in this package)
// ─────────────────────────────────────────────────────────────────────────────

/** A prior intent still inside its duplicate TTL, supplied for the duplicate rule. */
export interface RecentIntent {
  /** §8.2 `priorIntentId` (e.g. "pi_abc123"). */
  readonly intentId: string;
  readonly taskHash: Hex;
  /** normalized resource URL (canon `canonUrl`) */
  readonly endpoint: string;
  readonly paramsHash: Hex;
  /** epoch milliseconds the prior intent was created; the TTL is measured from here. */
  readonly createdAtMs: number;
}

/**
 * The read-only ledger snapshot the pure `evaluateIntent` consumes. The caller assembles it from
 * whatever store it uses (§7.1 "ledger windows, nonce store, …"); this package never touches a
 * database. The serialized entry point (`concurrency.ts`) re-reads this INSIDE the per-agent lock
 * so a second concurrent intent sees the first's committed effect.
 */
export interface LedgerWindowState {
  /** Sum of this agent's spend in the current daily window, DISPLAY units of `budgets.token`. */
  readonly spentTodayByAgent: number;
  /** Prior intents within their duplicate TTL. May be empty; must be an array (fail-closed if not). */
  readonly recentIntents: readonly RecentIntent[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision trace (§8.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One rule's trace entry. Shape matches §8.2 exactly for implemented rules — `rule` + `result`
 * plus that rule's own detail fields, and NO `implemented` key. A NOT-YET-IMPLEMENTED stub is the
 * one divergence from §8.2: it carries `implemented: false` (and a `note`) so the trace is
 * self-describing and the manifest test can enumerate exactly which rules are real.
 */
export interface RuleTraceEntry {
  readonly rule: string;
  readonly result: RuleResult;
  /** Present and `false` ONLY on stub rules. Absent on real rules (so they match §8.2 exactly). */
  readonly implemented?: false;

  // §8.2 rule-specific detail fields — each rule fills only the ones §8.2 shows for it.
  readonly observed?: string | number;
  readonly limit?: string | number;
  readonly token?: string;
  readonly raw?: number;
  readonly sigma?: number;
  readonly priorIntentId?: string;
  readonly ttlRemainingSec?: number;
  readonly note?: string;
}

/**
 * The decision object. Its §8.2 fields (`decision`, `intentHash`, `policyId`, `policyVersion`,
 * `evaluatedAt`, `rules`) match the §8.2 example so a receipt writer can consume it unchanged;
 * `reasons[]` is the additive human-readable summary from §7.1's DECISION_EMIT return and the §8
 * `decisions` table.
 */
export interface Decision {
  readonly decision: DecisionOutcome;
  readonly intentHash: Hex;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly evaluatedAt: string;
  readonly reasons: readonly string[];
  readonly rules: readonly RuleTraceEntry[];
}
