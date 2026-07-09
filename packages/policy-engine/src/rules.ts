import { canonUrl } from "@untch/canon";
import type { LedgerWindowState, Policy, RuleTraceEntry, SpendIntentInput } from "./types";

/**
 * The rule layer for the PARTIAL policy engine.
 *
 * Only two RULE_EVAL rules from §7.1 are real here — `duplicate` and `budget.daily`. Plus the
 * `policy.active` lookup. EVERY other §7.1 RULE_EVAL rule is present as an explicit stub that
 * returns PASS but is tagged `implemented: false` in the trace, so nothing is ever silently
 * skipped or silently passed (invariant I2 in spirit) and the manifest test can prove exactly
 * which rules are real. See the package README and PRD §7.1 for the full chain.
 */

/** Real rules in this slice (evaluated with actual logic). `duplicate.*` label derives from keys. */
export const IMPLEMENTED_RULES = [
  "policy.active",
  "duplicate.taskHash_endpoint_paramsHash",
  "budget.daily",
] as const;

/**
 * Every §7.1 RULE_EVAL rule NOT implemented in this slice, in RULE_EVAL order. Each maps to a
 * §7.1 line and its real terminal code; here each is a no-op PASS marked `implemented: false`.
 * The manifest test asserts the trace's stub set equals exactly this list — so this slice can
 * never be mistaken for the complete engine.
 */
export const STUBBED_RULES = [
  "cooldown.sameService", // §7.1 BLOCKED_COOLDOWN
  "replay.contextBinding", // §7.1 BLOCKED_REPLAY (Challenge Binding Check, §14)
  "recipient.allowDeny", // §7.1 BLOCKED_RECIPIENT
  "agent.workerAllowDeny", // §7.1 BLOCKED_AGENT
  "category.allow", // §7.1 BLOCKED_CATEGORY
  "vendor.lcbFloor", // §7.1 BLOCKED_VENDOR_RISK | ESCALATED_VENDOR_RISK
  "intent.maxAmountBound", // §7.1 BLOCKED_INTENT_BOUND
  "perCall.cap", // §7.1 per-call cap → ESCALATED | BLOCKED
  "rate.limit", // §7.1 BLOCKED_RATE
  "proof.tierRequired", // §7.1 ESCALATED_PROOF_TIER
  "escalate.aboveThreshold", // §7.1 ESCALATED_THRESHOLD
] as const;

/** `Math.round(x * 1e6)` — compare money as integer micro-units so float drift can't flip a check.
 *  Production budget arithmetic should move to §9 integer base units once the ledger/token-decimals
 *  infra lands; here display units are what §8.2's trace uses. */
function minorUnits(displayAmount: number): number {
  return Math.round(displayAmount * 1_000_000);
}

/** Two-decimal display string for the §8.2 trace (`3.2` → `"3.20"`, `25` → `"25.00"`). */
function money(displayAmount: number): string {
  return displayAmount.toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// policy.active (§7.1 POLICY_LOOKUP; §8.2 first trace entry)
// ─────────────────────────────────────────────────────────────────────────────

export interface PolicyActiveResult {
  readonly active: boolean;
  readonly entry: RuleTraceEntry;
}

/**
 * Active only if `status === "ACTIVE"` AND `expiry` has not passed. A missing policy or an
 * unparseable expiry is treated as inactive (fail-closed, I2) — never fail-open to ACTIVE.
 */
export function evaluatePolicyActive(policy: Policy | null | undefined, nowMs: number): PolicyActiveResult {
  if (!policy) {
    return { active: false, entry: { rule: "policy.active", result: "FAIL", observed: "MISSING" } };
  }
  const expiryMs = Date.parse(policy.rules.expiry);
  const expired = Number.isNaN(expiryMs) || expiryMs <= nowMs;
  const active = policy.status === "ACTIVE" && !expired;
  const observed = policy.status !== "ACTIVE" ? policy.status : expired ? "EXPIRED" : "ACTIVE";
  return { active, entry: { rule: "policy.active", result: active ? "PASS" : "FAIL", observed } };
}

// ─────────────────────────────────────────────────────────────────────────────
// duplicate (§7.1 RULE_EVAL: taskHash+endpoint+paramsHash within TTL)
// ─────────────────────────────────────────────────────────────────────────────

export interface RuleResultEntry {
  readonly blocked: boolean;
  readonly entry: RuleTraceEntry;
}

/** Trace label per §8.2 — `duplicate.` + the configured key tuple, e.g. `duplicate.taskHash_endpoint_paramsHash`. */
export function duplicateRuleName(policy: Policy): string {
  return `duplicate.${policy.rules.duplicates.keys.join("_")}`;
}

/**
 * Blocks when a prior intent with the SAME (taskHash, endpoint, paramsHash) is still inside the
 * `duplicates.ttlMin` window. The dedup tuple is fixed to those three fields in this slice (the
 * task's real rule); `duplicates.keys` drives only the trace label here. Endpoints are compared
 * after canon `canonUrl` normalization so URL formatting can't defeat the match; hashes compare
 * case-insensitively.
 */
export function evaluateDuplicate(
  intent: SpendIntentInput,
  policy: Policy,
  state: LedgerWindowState,
  nowMs: number,
): RuleResultEntry {
  const ruleName = duplicateRuleName(policy);
  const ttlMs = policy.rules.duplicates.ttlMin * 60_000;
  const endpoint = canonUrl(intent.endpoint);
  const taskHash = intent.taskHash.toLowerCase();
  const paramsHash = intent.paramsHash.toLowerCase();

  for (const prior of state.recentIntents) {
    const ageMs = nowMs - prior.createdAtMs;
    const withinTtl = ageMs >= 0 && ageMs < ttlMs;
    if (!withinTtl) continue;
    const sameTuple =
      prior.taskHash.toLowerCase() === taskHash &&
      canonUrl(prior.endpoint) === endpoint &&
      prior.paramsHash.toLowerCase() === paramsHash;
    if (sameTuple) {
      const ttlRemainingSec = Math.max(0, Math.ceil((prior.createdAtMs + ttlMs - nowMs) / 1000));
      return {
        blocked: true,
        entry: { rule: ruleName, result: "FAIL", priorIntentId: prior.intentId, ttlRemainingSec },
      };
    }
  }
  return { blocked: false, entry: { rule: ruleName, result: "PASS" } };
}

// ─────────────────────────────────────────────────────────────────────────────
// budget.daily (§7.1 RULE_EVAL: spentToday + amount vs budgets.daily)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Blocks when `spentTodayByAgent + amount` exceeds `budgets.daily`. Works in DISPLAY units to
 * match §8.2's trace; the comparison itself is in integer micro-units to avoid float drift. The
 * `observed` field is the projected daily total (existing + this intent) so a FAIL is self-evident
 * against `limit`.
 */
export function evaluateBudget(
  intent: SpendIntentInput,
  policy: Policy,
  state: LedgerWindowState,
): RuleResultEntry {
  const daily = policy.rules.budgets.daily;
  const projected = state.spentTodayByAgent + intent.amount;
  const blocked = minorUnits(projected) > minorUnits(daily);
  return {
    blocked,
    entry: {
      rule: "budget.daily",
      result: blocked ? "FAIL" : "PASS",
      observed: money(projected),
      limit: money(daily),
      token: policy.rules.budgets.token,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// stubs (every other §7.1 RULE_EVAL rule — PASS, but tagged implemented:false)
// ─────────────────────────────────────────────────────────────────────────────

/** The trace entries for all stubbed rules, in §7.1 RULE_EVAL order. PASS + `implemented:false`. */
export function buildStubTrace(): RuleTraceEntry[] {
  return STUBBED_RULES.map((rule) => ({
    rule,
    result: "PASS" as const,
    implemented: false as const,
    note: "NOT_YET_IMPLEMENTED — stubbed in this slice; see PRD §7.1 for the real rule",
  }));
}
