import { canonAddress, canonTimestamp, canonUint256, canonUrl, hashSpendIntent } from "@untch/canon";
import type { Hex } from "viem";
import { evaluatePolicyActive, evaluateRuleChain } from "./rules";
import type {
  Decision,
  DecisionOutcome,
  LedgerWindowState,
  Policy,
  RuleTraceEntry,
  SpendIntentInput,
} from "./types";

/**
 * `evaluateIntent` — the pure, deterministic preflight pipeline (PRD §7.1). No LLM (I1), no I/O,
 * no clock unless injected: given an intent, an active-policy record, and a ledger snapshot it
 * returns a §8.2-shaped Decision. Fail-closed (I2): any missing/malformed input yields a
 * BLOCKED_* / REJECTED_* outcome — never a silent APPROVE.
 *
 * Pipeline: canonicalize+validate → policy-active lookup → state-assembly guard → RULE_EVAL
 * (the ordered §7.1 chain in `rules.ts` — ten real rules interleaved with three stubs),
 * short-circuiting on the first fail/escalate with the full partial trace attached.
 */

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

export interface EvaluateOptions {
  /** Injectable clock (epoch ms) for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export function evaluateIntent(
  intent: SpendIntentInput,
  policy: Policy | null | undefined,
  state: LedgerWindowState,
  opts?: EvaluateOptions,
): Decision {
  const nowMs = opts?.now ? opts.now() : Date.now();
  const evaluatedAt = canonTimestamp(new Date(nowMs));
  const policyId = policy?.id ?? "0";
  const policyVersion = policy?.version ?? 0;

  const make = (
    decision: DecisionOutcome,
    intentHash: Hex,
    reasons: string[],
    rules: RuleTraceEntry[],
  ): Decision => ({ decision, intentHash, policyId, policyVersion, evaluatedAt, reasons, rules });

  // 1. INTENT_CANONICAL — validate required fields; compute intentHash via @untch/canon.
  const { ok, reasons, intentHash } = validateIntent(intent);
  if (!ok) return make("REJECTED_MALFORMED", intentHash, reasons, []);

  // 2. POLICY_LOOKUP — not ACTIVE / expired / missing ⇒ BLOCKED_NO_ACTIVE_POLICY.
  const pa = evaluatePolicyActive(policy, nowMs);
  const rules: RuleTraceEntry[] = [pa.entry];
  if (!pa.active) {
    return make(
      "BLOCKED_NO_ACTIVE_POLICY",
      intentHash,
      [`no active policy (policy.active observed ${String(pa.entry.observed)})`],
      rules,
    );
  }
  const active = policy as Policy;

  // 3. STATE_ASSEMBLY — malformed ledger window ⇒ fail closed (I2), never evaluate on bad state.
  if (!isValidLedgerState(state)) {
    return make(
      "BLOCKED_FAIL_CLOSED",
      intentHash,
      ["ledger window state missing or malformed — failing closed (I2)"],
      rules,
    );
  }

  // 4. RULE_EVAL — the ordered §7.1 chain, short-circuit on first fail/escalate. Any unexpected
  //    throw (e.g. a malformed prior-intent record) is caught and failed closed, never approved.
  try {
    const { outcome, reason } = evaluateRuleChain({ intent, policy: active, state, nowMs }, rules);
    if (outcome) {
      return make(outcome, intentHash, [reason ?? outcome], rules);
    }
    return make(
      "APPROVED",
      intentHash,
      ["all implemented rules passed; stubbed rules not yet enforced (see trace implemented:false)"],
      rules,
    );
  } catch (err) {
    return make(
      "BLOCKED_FAIL_CLOSED",
      intentHash,
      [`rule evaluation threw — failing closed (I2): ${err instanceof Error ? err.message : String(err)}`],
      rules,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// validation (fail-closed boundary — treats input as untrusted at runtime, I3)
// ─────────────────────────────────────────────────────────────────────────────

interface Validation {
  readonly ok: boolean;
  readonly reasons: string[];
  readonly intentHash: Hex;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function isBytes32(x: unknown): x is Hex {
  return typeof x === "string" && BYTES32.test(x);
}

function isNonNegUint256(x: unknown): x is bigint {
  if (typeof x !== "bigint") return false;
  try {
    canonUint256(x); // throws if negative or > uint256 max
    return true;
  } catch {
    return false;
  }
}

function isValidAddress(x: unknown): boolean {
  if (typeof x !== "string") return false;
  try {
    canonAddress(x);
    return true;
  } catch {
    return false;
  }
}

function isValidUrl(x: unknown): boolean {
  if (typeof x !== "string") return false;
  try {
    canonUrl(x);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the intent's required fields and compute its intentHash. The engine boundary treats
 * intent input as untrusted (I3), so fields typed as `bigint`/`Hex` are re-checked at runtime;
 * the one cast to `Record<string, unknown>` is exactly to read those fields defensively.
 */
function validateIntent(intent: SpendIntentInput): Validation {
  const reasons: string[] = [];
  if (!intent || typeof intent !== "object") {
    return { ok: false, reasons: ["intent missing or not an object"], intentHash: ZERO_HASH };
  }
  const r = intent as unknown as Record<string, unknown>;

  if (!isValidAddress(r.owner)) reasons.push("owner is not a 20-byte hex address");
  if (!isValidAddress(r.token)) reasons.push("token is not a 20-byte hex address");
  if (!isNonNegUint256(r.buyerAgentId)) reasons.push("buyerAgentId is not a uint256 bigint");
  if (!isNonNegUint256(r.workerAgentId)) reasons.push("workerAgentId is not a uint256 bigint");
  if (!isNonNegUint256(r.maxAmount)) reasons.push("maxAmount is not a uint256 bigint");
  if (!isNonNegUint256(r.deadline)) reasons.push("deadline is not a uint256 bigint");
  if (!isNonNegUint256(r.nonce)) reasons.push("nonce is not a uint256 bigint");
  if (!isBytes32(r.taskHash)) reasons.push("taskHash is not a bytes32");
  if (!isBytes32(r.acceptanceHash)) reasons.push("acceptanceHash is not a bytes32");
  if (!isBytes32(r.schemaHash)) reasons.push("schemaHash is not a bytes32");
  if (!isBytes32(r.policyHash)) reasons.push("policyHash is not a bytes32");
  if (!isBytes32(r.paramsHash)) reasons.push("paramsHash is not a bytes32");
  if (!isValidUrl(r.endpoint)) reasons.push("endpoint is not an absolute URL");
  if (!isValidAddress(r.recipientAddress)) reasons.push("recipientAddress is not a 20-byte hex address");
  if (typeof r.category !== "string" || r.category.trim().length === 0) {
    reasons.push("category is not a non-empty string");
  }
  if (typeof r.amount !== "number" || !Number.isFinite(r.amount) || r.amount < 0) {
    reasons.push("amount is not a finite, non-negative number");
  }

  return { ok: reasons.length === 0, reasons, intentHash: tryHashIntent(intent) };
}

/** Compute the §8.1 intentHash via `@untch/canon`; return the zero hash if any struct field is
 *  unhashable (so a malformed intent still yields a well-shaped Decision). */
function tryHashIntent(intent: SpendIntentInput): Hex {
  try {
    return hashSpendIntent({
      owner: canonAddress(intent.owner),
      buyerAgentId: intent.buyerAgentId,
      workerAgentId: intent.workerAgentId,
      token: canonAddress(intent.token),
      maxAmount: intent.maxAmount,
      taskHash: intent.taskHash,
      acceptanceHash: intent.acceptanceHash,
      schemaHash: intent.schemaHash,
      policyHash: intent.policyHash,
      deadline: intent.deadline,
      nonce: intent.nonce,
    });
  } catch {
    return ZERO_HASH;
  }
}

function isValidLedgerState(state: LedgerWindowState): boolean {
  if (!state || typeof state !== "object") return false;
  const s = state as unknown as Record<string, unknown>;
  const spent = s.spentTodayByAgent;
  if (typeof spent !== "number" || !Number.isFinite(spent) || spent < 0) return false;
  if (!Array.isArray(s.recentIntents)) return false;
  const calls = s.callsInLastHour;
  if (typeof calls !== "number" || !Number.isFinite(calls) || calls < 0) return false;
  const lastByService = s.lastCallByService;
  if (!lastByService || typeof lastByService !== "object" || Array.isArray(lastByService)) return false;
  for (const v of Object.values(lastByService as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}
