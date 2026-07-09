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
 * The terminal decision codes THIS slice can emit. Ten of §7.1's thirteen RULE_EVAL rules are
 * now real (plus the `policy.active` lookup), so this slice produces the full BLOCKED_* family
 * for them AND the first ESCALATED_* outcomes (`ESCALATED_THRESHOLD`, `ESCALATED_PER_CALL_CAP`).
 *
 * Still stubbed (their rules are no-ops, see `rules.ts`), so these codes are NOT produced here:
 * BLOCKED_REPLAY (replay/CBC), BLOCKED_VENDOR_RISK / ESCALATED_VENDOR_RISK (vendor LCB), and
 * ESCALATED_PROOF_TIER (proof tier). Also not in scope for this preflight engine:
 * REJECTED_UNAUTHENTICATED, REJECTED_STALE_INTENT, ESCALATED_SIGNER_DOWN.
 *
 * Fail-closed (I2): every code here except APPROVED withholds the spend. An ESCALATED_* outcome
 * withholds too — it routes to the approval pipeline (§7.2), it is NOT an approval.
 *
 * `BLOCKED_PER_CALL_CAP` / `ESCALATED_PER_CALL_CAP` are named to the codebase convention; §7.1
 * states per-call-cap resolves to "ESCALATED or BLOCKED (per policy)" without a verbatim suffix.
 */
export type DecisionOutcome =
  | "REJECTED_MALFORMED"
  | "BLOCKED_NO_ACTIVE_POLICY"
  | "BLOCKED_FAIL_CLOSED"
  | "BLOCKED_DUPLICATE"
  | "BLOCKED_COOLDOWN"
  | "BLOCKED_RECIPIENT"
  | "BLOCKED_AGENT"
  | "BLOCKED_CATEGORY"
  | "BLOCKED_INTENT_BOUND"
  | "BLOCKED_PER_CALL_CAP"
  | "ESCALATED_PER_CALL_CAP"
  | "BLOCKED_BUDGET"
  | "BLOCKED_RATE"
  | "ESCALATED_THRESHOLD"
  | "APPROVED";

export type RuleResult = "PASS" | "FAIL";

// ─────────────────────────────────────────────────────────────────────────────
// Policy (active-policy lookup input; §8 `policies` row, narrowed)
// ─────────────────────────────────────────────────────────────────────────────

/** §8 `policies.status`. */
export type PolicyStatus = "ACTIVE" | "PAUSED" | "REVOKED" | "EXPIRED";

/** How a policy resolves a per-call-cap breach (§7.1 "ESCALATED or BLOCKED (per policy)"). */
export type OnPerCallCapExceeded = "ESCALATE" | "BLOCK";

/**
 * The slice of §8 `policies.rules` JSON this partial engine reads. Nesting and field names mirror
 * §8 exactly for every field the ten implemented rules need. The three still-stubbed rules
 * (replay/CBC, vendor LCB, proof tier) read nothing here, so §8's `vendors`, `proof`, and
 * challenge-envelope fields are intentionally absent — they arrive with those rules.
 *
 * TWO ADDITIONS not literally in §8's JSON (flagged per the task's "say so explicitly" rule):
 *   • `recipients: {allow, deny}` — §8's JSON has category/vendor/agent allow-deny lists but NO
 *     recipient-address allow-deny list, though §7.1 requires one ("recipient deny / not on
 *     allowlist"). Added with the same `{allow, deny}` shape as `categories`, holding addresses.
 *   • `onPerCallCapExceeded` — §8 carries `perCallCap` but no ESCALATE-vs-BLOCK selector, though
 *     §7.1 makes per-call-cap "per policy". Added mirroring `vendors.onBelowFloor`'s convention;
 *     optional, defaults to `"BLOCK"` (the conservative, fail-closed choice) when absent.
 */
export interface PolicyRules {
  readonly budgets: {
    /** §8 `budgets.daily` — daily spend limit, in DISPLAY units of `budgets.token`. */
    readonly daily: number;
    /** §8 `budgets.token`. */
    readonly token: string;
  };
  /** §8 `perCallCap` — max spend per single call, DISPLAY units of `budgets.token`. */
  readonly perCallCap: number;
  /** ADDED (see interface note). Per-policy resolution of a per-call-cap breach. Default `BLOCK`. */
  readonly onPerCallCapExceeded?: OnPerCallCapExceeded;
  /** §8 `escalateAbove` — spends strictly above this route to approval, DISPLAY units. */
  readonly escalateAbove: number;
  /** §8 `categories` — allow/deny category slugs. Empty `allow` ⇒ all allowed. */
  readonly categories: {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
  };
  /** ADDED (see interface note) — recipient-address allow/deny. Empty `allow` ⇒ all allowed. */
  readonly recipients: {
    readonly allow: readonly Address[];
    readonly deny: readonly Address[];
  };
  /** §8 `agents` — worker-agent-id allow/deny. Ids are canonical decimal strings (§9). */
  readonly agents: {
    readonly allowWorkerIds: readonly string[];
    readonly denyWorkerIds: readonly string[];
  };
  readonly duplicates: {
    /** §8 `duplicates.ttlMin` — minutes within which a repeat counts as a duplicate. */
    readonly ttlMin: number;
    /** §8 `duplicates.keys` — the tuple identifying a duplicate, e.g. taskHash+endpoint+paramsHash. */
    readonly keys: readonly string[];
  };
  /** §8 `cooldowns` — minimum minutes between two calls to the SAME service. */
  readonly cooldowns: {
    readonly sameServiceMin: number;
  };
  /** §8 `rateLimit` — max calls per rolling hour for this agent. */
  readonly rateLimit: {
    readonly callsPerHour: number;
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
 * `spend_intents` columns the rule layer reads.
 *
 * Two money representations coexist by design, exactly as the PRD splits them:
 *   • `maxAmount` — base units (bigint), the §8.1 struct field. Hashed; ALSO compared by the
 *     intent-bound rule against `amount` re-expressed in base units (§9 6-decimal convention).
 *   • `amount`    — DISPLAY units (number), used by the budget/per-call/escalate rules, matching
 *     §8.2's display trace.
 */
export interface SpendIntentInput {
  /** operator wallet (§8.1) */
  readonly owner: Address;
  readonly buyerAgentId: bigint;
  /** 0 for an A2MCP endpoint call (§8.1) */
  readonly workerAgentId: bigint;
  readonly token: Address;
  /** base units (§8.1) — hashed, and the ceiling the intent-bound rule enforces */
  readonly maxAmount: bigint;
  readonly taskHash: Hex;
  /** committed acceptance criteria; 0x0 ⇒ hygiene event (§8.1) */
  readonly acceptanceHash: Hex;
  readonly schemaHash: Hex;
  readonly policyHash: Hex;
  /** unix seconds (§8.1) */
  readonly deadline: bigint;
  readonly nonce: bigint;

  /** §8 `endpoint`/`resource_url`, normalized (canon `canonUrl`) — a duplicate-key component and
   *  the cooldown rule's service identity (its canonical host). */
  readonly endpoint: string;
  /** §8 `params_hash` — a duplicate-key component. */
  readonly paramsHash: Hex;
  /** §8 `recipient_address` — the payout address the recipient allow/deny rule checks. */
  readonly recipientAddress: Address;
  /** §8 `category` — the category-allow rule checks this against the policy's allow/deny lists. */
  readonly category: string;
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
 * whatever store it uses (§7.1 "ledger windows, nonce store, bureau LCB scores, cooldown clocks");
 * this package never touches a database. The serialized entry point (`concurrency.ts`) re-reads
 * this INSIDE the per-agent lock so a second concurrent intent sees the first's committed effect.
 */
export interface LedgerWindowState {
  /** Sum of this agent's spend in the current daily window, DISPLAY units of `budgets.token`. */
  readonly spentTodayByAgent: number;
  /** Prior intents within their duplicate TTL. May be empty; must be an array (fail-closed if not). */
  readonly recentIntents: readonly RecentIntent[];
  /**
   * §7.1 "cooldown clocks" — last-call epoch ms keyed by service identity (an endpoint's canonical
   * host, per `canonUrl`). A key absent ⇒ no prior call to that service. May be empty `{}`.
   */
  readonly lastCallByService: Readonly<Record<string, number>>;
  /** This agent's call count in the trailing rate-limit window (one hour) — the rate rule's input. */
  readonly callsInLastHour: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision trace (§8.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One rule's trace entry. Shape matches §8.2 exactly for implemented rules — `rule` + `result`
 * plus that rule's own detail fields, and NO `implemented` key. A NOT-YET-IMPLEMENTED stub is the
 * one divergence from §8.2: it carries `implemented: false` (and a `note`) so the trace is
 * self-describing and the manifest test can enumerate exactly which rules are real.
 *
 * A rule that triggers an ESCALATED_* outcome records `result: "FAIL"` here (its condition was
 * violated); whether that violation blocks or escalates lives in the top-level `Decision.decision`.
 * This keeps the rule-level result the §8.2 PASS/FAIL binary — no second shape.
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
  /** cooldown rule — seconds until the same-service cooldown elapses (FAIL only). */
  readonly cooldownRemainingSec?: number;
  /** allow/deny rules (recipient/agent/category) — which list matched on a FAIL. */
  readonly matchedList?: "allow" | "deny";
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
