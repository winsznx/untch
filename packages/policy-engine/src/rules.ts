import { canonAddress, canonUrl } from "@untch/canon";
import type {
  DecisionOutcome,
  LedgerWindowState,
  Policy,
  RuleTraceEntry,
  SpendIntentInput,
} from "./types";

/**
 * The rule layer for the PARTIAL policy engine (PRD §7.1 RULE_EVAL).
 *
 * Ten of §7.1's thirteen RULE_EVAL rules are real here, in their exact §7.1 order, plus the
 * `policy.active` lookup. THREE remain explicit stubs (`replay.contextBinding`,
 * `vendor.lcbFloor`, `proof.tierRequired`): each returns PASS but is tagged `implemented: false`
 * in the trace, so nothing is ever silently skipped or silently passed (invariant I2 in spirit)
 * and the manifest test can prove exactly which rules are real. Each stub needs a subsystem this
 * package does not have yet (the §14 challenge envelope, the §12 Trust Bureau, the §13 Proof
 * Engine's tier concept respectively), so implementing them now would mean guessing interfaces.
 * See the package README and PRD §7.1 for the full chain.
 */

/**
 * Real rules in this slice, in decision-trace order: `policy.active` (the §7.1 POLICY_LOOKUP) then
 * the ten implemented RULE_EVAL rules in §7.1 order. `duplicate.*`'s label derives from the
 * configured keys; the default tuple yields the name pinned here.
 */
export const IMPLEMENTED_RULES = [
  "policy.active",
  "duplicate.taskHash_endpoint_paramsHash",
  "cooldown.sameService",
  "recipient.allowDeny",
  "agent.workerAllowDeny",
  "category.allow",
  "intent.maxAmountBound",
  "perCall.cap",
  "budget.daily",
  "rate.limit",
  "escalate.aboveThreshold",
] as const;

/**
 * The three §7.1 RULE_EVAL rules NOT implemented in this slice, in RULE_EVAL order. Each maps to a
 * §7.1 line and its real terminal code; here each is a no-op PASS marked `implemented: false`.
 * The manifest test asserts the trace's stub set equals exactly this list — so this slice can
 * never be mistaken for the complete engine.
 */
export const STUBBED_RULES = [
  "replay.contextBinding", // §7.1 BLOCKED_REPLAY — needs the §14 x402 challenge envelope
  "vendor.lcbFloor", // §7.1 BLOCKED_VENDOR_RISK | ESCALATED_VENDOR_RISK — needs the §12 Trust Bureau
  "proof.tierRequired", // §7.1 ESCALATED_PROOF_TIER — needs the §13 Proof Engine tier concept
] as const;

/** Base units per DISPLAY unit. The §9 6-decimal (USDT) convention, matching `@untch/canon`'s
 *  `moneyToBaseUnits(x, 6)`; the existing budget math already uses it. Production should swap this
 *  for per-token decimals from the verified token list once that infra lands. */
const BASE_UNITS_PER_DISPLAY = 1_000_000;

/** `Math.round(x * 1e6)` — compare money as integer base units so float drift can't flip a check. */
function minorUnits(displayAmount: number): number {
  return Math.round(displayAmount * BASE_UNITS_PER_DISPLAY);
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
// RULE_EVAL chain — one ordered pass over §7.1's rules, short-circuit on first fail
// ─────────────────────────────────────────────────────────────────────────────

/** Everything a RULE_EVAL rule may read. Assembled once by the engine, passed to every rule. */
interface RuleContext {
  readonly intent: SpendIntentInput;
  readonly policy: Policy;
  readonly state: LedgerWindowState;
  readonly nowMs: number;
}

/**
 * A rule's verdict. `outcome === null` ⇒ the rule passed, evaluation continues. A non-null
 * `outcome` short-circuits the chain with that terminal decision and `reason` (BLOCKED_* or
 * ESCALATED_*); the entry's `result` is `"FAIL"` in both block and escalate cases.
 */
interface RuleOutcome {
  readonly entry: RuleTraceEntry;
  readonly outcome: DecisionOutcome | null;
  readonly reason?: string;
}

type RuleFn = (ctx: RuleContext) => RuleOutcome;

function pass(rule: string, extra: Omit<RuleTraceEntry, "rule" | "result"> = {}): RuleOutcome {
  return { entry: { rule, result: "PASS", ...extra }, outcome: null };
}

function halt(
  rule: string,
  outcome: DecisionOutcome,
  reason: string,
  extra: Omit<RuleTraceEntry, "rule" | "result"> = {},
): RuleOutcome {
  return { entry: { rule, result: "FAIL", ...extra }, outcome, reason };
}

/** The service identity for cooldown: an endpoint's canonical host (`canonUrl` normalized). */
function serviceKey(endpoint: string): string {
  return new URL(canonUrl(endpoint)).host;
}

/** Membership by canonical uint256 value — tolerant of decimal-string ids in any equivalent form. */
function includesWorkerId(list: readonly string[], workerAgentId: bigint): boolean {
  return list.some((id) => {
    try {
      return BigInt(id) === workerAgentId;
    } catch {
      return false;
    }
  });
}

/** Trace label per §8.2 — `duplicate.` + the configured key tuple, e.g. `duplicate.taskHash_endpoint_paramsHash`. */
export function duplicateRuleName(policy: Policy): string {
  return `duplicate.${policy.rules.duplicates.keys.join("_")}`;
}

// duplicate (§7.1: taskHash+endpoint+paramsHash within TTL) → BLOCKED_DUPLICATE
const ruleDuplicate: RuleFn = ({ intent, policy, state, nowMs }) => {
  const rule = duplicateRuleName(policy);
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
      return halt(
        rule,
        "BLOCKED_DUPLICATE",
        `duplicate of ${prior.intentId} within ${policy.rules.duplicates.ttlMin}m TTL (${ttlRemainingSec}s remaining)`,
        { priorIntentId: prior.intentId, ttlRemainingSec },
      );
    }
  }
  return pass(rule);
};

// cooldown (§7.1: same-service not elapsed) → BLOCKED_COOLDOWN
const ruleCooldown: RuleFn = ({ intent, policy, state, nowMs }) => {
  const rule = "cooldown.sameService";
  const windowSec = policy.rules.cooldowns.sameServiceMin * 60;
  const last = state.lastCallByService[serviceKey(intent.endpoint)];
  if (typeof last !== "number" || !Number.isFinite(last)) {
    return pass(rule, { limit: windowSec }); // no prior call to this service
  }
  const elapsedSec = Math.floor((nowMs - last) / 1000);
  if (nowMs - last >= windowSec * 1000) {
    return pass(rule, { observed: elapsedSec, limit: windowSec });
  }
  const cooldownRemainingSec = Math.max(0, Math.ceil((last + windowSec * 1000 - nowMs) / 1000));
  return halt(
    rule,
    "BLOCKED_COOLDOWN",
    `same-service cooldown not elapsed: ${cooldownRemainingSec}s remaining of a ${policy.rules.cooldowns.sameServiceMin}m window`,
    { observed: Math.max(0, elapsedSec), limit: windowSec, cooldownRemainingSec },
  );
};

// recipient (§7.1: deny / not on allowlist) → BLOCKED_RECIPIENT
const ruleRecipient: RuleFn = ({ intent, policy }) => {
  const rule = "recipient.allowDeny";
  const recipient = canonAddress(intent.recipientAddress);
  const deny = policy.rules.recipients.deny.map(canonAddress);
  const allow = policy.rules.recipients.allow.map(canonAddress);
  if (deny.includes(recipient)) {
    return halt(rule, "BLOCKED_RECIPIENT", `recipient ${recipient} is on the deny list`, {
      observed: recipient,
      matchedList: "deny",
    });
  }
  if (allow.length > 0 && !allow.includes(recipient)) {
    return halt(rule, "BLOCKED_RECIPIENT", `recipient ${recipient} is not on the (non-empty) allow list`, {
      observed: recipient,
      matchedList: "allow",
    });
  }
  return pass(rule, { observed: recipient });
};

// worker agent (§7.1: worker agentId blocked / not allowed) → BLOCKED_AGENT
const ruleWorkerAgent: RuleFn = ({ intent, policy }) => {
  const rule = "agent.workerAllowDeny";
  const worker = intent.workerAgentId;
  if (worker === 0n) {
    return pass(rule, { observed: "0" }); // A2MCP endpoint call (§8.1) — no worker agent to gate
  }
  const observed = worker.toString();
  const { allowWorkerIds, denyWorkerIds } = policy.rules.agents;
  if (includesWorkerId(denyWorkerIds, worker)) {
    return halt(rule, "BLOCKED_AGENT", `worker agent ${observed} is on the deny list`, {
      observed,
      matchedList: "deny",
    });
  }
  if (allowWorkerIds.length > 0 && !includesWorkerId(allowWorkerIds, worker)) {
    return halt(rule, "BLOCKED_AGENT", `worker agent ${observed} is not on the (non-empty) allow list`, {
      observed,
      matchedList: "allow",
    });
  }
  return pass(rule, { observed });
};

// category (§7.1: category not allowed) → BLOCKED_CATEGORY
const ruleCategory: RuleFn = ({ intent, policy }) => {
  const rule = "category.allow";
  const norm = (s: string): string => s.trim().toLowerCase();
  const category = norm(intent.category);
  const deny = policy.rules.categories.deny.map(norm);
  const allow = policy.rules.categories.allow.map(norm);
  if (deny.includes(category)) {
    return halt(rule, "BLOCKED_CATEGORY", `category "${category}" is on the deny list`, {
      observed: category,
      matchedList: "deny",
    });
  }
  if (allow.length > 0 && !allow.includes(category)) {
    return halt(rule, "BLOCKED_CATEGORY", `category "${category}" is not on the (non-empty) allow list`, {
      observed: category,
      matchedList: "allow",
    });
  }
  return pass(rule, { observed: category });
};

// intent-bound (§7.1: amount > intent.maxAmount) → BLOCKED_INTENT_BOUND
const ruleIntentBound: RuleFn = ({ intent, policy }) => {
  const rule = "intent.maxAmountBound";
  const token = policy.rules.budgets.token;
  const observed = money(intent.amount);
  const maxDisplay = money(Number(intent.maxAmount) / BASE_UNITS_PER_DISPLAY);
  if (BigInt(minorUnits(intent.amount)) > intent.maxAmount) {
    return halt(
      rule,
      "BLOCKED_INTENT_BOUND",
      `amount ${observed} exceeds the intent's own maxAmount ${maxDisplay} ${token}`,
      { observed, limit: maxDisplay, token },
    );
  }
  return pass(rule, { observed, limit: maxDisplay, token });
};

// per-call cap (§7.1: per-call cap exceeded → ESCALATED or BLOCKED, per policy)
const rulePerCallCap: RuleFn = ({ intent, policy }) => {
  const rule = "perCall.cap";
  const token = policy.rules.budgets.token;
  const cap = policy.rules.perCallCap;
  const observed = money(intent.amount);
  const limit = money(cap);
  if (minorUnits(intent.amount) > minorUnits(cap)) {
    const mode = policy.rules.onPerCallCapExceeded ?? "BLOCK";
    const outcome = mode === "ESCALATE" ? "ESCALATED_PER_CALL_CAP" : "BLOCKED_PER_CALL_CAP";
    return halt(
      rule,
      outcome,
      `per-call cap exceeded: ${observed} > ${limit} ${token} (policy onPerCallCapExceeded ⇒ ${mode})`,
      { observed, limit, token },
    );
  }
  return pass(rule, { observed, limit, token });
};

// budget.daily (§7.1: spentToday + amount vs budgets.daily) → BLOCKED_BUDGET
const ruleBudgetDaily: RuleFn = ({ intent, policy, state }) => {
  const rule = "budget.daily";
  const daily = policy.rules.budgets.daily;
  const token = policy.rules.budgets.token;
  const projected = state.spentTodayByAgent + intent.amount;
  const observed = money(projected);
  const limit = money(daily);
  if (minorUnits(projected) > minorUnits(daily)) {
    return halt(rule, "BLOCKED_BUDGET", `daily budget exceeded: projected ${observed} > ${limit} ${token}`, {
      observed,
      limit,
      token,
    });
  }
  return pass(rule, { observed, limit, token });
};

// rate limit (§7.1: rate limit exceeded) → BLOCKED_RATE
const ruleRateLimit: RuleFn = ({ policy, state }) => {
  const rule = "rate.limit";
  const cap = policy.rules.rateLimit.callsPerHour;
  const projected = state.callsInLastHour + 1;
  if (projected > cap) {
    return halt(rule, "BLOCKED_RATE", `rate limit exceeded: this call is #${projected} in the last hour, cap ${cap}/h`, {
      observed: projected,
      limit: cap,
    });
  }
  return pass(rule, { observed: projected, limit: cap });
};

// escalate-above threshold (§7.1: amount > escalateAbove) → ESCALATED_THRESHOLD
const ruleEscalateAbove: RuleFn = ({ intent, policy }) => {
  const rule = "escalate.aboveThreshold";
  const token = policy.rules.budgets.token;
  const threshold = policy.rules.escalateAbove;
  const observed = money(intent.amount);
  const limit = money(threshold);
  if (minorUnits(intent.amount) > minorUnits(threshold)) {
    return halt(
      rule,
      "ESCALATED_THRESHOLD",
      `amount ${observed} is above the escalate-above threshold ${limit} ${token} — routed to approval`,
      { observed, limit, token },
    );
  }
  return pass(rule, { observed, limit, token });
};

type ChainStep = { readonly kind: "rule"; readonly fn: RuleFn } | { readonly kind: "stub"; readonly rule: string };

/**
 * The RULE_EVAL chain in §7.1 order. Real rules slot into their exact positions relative to the
 * three interleaved stubs — NOT appended at the end. Order is load-bearing: it is what makes the
 * short-circuit deterministic (an intent that violates two rules fails on the earlier one).
 */
const RULE_EVAL_CHAIN: readonly ChainStep[] = [
  { kind: "rule", fn: ruleDuplicate }, // BLOCKED_DUPLICATE
  { kind: "rule", fn: ruleCooldown }, // BLOCKED_COOLDOWN
  { kind: "stub", rule: "replay.contextBinding" }, // BLOCKED_REPLAY (stubbed)
  { kind: "rule", fn: ruleRecipient }, // BLOCKED_RECIPIENT
  { kind: "rule", fn: ruleWorkerAgent }, // BLOCKED_AGENT
  { kind: "rule", fn: ruleCategory }, // BLOCKED_CATEGORY
  { kind: "stub", rule: "vendor.lcbFloor" }, // BLOCKED_VENDOR_RISK | ESCALATED_VENDOR_RISK (stubbed)
  { kind: "rule", fn: ruleIntentBound }, // BLOCKED_INTENT_BOUND
  { kind: "rule", fn: rulePerCallCap }, // BLOCKED_PER_CALL_CAP | ESCALATED_PER_CALL_CAP
  { kind: "rule", fn: ruleBudgetDaily }, // BLOCKED_BUDGET
  { kind: "rule", fn: ruleRateLimit }, // BLOCKED_RATE
  { kind: "stub", rule: "proof.tierRequired" }, // ESCALATED_PROOF_TIER (stubbed)
  { kind: "rule", fn: ruleEscalateAbove }, // ESCALATED_THRESHOLD
] as const;

function stubEntry(rule: string): RuleTraceEntry {
  return {
    rule,
    result: "PASS",
    implemented: false,
    note: "NOT_YET_IMPLEMENTED — stubbed in this slice; see PRD §7.1 for the real rule",
  };
}

/**
 * Run the ordered §7.1 RULE_EVAL chain, appending each rule's trace entry (including stubs) to
 * `rules` as it goes. Returns the first terminal `outcome` (short-circuit), or `null` if every
 * rule passed. Entries are pushed incrementally, so a mid-chain throw still leaves a partial trace
 * for the caller's fail-closed handler.
 */
export function evaluateRuleChain(
  ctx: RuleContext,
  rules: RuleTraceEntry[],
): { outcome: DecisionOutcome | null; reason?: string } {
  for (const step of RULE_EVAL_CHAIN) {
    if (step.kind === "stub") {
      rules.push(stubEntry(step.rule));
      continue;
    }
    const res = step.fn(ctx);
    rules.push(res.entry);
    if (res.outcome) {
      return res.reason === undefined ? { outcome: res.outcome } : { outcome: res.outcome, reason: res.reason };
    }
  }
  return { outcome: null };
}

export type { RuleContext };
