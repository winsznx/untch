import { decisionToUint8 } from "@untch/receipt-writer";
import type { DecisionOutcome } from "@untch/policy-engine";

/**
 * The receipt `decision` uint8 → semantic category, derived from receipt-writer's OWN `decisionToUint8`
 * so it can never drift from what is actually written on-chain. The Bureau reads these off the durable
 * `receipts.decision` column (the policy engine's own trace history, §8.2), not a re-run of the engine.
 */

const ALL_OUTCOMES: readonly DecisionOutcome[] = [
  "REJECTED_MALFORMED",
  "BLOCKED_NO_ACTIVE_POLICY",
  "BLOCKED_FAIL_CLOSED",
  "BLOCKED_DUPLICATE",
  "BLOCKED_COOLDOWN",
  "BLOCKED_RECIPIENT",
  "BLOCKED_AGENT",
  "BLOCKED_CATEGORY",
  "BLOCKED_INTENT_BOUND",
  "BLOCKED_PER_CALL_CAP",
  "ESCALATED_PER_CALL_CAP",
  "BLOCKED_BUDGET",
  "BLOCKED_RATE",
  "ESCALATED_THRESHOLD",
  "APPROVED",
];

/** Numeric code for an APPROVED decision (a completed, receipted paid order — the reputation input). */
export const APPROVED_CODE = decisionToUint8("APPROVED");

/** The uint8 codes that are a BLOCKED_* outcome — an out-of-policy attempt (§12 buyer hygiene). Built
 *  from the outcome list so a new BLOCKED_* code is picked up automatically. */
export const BLOCKED_CODES: ReadonlySet<number> = new Set(
  ALL_OUTCOMES.filter((o) => o.startsWith("BLOCKED_")).map(decisionToUint8),
);

/** Verify-result codes (proof-engine VERIFY_RESULT_CODE, §10.3): 1=PASS 2=FAIL 3=SKIPPED 4=NOT_IMPL. */
export const VERIFY_PASS = 1;
export const VERIFY_FAIL = 2;
export const VERIFY_SKIPPED_UNCOMMITTED = 3;
export const VERIFY_NOT_IMPLEMENTED = 4;

export function isApproved(code: number): boolean {
  return code === APPROVED_CODE;
}
export function isBlocked(code: number): boolean {
  return BLOCKED_CODES.has(code);
}
