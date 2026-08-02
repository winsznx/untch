import { canonAddress, canonUrl } from "@untch/canon";
import type {
  DecisionOutcome,
  LedgerWindowState,
  Policy,
  PolicyRules,
  RuleTraceEntry,
  SpendIntentInput,
} from "./types";

/**
 * The rule layer for the §7.1 RULE_EVAL engine.
 *
 * All thirteen RULE_EVAL rules are real here (plus `policy.active` lookup), in exact §7.1 order.
 * Bureau scores, CBC challenges, and available proof tiers are injected on `LedgerWindowState` —
 * this package stays pure (no I/O). When a floor/challenge is not configured, the matching rule
 * PASSes with an explicit note rather than inventing enforcement.
 */

/**
 * Real rules in decision-trace order: `policy.active` then thirteen RULE_EVAL rules.
 * `duplicate.*`'s label derives from the configured keys; the default tuple yields the name pinned here.
 */
export const IMPLEMENTED_RULES = [
  "policy.active",
  "duplicate.taskHash_endpoint_paramsHash",
  "cooldown.sameService",
  "replay.contextBinding",
  "recipient.allowDeny",
  "agent.workerAllowDeny",
  "category.allow",
  "vendor.lcbFloor",
  "intent.maxAmountBound",
  "hardCap.absolute",
  "perCall.cap",
  "budget.daily",
  "rate.limit",
  "proof.tierRequired",
  "escalate.aboveThreshold",
] as const;

/** No RULE_EVAL stubs remain — kept as empty const for callers that still import the name. */
export const STUBBED_RULES = [] as const;

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

/**
 * Resolve one configured duplicate key to a comparable string, or null when it cannot be resolved.
 *
 * Null is the load-bearing return. A key the engine cannot evaluate must stop the decision, because
 * the alternative — skipping it — silently evaluates a narrower rule than the policy hash commits to.
 */
function duplicateKeyValue(
  key: string,
  from: {
    readonly taskHash: string;
    readonly endpoint: string;
    readonly paramsHash: string;
    readonly maxAmount?: string;
    readonly recipientAddress?: string;
    readonly category?: string;
  },
): string | null {
  switch (key) {
    case "taskHash":
      return from.taskHash.toLowerCase();
    case "endpoint":
    case "provider":
      // A provider IS its endpoint's canonical service identity here. There is no separate provider
      // id on the protocol struct, and inventing one would be a second name for the same thing.
      return canonUrl(from.endpoint);
    case "paramsHash":
      return from.paramsHash.toLowerCase();
    case "capability":
      return from.category ?? null;
    case "amount":
      return from.maxAmount ?? null;
    case "recipient":
      return from.recipientAddress?.toLowerCase() ?? null;
    default:
      return null;
  }
}

// duplicate (§7.1) → BLOCKED_DUPLICATE, keyed on the tuple the POLICY configures
const ruleDuplicate: RuleFn = ({ intent, policy, state, nowMs }) => {
  const rule = duplicateRuleName(policy);
  const ttlMs = policy.rules.duplicates.ttlMin * 60_000;
  const keys = policy.rules.duplicates.keys;

  const current = {
    taskHash: intent.taskHash,
    endpoint: intent.endpoint,
    paramsHash: intent.paramsHash,
    maxAmount: intent.maxAmount.toString(),
    recipientAddress: intent.recipientAddress,
    category: intent.category,
  };

  /**
   * The rule is built from `duplicates.keys`, which is what the policy hash commits to.
   *
   * It used to compare a hardcoded `taskHash + endpoint + paramsHash` while REPORTING the configured
   * tuple in its trace label. An auditor reading the trace saw `duplicate.provider_capability_amount_
   * recipient` and concluded that tuple had been applied. It had not, and two payments differing only
   * in amount blocked each other.
   */
  const currentTuple: string[] = [];
  for (const key of keys) {
    const value = duplicateKeyValue(key, current);
    if (value === null) {
      return halt(
        rule,
        "BLOCKED_FAIL_CLOSED",
        `duplicate key '${key}' cannot be evaluated for this intent, and the policy hash commits to it. ` +
          "Refusing rather than judging on a narrower tuple than the one that was registered.",
        { unresolvableKey: key, configuredKeys: [...keys] },
      );
    }
    currentTuple.push(value);
  }

  for (const prior of state.recentIntents) {
    const ageMs = nowMs - prior.createdAtMs;
    const withinTtl = ageMs >= 0 && ageMs < ttlMs;
    if (!withinTtl) continue;

    let comparable = true;
    let same = true;
    for (const [i, key] of keys.entries()) {
      const priorValue = duplicateKeyValue(key, prior);
      if (priorValue === null) {
        // A prior row written before this field existed cannot be compared on it. Skipping the ROW is
        // correct and skipping the KEY would not be: the first narrows what counts as a duplicate for
        // one historical record, the second narrows the rule itself for every record.
        comparable = false;
        break;
      }
      if (priorValue !== currentTuple[i]) {
        same = false;
        break;
      }
    }
    if (!comparable || !same) continue;

    const ttlRemainingSec = Math.max(0, Math.ceil((prior.createdAtMs + ttlMs - nowMs) / 1000));
    return halt(
      rule,
      "BLOCKED_DUPLICATE",
      `duplicate of ${prior.intentId} within ${policy.rules.duplicates.ttlMin}m TTL (${ttlRemainingSec}s remaining)`,
      { priorIntentId: prior.intentId, ttlRemainingSec, matchedOn: [...keys] },
    );
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

/**
 * hard cap — the line nothing crosses, approved or not.
 *
 * `hardCap` was collected from the user, validated against the other limits, written into the
 * canonical ruleset, committed to by `policyHash`, ANCHORED ON CHAIN, and rendered to the user as
 * "Nothing above N, approved or not". No rule read it. A policy registered on mainnet promised an
 * absolute ceiling that nothing enforced.
 *
 * It runs BEFORE `perCall.cap` and therefore before `escalate.aboveThreshold`, which is the whole
 * point: a per-call breach may escalate to a human, and a hard-cap breach must not be reachable by
 * approval. Ordering it after would let the exact thing the field promises to prevent be approved.
 *
 * Optional in the ruleset, so a policy that configured no hard cap passes. Absent means "no ceiling
 * beyond the per-call cap", never "a ceiling of zero".
 */
const ruleHardCap: RuleFn = ({ intent, policy }) => {
  const rule = "hardCap.absolute";
  const cap = (policy.rules as { hardCap?: number }).hardCap;
  if (cap === undefined || cap === null) return pass(rule);
  const token = policy.rules.budgets.token;
  const observed = money(intent.amount);
  if (minorUnits(intent.amount) > minorUnits(cap)) {
    return halt(
      rule,
      "BLOCKED_PER_CALL_CAP",
      `hard cap exceeded: ${observed} > ${money(cap)} ${token}. This is the ceiling nothing crosses, ` +
        "so it blocks rather than routing to approval.",
      { observed, limit: money(cap), token },
    );
  }
  return pass(rule);
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

// ── replay.contextBinding (§14 CBC inject) → BLOCKED_REPLAY | REJECTED_BINDING ─────────────

/** Field order matches @untch/x402-guard CBC (nonce/expiry → REPLAY; rest → BINDING). */
const CBC_FIELDS: readonly {
  field: string;
  code: "BLOCKED_REPLAY" | "REJECTED_BINDING";
  optional: boolean;
}[] = [
  { field: "recipient", code: "REJECTED_BINDING", optional: false },
  { field: "token", code: "REJECTED_BINDING", optional: false },
  { field: "amount", code: "REJECTED_BINDING", optional: false },
  { field: "resourceUrl", code: "REJECTED_BINDING", optional: false },
  { field: "endpoint", code: "REJECTED_BINDING", optional: false },
  { field: "method", code: "REJECTED_BINDING", optional: false },
  { field: "nonce", code: "BLOCKED_REPLAY", optional: true },
  { field: "expiry", code: "BLOCKED_REPLAY", optional: true },
  { field: "taskHash", code: "REJECTED_BINDING", optional: true },
  { field: "intentHash", code: "REJECTED_BINDING", optional: true },
  { field: "policyId", code: "REJECTED_BINDING", optional: true },
  { field: "metadataHash", code: "REJECTED_BINDING", optional: true },
];

function normCbcValue(field: string, v: string): string {
  const t = v.trim();
  if (field === "recipient" || field === "token") return t.toLowerCase();
  if (field === "method") return t.toUpperCase();
  if (field.endsWith("Hash") || field === "taskHash" || field === "intentHash" || field === "metadataHash") {
    return t.toLowerCase();
  }
  if (field === "resourceUrl" || field === "endpoint") {
    try {
      return canonUrl(t);
    } catch {
      return t;
    }
  }
  return t;
}

const ruleReplayContext: RuleFn = ({ policy, state }) => {
  const rule = "replay.contextBinding";
  const binding = state.challengeBinding;
  const require = policy.rules.requireChallenge === true;
  if (!binding) {
    if (require) {
      return halt(
        rule,
        "BLOCKED_REPLAY",
        "policy requires challenge binding but none was supplied — failing closed",
        { note: "REQUIRE_CHALLENGE" },
      );
    }
    return pass(rule, { note: "NO_CHALLENGE" });
  }
  const { expected, presented } = binding;
  for (const spec of CBC_FIELDS) {
    const rawE = expected[spec.field];
    const rawP = presented[spec.field];
    const hasE = typeof rawE === "string" && rawE.trim().length > 0;
    const hasP = typeof rawP === "string" && rawP.trim().length > 0;
    if (!hasE && !hasP) {
      if (spec.optional) continue;
      return halt(rule, spec.code, `challenge field ${spec.field} missing on both sides`, {
        note: spec.field,
      });
    }
    if (hasE !== hasP) {
      return halt(
        rule,
        spec.code,
        `challenge field ${spec.field} present on only one side`,
        { note: spec.field },
      );
    }
    if (normCbcValue(spec.field, rawE!) !== normCbcValue(spec.field, rawP!)) {
      return halt(
        rule,
        spec.code,
        `challenge field ${spec.field} mismatch (expected ≠ presented)`,
        { note: spec.field },
      );
    }
  }
  return pass(rule, { note: "CBC_OK" });
};

// ── vendor.lcbFloor (§12 bureau inject) → BLOCKED_VENDOR_RISK | ESCALATED_VENDOR_RISK ──────

const ruleVendorLcbFloor: RuleFn = ({ policy, state, nowMs }) => {
  const rule = "vendor.lcbFloor";
  const vendors = policy.rules.vendors;
  if (!vendors || typeof vendors.minScoreLCB !== "number") {
    return pass(rule, { note: "NO_VENDOR_FLOOR" });
  }
  const floor = vendors.minScoreLCB;
  const onBelow = vendors.onBelowFloor === "ESCALATE" ? "ESCALATE" : "BLOCK";
  const onUnavail = vendors.onScoreUnavailable ?? "BLOCK";
  const score = state.vendorScore;

  if (!score || !score.available) {
    // No snapshot at all: USE_STALE cannot help — fail closed (BLOCK unless ESCALATE requested).
    if (onUnavail === "ESCALATE") {
      return halt(rule, "ESCALATED_VENDOR_RISK", "vendor score unavailable — escalated per policy", {
        limit: floor,
        note: "SCORE_UNAVAILABLE",
      });
    }
    return halt(rule, "BLOCKED_VENDOR_RISK", "vendor score unavailable — blocked per policy", {
      limit: floor,
      note: "SCORE_UNAVAILABLE",
    });
  }

  const maxAgeH = vendors.staleScoreMaxAgeH;
  if (typeof maxAgeH === "number" && maxAgeH >= 0) {
    const ageH = (nowMs - score.computedAtMs) / 3_600_000;
    if (ageH > maxAgeH) {
      if (onUnavail === "ESCALATE") {
        return halt(rule, "ESCALATED_VENDOR_RISK", `vendor score stale (${ageH.toFixed(1)}h > ${maxAgeH}h)`, {
          observed: score.lcb,
          limit: floor,
          raw: score.score,
          sigma: score.sigma,
          note: "SCORE_STALE",
        });
      }
      if (onUnavail !== "USE_STALE") {
        return halt(rule, "BLOCKED_VENDOR_RISK", `vendor score stale (${ageH.toFixed(1)}h > ${maxAgeH}h)`, {
          observed: score.lcb,
          limit: floor,
          raw: score.score,
          sigma: score.sigma,
          note: "SCORE_STALE",
        });
      }
      // USE_STALE: continue with the snapshot despite age
    }
  }

  if (score.lcb < floor) {
    if (onBelow === "ESCALATE") {
      return halt(
        rule,
        "ESCALATED_VENDOR_RISK",
        `vendor LCB ${score.lcb.toFixed(4)} below floor ${floor}`,
        { observed: score.lcb, limit: floor, raw: score.score, sigma: score.sigma },
      );
    }
    return halt(
      rule,
      "BLOCKED_VENDOR_RISK",
      `vendor LCB ${score.lcb.toFixed(4)} below floor ${floor}`,
      { observed: score.lcb, limit: floor, raw: score.score, sigma: score.sigma },
    );
  }
  return pass(rule, {
    observed: score.lcb,
    limit: floor,
    raw: score.score,
    sigma: score.sigma,
  });
};

// ── proof.tierRequired → ESCALATED_PROOF_TIER when required > available ───────────────────

/** Required proof tier for a display amount given optional policy.proof. */
export function requiredProofTier(
  amount: number,
  proof: PolicyRules["proof"] | undefined,
): number {
  if (!proof) return 0;
  let required = typeof proof.defaultTier === "number" ? proof.defaultTier : 0;
  for (const row of proof.requireTierAbove ?? []) {
    if (amount > row.amount && row.tier > required) required = row.tier;
  }
  return required;
}

const ruleProofTier: RuleFn = ({ intent, policy, state }) => {
  const rule = "proof.tierRequired";
  const required = requiredProofTier(intent.amount, policy.rules.proof);
  const available = typeof state.availableProofTier === "number" ? state.availableProofTier : 0;
  if (required > available) {
    return halt(
      rule,
      "ESCALATED_PROOF_TIER",
      `required proof tier T${required} exceeds available T${available} — escalate for higher-tier verify`,
      { observed: available, limit: required },
    );
  }
  return pass(rule, { observed: available, limit: required });
};

type ChainStep = { readonly kind: "rule"; readonly fn: RuleFn };

/**
 * The RULE_EVAL chain in §7.1 order. Order is load-bearing: short-circuit is deterministic
 * (an intent that violates two rules fails on the earlier one).
 */
const RULE_EVAL_CHAIN: readonly ChainStep[] = [
  { kind: "rule", fn: ruleDuplicate },
  { kind: "rule", fn: ruleCooldown },
  { kind: "rule", fn: ruleReplayContext },
  { kind: "rule", fn: ruleRecipient },
  { kind: "rule", fn: ruleWorkerAgent },
  { kind: "rule", fn: ruleCategory },
  { kind: "rule", fn: ruleVendorLcbFloor },
  { kind: "rule", fn: ruleIntentBound },
  { kind: "rule", fn: ruleHardCap },
  { kind: "rule", fn: rulePerCallCap },
  { kind: "rule", fn: ruleBudgetDaily },
  { kind: "rule", fn: ruleRateLimit },
  { kind: "rule", fn: ruleProofTier },
  { kind: "rule", fn: ruleEscalateAbove },
] as const;

/**
 * Run the ordered §7.1 RULE_EVAL chain, appending each rule's trace entry to `rules` as it goes.
 * Returns the first terminal `outcome` (short-circuit), or `null` if every rule passed.
 */
export function evaluateRuleChain(
  ctx: RuleContext,
  rules: RuleTraceEntry[],
): { outcome: DecisionOutcome | null; reason?: string } {
  for (const step of RULE_EVAL_CHAIN) {
    const res = step.fn(ctx);
    rules.push(res.entry);
    if (res.outcome) {
      return res.reason === undefined ? { outcome: res.outcome } : { outcome: res.outcome, reason: res.reason };
    }
  }
  return { outcome: null };
}

export type { RuleContext };
