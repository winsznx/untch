import type { EscalationView, OrderRecord, VerifyRecord } from "../datasource";
import { isApproved, isBlocked, VERIFY_FAIL, VERIFY_SKIPPED_UNCOMMITTED } from "../decision-codes";

/**
 * The four REAL buyer-hygiene features (§12) — every signal maps onto a subsystem already built, so
 * NONE needs a cold-start fallback. Each returns a "badness" rate in [0,1] (higher = worse hygiene) and
 * an `n` (the sample it was measured over, which drives σ). Hygiene never blocks a buyer's own spend
 * (§12) — it annotates counterparty risk; the score is assembled in `score.ts`.
 */

export interface RawHygiene {
  readonly badness: number;
  readonly n: number;
  readonly note: string;
}

/** unbound_acceptance_rate: fraction of the buyer's verify events that were SKIPPED_UNCOMMITTED — i.e.
 *  the buyer paid without committing acceptance criteria (proof-engine's VERIFY_SKIPPED_UNCOMMITTED). */
export function unboundAcceptanceRate(verifies: readonly VerifyRecord[]): RawHygiene {
  const n = verifies.length;
  if (n === 0) return { badness: 0, n: 0, note: "no verify events yet — no evidence either way" };
  const skipped = verifies.filter((v) => v.verifyResult === VERIFY_SKIPPED_UNCOMMITTED).length;
  return {
    badness: skipped / n,
    n,
    note: `${skipped}/${n} verify events had no committed acceptance criteria (VERIFY_SKIPPED_UNCOMMITTED)`,
  };
}

/**
 * ignores_verification_rate: of the buyer's FAILED verifications, the fraction that were followed (by
 * timestamp) by a later APPROVED spend to the SAME vendor — the receipt-history-detectable proxy for
 * "pays despite a VERIFY_FAILED result". No fails ⇒ 0 (nothing to ignore).
 */
export function ignoresVerificationRate(
  orders: readonly OrderRecord[],
  verifies: readonly VerifyRecord[],
): RawHygiene {
  const fails = verifies.filter((v) => v.verifyResult === VERIFY_FAIL);
  if (fails.length === 0) {
    return { badness: 0, n: 0, note: "no failed verifications — no ignore pattern to detect" };
  }
  const approvedAfter = (vendorId: string, afterIso: string): boolean =>
    orders.some(
      (o) =>
        isApproved(o.decision) &&
        o.vendorId.toLowerCase() === vendorId.toLowerCase() &&
        o.createdAt > afterIso,
    );
  const ignored = fails.filter((f) => approvedAfter(f.vendorId, f.createdAt)).length;
  return {
    badness: ignored / fails.length,
    n: fails.length,
    note: `${ignored}/${fails.length} failed verifications were followed by another approved spend to the same vendor`,
  };
}

/** out_of_policy_rate: fraction of the buyer's DECISION receipts that were a BLOCKED_* outcome — the
 *  policy engine's own trace history (§8.2), read off the durable receipts, not re-run. */
export function outOfPolicyRate(orders: readonly OrderRecord[]): RawHygiene {
  const n = orders.length;
  if (n === 0) return { badness: 0, n: 0, note: "no decisions yet — no evidence either way" };
  const blocked = orders.filter((o) => isBlocked(o.decision)).length;
  return {
    badness: blocked / n,
    n,
    note: `${blocked}/${n} preflight decisions were BLOCKED_* (out-of-policy attempts)`,
  };
}

/**
 * late_escalation_rate: fraction of the buyer's escalations that resolved LATE — timed out (EXPIRED) or
 * were resolved after the approval-code window (`resolved_at > code_expires_at`). Timing comes straight
 * from the escalation service's durable record. No escalations ⇒ 0.
 */
export function lateEscalationRate(escalations: readonly EscalationView[]): RawHygiene {
  const n = escalations.length;
  if (n === 0) return { badness: 0, n: 0, note: "no escalations yet — no evidence either way" };
  const late = escalations.filter(
    (e) => e.status === "EXPIRED" || (e.resolvedAt !== null && e.resolvedAt > e.codeExpiresAt),
  ).length;
  return {
    badness: late / n,
    n,
    note: `${late}/${n} escalations resolved late (timed out or past the approval window)`,
  };
}
