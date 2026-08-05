import { randomBytes } from "node:crypto";
import type { ServiceCallTx } from "./x402-service-calls";

/**
 * What happens when the price changes after somebody was asked.
 *
 * THE FAILURE THIS CLOSES
 *
 * An approval is raised for 6.00. The provider re-quotes at 6.50. Without lineage there are now two
 * unrelated requests, and if the 6.00 was already approved there are two live authorities: a 6.00
 * reservation nobody will use and a 6.50 request waiting for a second yes. The budget sees 12.50 of
 * exposure for one piece of work, and the old 6.00 authority is still executable by anything holding
 * its token.
 *
 * A requote is a SUCCESSOR, and saying so explicitly is what lets the old authority be retired in the
 * same transaction the new one is created. Not afterwards by a sweeper, and not by the caller
 * remembering: one transaction, or neither.
 *
 * WHAT A REQUOTE IS NOT
 *
 * It is not a way around the duplicate window or the cooldown. Those exist to stop the same work being
 * bought twice, and a requote is the same work at a different price. So supersession is a claim the
 * NEW request has to earn by naming the exact prior quote it replaces, and a request that names
 * nothing gets no relief from any of the ordinary protections.
 */

export type SupersessionRefusal =
  | "PRIOR_NOT_FOUND"
  | "PRIOR_NOT_SUPERSEDABLE"
  | "LINEAGE_MISMATCH"
  | "QUOTE_UNCHANGED"
  | "ACCOUNT_MISMATCH"
  | "SUCCESSOR_ALREADY_EXISTS";

export type SupersessionResult =
  | {
      readonly ok: true;
      readonly quoteLineageId: string;
      readonly supersededRequestId: string;
      /**
       * What the predecessor was when it was retired.
       *
       * Kept because the three supersedable states mean materially different things to whoever reads
       * the timeline afterwards: retiring a PROVISIONAL costs nobody anything, retiring a PENDING
       * withdraws a question before it was answered, and retiring an APPROVED takes back a hold a
       * person consciously granted. Collapsing them to "SUPERSEDED" loses which of those happened.
       */
      readonly priorState: string;
      readonly supersededReservationId: string | null;
      readonly invalidatedDeliveries: number;
      readonly invalidatedActionRefs: number;
      readonly releasedExposure: string | null;
    }
  | { readonly ok: false; readonly refusal: SupersessionRefusal; readonly detail: string };

export function newQuoteLineageId(): string {
  return `qln_${randomBytes(16).toString("hex")}`;
}

/**
 * NUMERIC comes back from pg as a string with full scale: `6.000000000000000000`.
 *
 * That is the same number and a different string, and this value is compared against amounts that were
 * hashed as `6.00`. Normalising at the boundary keeps one representation of an amount in the API
 * rather than leaving every caller to trim it and one caller to forget.
 */
function normalizeAmount(raw: string): string {
  if (!raw.includes(".")) return `${raw}.00`;
  const trimmed = raw.replace(/0+$/, "");
  const [whole, frac = ""] = trimmed.split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

/**
 * Retire the prior quote's authority, atomically.
 *
 * Called with the NEW request already inserted in the same transaction, so the two exist or neither
 * does. Locks are taken prior-request first, then reservation, matching the order `actOnApproval`
 * uses, so a concurrent approval of the old request and a supersession of it queue rather than
 * deadlock.
 *
 * The race this closes: somebody taps Approve on the 6.00 message at the same moment the 6.50 arrives.
 * Whichever transaction takes the request lock first wins. If the approval wins, this sees APPROVED
 * and supersedes both the request and the reservation it created. If supersession wins, the approval
 * sees SUPERSEDED and refuses with APPROVAL_SUPERSEDED. There is no ordering where both take effect.
 */
export async function supersedePriorQuote(
  tx: ServiceCallTx,
  args: {
    readonly priorApprovalRequestId: string;
    readonly newApprovalRequestId: string;
    readonly quoteLineageId: string;
    readonly newQuoteDigest: string;
    readonly reason: string;
    readonly accountId: string;
  },
): Promise<SupersessionResult> {
  const { rows: priorRows } = await tx.query<Record<string, unknown>>(
    `SELECT * FROM untch_approval_requests WHERE approval_request_id = $1 FOR UPDATE`,
    [args.priorApprovalRequestId],
  );
  const prior = priorRows[0];
  if (!prior) return { ok: false, refusal: "PRIOR_NOT_FOUND", detail: "no such prior approval request" };

  if (prior.account_id !== args.accountId) {
    /**
     * The refusal that stops one account retiring another's authority. Supersession releases budget
     * and kills tokens, so being able to aim it at somebody else's request would be a way to cancel
     * their approvals.
     */
    return { ok: false, refusal: "ACCOUNT_MISMATCH", detail: "the prior request belongs to a different account" };
  }

  if (prior.quote_lineage_id !== null && prior.quote_lineage_id !== args.quoteLineageId) {
    return {
      ok: false,
      refusal: "LINEAGE_MISMATCH",
      detail: "the prior request belongs to a different quote lineage",
    };
  }

  if (String(prior.quote_digest ?? "") === args.newQuoteDigest) {
    /**
     * Nothing changed. Allowing this would make supersession a way to mint a fresh request for the
     * same terms whenever the duplicate window was inconvenient.
     */
    return { ok: false, refusal: "QUOTE_UNCHANGED", detail: "the new quote is identical to the prior one" };
  }

  const supersedable = ["PROVISIONAL", "PENDING", "APPROVED"];
  if (!supersedable.includes(String(prior.state))) {
    return {
      ok: false,
      refusal: "PRIOR_NOT_SUPERSEDABLE",
      detail: `a ${String(prior.state)} request has no live authority to retire`,
    };
  }

  /**
   * THE SUCCESSOR IS NAMED IN THE SAME STATEMENT THAT RETIRES THE PREDECESSOR.
   *
   * It used to be a second UPDATE afterwards, which read fine and defeated the 031 backstop entirely:
   * that trigger fires BEFORE UPDATE, reads `NEW.superseded_by_approval_request_id` to find the
   * successor whose payment it must check, and finds NULL on a statement that has not set it yet. So
   * the exemption for a legacy supersession — which is a real and correct exemption — swallowed every
   * paid one, and the check that exists to stop an unpaid requote destroying authority would have
   * passed everything.
   *
   * One statement, or the invariant is decorative.
   */
  await tx.query(
    `UPDATE untch_approval_requests
        SET state = 'SUPERSEDED', superseded_at = now(), resolved_at = COALESCE(resolved_at, now()),
            supersession_reason = $2, quote_lineage_id = $3,
            superseded_by_approval_request_id = $4,
            updated_at = now(), updated_by = 'supersession'
      WHERE approval_request_id = $1`,
    [args.priorApprovalRequestId, args.reason, args.quoteLineageId, args.newApprovalRequestId],
  );

  /**
   * The reservation goes with it. A SUPERSEDED reservation stops counting toward exposure
   * immediately, which is what returns the budget to the successor rather than leaving 6.00 held
   * against work nobody is doing.
   */
  const { rows: rsvRows } = await tx.query<{ reservation_id: string; amount: string }>(
    `SELECT reservation_id, amount FROM untch_budget_reservations
      WHERE approval_request_id = $1 AND status = 'ACTIVE' FOR UPDATE`,
    [args.priorApprovalRequestId],
  );
  const reservation = rsvRows[0];
  if (reservation) {
    await tx.query(
      `UPDATE untch_budget_reservations
          SET status = 'SUPERSEDED', released_at = now(), release_reason = 'QUOTE_SUPERSEDED',
              superseded_by_reservation_id = NULL
        WHERE reservation_id = $1`,
      [reservation.reservation_id],
    );
  }

  /**
   * Every message about the old quote stops being actionable. The tokens they carried name the old
   * approvalDigest, so verification would refuse them anyway, but a live button that silently does
   * nothing is a worse experience than one that is gone.
   */
  const { rows: killed } = await tx.query<{ delivery_id: string }>(
    `UPDATE untch_approval_deliveries
        SET status = 'INVALIDATED', invalidated_at = now()
      WHERE approval_request_id = $1
        AND status NOT IN ('ACTED', 'INVALIDATED', 'EXPIRED', 'FAILED_TERMINAL')
      RETURNING delivery_id`,
    [args.priorApprovalRequestId],
  );

  /**
   * The links in those messages stop resolving.
   *
   * A delivery marked INVALIDATED is a row nothing renders from; an action reference is what a URL a
   * person is ALREADY HOLDING resolves through. Killing only the delivery would leave every Discord
   * message already sent still pressable, and `resolveActionRef` would then be relying on the digest
   * check alone to refuse — which it would, with DIGEST_MOVED, after a person had gone through an OAuth
   * round trip to be told no.
   *
   * `invalidation_reason` is stated so the refusal a person eventually sees can name supersession
   * rather than a generic dead link. It is the difference between "this was replaced by a new price"
   * and "something is broken".
   */
  const { rows: killedRefs } = await tx.query<{ action_reference_id: string }>(
    `UPDATE untch_approval_action_refs
        SET invalidated_at = now(), invalidation_reason = 'QUOTE_SUPERSEDED'
      WHERE approval_request_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL
      RETURNING action_reference_id`,
    [args.priorApprovalRequestId],
  );

  /**
   * The other half of the link. The forward edge was written with the state change above, so a timeline
   * can be walked from either end and neither direction can exist without the other.
   */
  await tx.query(
    `UPDATE untch_approval_requests
        SET supersedes_approval_request_id = $2,
            supersedes_reservation_id = $3,
            previous_quote_digest = $4,
            quote_lineage_id = $5
      WHERE approval_request_id = $1`,
    [
      args.newApprovalRequestId,
      args.priorApprovalRequestId,
      reservation?.reservation_id ?? null,
      String(prior.quote_digest ?? ""),
      args.quoteLineageId,
    ],
  );

  return {
    ok: true,
    quoteLineageId: args.quoteLineageId,
    supersededRequestId: args.priorApprovalRequestId,
    priorState: String(prior.state),
    supersededReservationId: reservation?.reservation_id ?? null,
    invalidatedDeliveries: killed.length,
    invalidatedActionRefs: killedRefs.length,
    releasedExposure: reservation ? normalizeAmount(reservation.amount) : null,
  };
}
