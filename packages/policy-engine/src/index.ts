/**
 * @untch/policy-engine — deterministic preflight policy engine (PRD §7.1).
 *
 * PARTIAL SLICE. Real: intent canonicalization/validation, the policy-active lookup, ten of the
 * thirteen §7.1 RULE_EVAL rules (duplicate, cooldown, recipient, worker-agent, category,
 * intent-bound, per-call cap, budget.daily, rate limit, escalate-above), and the per-agent
 * concurrency lock that makes budget checks race-safe. THREE RULE_EVAL rules remain explicit
 * NOT-YET-IMPLEMENTED stubs surfaced in the decision trace (`implemented: false`), never silently
 * skipped or passed: replay/context-binding, vendor LCB floor, and proof-tier requirement. See
 * README.md and PRD §7.1.
 *
 * Invariants held here: I1 (no LLM — pure deterministic logic) and I2 (fail closed — any
 * missing/malformed input yields a BLOCKED_* / REJECTED_* / ESCALATED_* outcome, never a silent
 * APPROVE).
 */
export { evaluateIntent, type EvaluateOptions } from "./evaluate";
export {
  PerAgentLock,
  evaluateIntentSerialized,
  type Ledger,
  type SerializeOptions,
} from "./concurrency";
export {
  IMPLEMENTED_RULES,
  STUBBED_RULES,
  duplicateRuleName,
  evaluatePolicyActive,
} from "./rules";
export type {
  Decision,
  DecisionOutcome,
  RuleResult,
  RuleTraceEntry,
  Policy,
  PolicyRules,
  PolicyStatus,
  OnPerCallCapExceeded,
  SpendIntentInput,
  LedgerWindowState,
  RecentIntent,
} from "./types";
