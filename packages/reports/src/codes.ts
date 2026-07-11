import { decisionToUint8, DECISION_NA } from "@untch/receipt-writer";
import type { DecisionOutcome } from "@untch/policy-engine";

/**
 * Decode the durable receipt code columns back to their semantic names. The maps are BUILT FROM
 * receipt-writer's own `decisionToUint8`, so they can never drift from what is actually written
 * on-chain (§10.3) — the same discipline `@untch/trust-bureau`'s decision-codes uses. The reports
 * read these off `receipts.decision` / `receipts.verify_result`; they never re-run the policy or proof
 * engine (I1 — pure aggregation of already-computed, already-anchored outputs).
 */

const ALL_OUTCOMES: readonly DecisionOutcome[] = [
  "APPROVED",
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
];

const CODE_TO_OUTCOME: ReadonlyMap<number, DecisionOutcome> = new Map(
  ALL_OUTCOMES.map((o) => [decisionToUint8(o), o]),
);

/** Semantic category of a decision outcome, for the reconcile breakdown + dispute classification. */
export type DecisionCategory = "APPROVED" | "BLOCKED" | "ESCALATED" | "REJECTED";

export const APPROVED_CODE = decisionToUint8("APPROVED");

/** BLOCKED_* codes — an out-of-policy attempt whose spend was withheld (the "waste" the operator saved). */
export const BLOCKED_CODES: ReadonlySet<number> = new Set(
  ALL_OUTCOMES.filter((o) => o.startsWith("BLOCKED_")).map(decisionToUint8),
);

/** ESCALATED_* codes — a spend held for operator decision. NOT counted as waste (may still be approved). */
export const ESCALATED_CODES: ReadonlySet<number> = new Set(
  ALL_OUTCOMES.filter((o) => o.startsWith("ESCALATED_")).map(decisionToUint8),
);

/** The DECISION_NA sentinel (0) that a VERIFY receipt carries in its `decision` column. */
export { DECISION_NA };

/** Decode a receipt `decision` uint8 to its §7.1 terminal outcome name, or null for the VERIFY
 *  sentinel / an unknown code (honest null — never a guessed name). */
export function decisionName(code: number): DecisionOutcome | null {
  return CODE_TO_OUTCOME.get(code) ?? null;
}

/** Bucket a decision code into its semantic category (or null for the VERIFY sentinel / unknown). */
export function decisionCategory(code: number): DecisionCategory | null {
  if (code === APPROVED_CODE) return "APPROVED";
  if (BLOCKED_CODES.has(code)) return "BLOCKED";
  if (ESCALATED_CODES.has(code)) return "ESCALATED";
  const name = CODE_TO_OUTCOME.get(code);
  if (name === "REJECTED_MALFORMED") return "REJECTED";
  return null;
}

/** proof-engine VERIFY_RESULT_CODE (§10.3): 0=NONE 1=PASS 2=FAIL 3=SKIPPED_UNCOMMITTED 4=NOT_IMPLEMENTED. */
const VERIFY_NAMES: Readonly<Record<number, string>> = {
  0: "NONE",
  1: "VERIFY_PASSED",
  2: "VERIFY_FAILED",
  3: "VERIFY_SKIPPED_UNCOMMITTED",
  4: "VERIFY_NOT_IMPLEMENTED",
};

export const VERIFY_PASS = 1;
export const VERIFY_FAIL = 2;
export const VERIFY_SKIPPED = 3;
export const VERIFY_NOT_IMPLEMENTED = 4;

/** Decode a receipt `verify_result` uint8 to its §7.3 result name (UNKNOWN for an out-of-range code). */
export function verifyName(code: number): string {
  return VERIFY_NAMES[code] ?? "UNKNOWN";
}
