/**
 * @untch/policy-engine — deterministic preflight policy engine (PRD §7.1).
 *
 * PARTIAL SLICE. Real: intent canonicalization/validation, policy-active lookup, the duplicate and
 * budget.daily rules, and the per-agent concurrency lock that makes budget checks race-safe. Every
 * other §7.1 RULE_EVAL rule is an explicit NOT-YET-IMPLEMENTED stub surfaced in the decision trace
 * (`implemented: false`), never silently skipped or passed. See README.md and PRD §7.1.
 *
 * Invariants held here: I1 (no LLM — pure deterministic logic) and I2 (fail closed — any
 * missing/malformed input yields a BLOCKED_* / REJECTED_* outcome, never a silent APPROVE).
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
  evaluateDuplicate,
  evaluateBudget,
  buildStubTrace,
} from "./rules";
export type {
  Decision,
  DecisionOutcome,
  RuleResult,
  RuleTraceEntry,
  Policy,
  PolicyRules,
  PolicyStatus,
  SpendIntentInput,
  LedgerWindowState,
  RecentIntent,
} from "./types";
