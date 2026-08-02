/**
 * @untch/policy-engine — deterministic preflight policy engine (PRD §7.1).
 *
 * Full RULE_EVAL slice: intent canonicalization/validation, policy-active lookup, all thirteen
 * §7.1 RULE_EVAL rules (including replay/CBC inject, vendor LCB floor inject, proof-tier
 * requirement), and the per-agent concurrency lock. Bureau scores, CBC challenges, and available
 * proof tiers are injected on `LedgerWindowState` — this package stays pure (no I/O).
 *
 * Invariants: I1 (no LLM) and I2 (fail closed — never silent APPROVE).
 */
export { evaluateIntent, type EvaluateOptions } from "./evaluate";
export {
  PerAgentLock,
  evaluateIntentSerialized,
  ledgerPartitionKey,
  type Ledger,
  type SerializeOptions,
} from "./concurrency";
export {
  IMPLEMENTED_RULES,
  STUBBED_RULES,
  duplicateRuleName,
  evaluatePolicyActive,
  requiredProofTier,
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
  OnBelowFloor,
  OnScoreUnavailable,
  SpendIntentInput,
  LedgerWindowState,
  RecentIntent,
} from "./types";
export * from "./manifest";
