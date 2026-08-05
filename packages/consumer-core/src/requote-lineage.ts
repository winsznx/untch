import type { ServiceCallTx } from "./x402-service-calls";
import type { RequoteLineageClaim } from "./x402-service-calls";

/**
 * What a caller has to prove before the server will treat a request as replacing another one.
 *
 * THE ASYMMETRY THAT MAKES THIS DIFFERENT FROM EVERY OTHER VALIDATION
 *
 * An ordinary refusal costs the caller a round trip. A wrongly-accepted requote costs somebody their
 * authority: the predecessor is retired, its reservation released and its buttons killed, and the
 * person who granted it is never asked. So the burden runs the other way round from the rest of the
 * API. A requote is REFUSED unless every one of the fields below matches, and the caller has to NAME
 * each of them rather than let the server find them.
 *
 * WHY NAMING MATTERS RATHER THAN FINDING
 *
 * The tempting shape is `requote: { quoteLineageId }` and let the server look up the newest open
 * request in that lineage. It reads well and it is wrong: the server's lookup would then BE the claim,
 * and a client working from a stale view — the ordinary case, since a requote happens precisely when
 * something changed — would silently replace a request it had never seen. Naming the predecessor, its
 * digest and its reservation means a client that is out of date gets a refusal instead of a surprise.
 *
 * WHAT MAY CHANGE, AND WHAT MAY NOT
 *
 * The amount. That is the entire point, and it is the only field on this list that is allowed to move.
 * Everything else is the commercial identity of the work, and a "requote" that changed the capability,
 * the recipient or the task would be a different purchase wearing the lineage of an approved one.
 *
 * WHAT THIS FUNCTION DELIBERATELY DOES NOT DO
 *
 * Supersede anything. It reads, it compares, it refuses. The predecessor is untouched when it returns,
 * because at the moment it runs the fee for the successor has been authorised and not confirmed, and
 * `docs/architecture/approval-settlement-boundary.md` is the reason that distinction is load-bearing.
 * Retirement belongs to `finalizeSettlement`, holding authoritative confirmation, and to nothing else.
 */

export type RequoteRefusal =
  | "REQUOTE_LINEAGE_NOT_FOUND"
  | "REQUOTE_PRIOR_REQUEST_MISMATCH"
  | "REQUOTE_ACCOUNT_MISMATCH"
  | "REQUOTE_REQUESTER_MISMATCH"
  | "REQUOTE_PROVIDER_MISMATCH"
  | "REQUOTE_CAPABILITY_MISMATCH"
  | "REQUOTE_ASSET_MISMATCH"
  | "REQUOTE_CHAIN_MISMATCH"
  | "REQUOTE_RECIPIENT_MISMATCH"
  | "REQUOTE_TASK_MISMATCH"
  | "REQUOTE_ACCEPTANCE_MISMATCH"
  | "REQUOTE_POLICY_MISMATCH"
  | "REQUOTE_PREVIOUS_QUOTE_MISMATCH"
  | "REQUOTE_RESERVATION_MISMATCH"
  | "REQUOTE_RESERVATION_ALREADY_CONSUMED"
  | "REQUOTE_QUOTE_UNCHANGED"
  | "REQUOTE_SUCCESSOR_ALREADY_EXISTS"
  | "REQUOTE_PRIOR_ALREADY_SUPERSEDED"
  | "REQUOTE_PRIOR_NOT_SUPERSEDABLE";

/** The commercial identity the successor must reproduce exactly. Amount is deliberately absent. */
export interface RequoteCommercialIdentity {
  readonly accountId: string;
  readonly requesterPrincipalRef: string;
  readonly provider: string;
  readonly capability: string;
  readonly asset: string;
  readonly chain: string;
  readonly recipient: string | null;
  readonly taskHash: string;
  readonly acceptanceHash: string;
  readonly policyId: string;
  /** The digest the NEW quote produced. Compared against the prior one to refuse an unchanged requote. */
  readonly newQuoteDigest: string;
}

export interface ValidatedRequote {
  readonly ok: true;
  readonly quoteLineageId: string;
  readonly priorApprovalRequestId: string;
  readonly priorState: string;
  readonly priorQuoteDigest: string;
  readonly priorAmount: string;
  readonly priorReservationId: string | null;
  /** The successor's position in the lineage. Hashed into its quote digest and its approval digest. */
  readonly quoteVersion: number;
}

export type RequoteVerdict =
  | ValidatedRequote
  | { readonly ok: false; readonly refusal: RequoteRefusal; readonly detail: string };

const refuse = (refusal: RequoteRefusal, detail: string): RequoteVerdict => ({ ok: false, refusal, detail });

/** Addresses are compared case-insensitively; a checksummed and a lowercase address are one address. */
const sameAddress = (a: string | null, b: string | null): boolean => {
  if (a === null || b === null) return a === b;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
};

/**
 * The states a live authority can be in, and therefore the states a requote may replace.
 *
 * PROVISIONAL — raised, unpaid, not yet answerable. Replacing it costs nobody anything.
 * PENDING     — answerable. Replacing it withdraws a question before it was answered.
 * APPROVED    — answered yes. Replacing it retires a hold the person consciously granted.
 *
 * Everything else is already finished. A REJECTED request has no authority to retire, an EXPIRED one
 * lapsed on its own terms, and a SUPERSEDED one was replaced already — and letting a second successor
 * claim it is how one lineage grows two live branches.
 */
const SUPERSEDABLE = new Set(["PROVISIONAL", "PENDING", "APPROVED"]);

/**
 * Read the predecessor, lock it, and answer whether this request may claim it.
 *
 * The lock is taken here rather than at finalization for a reason worth stating: this runs inside the
 * DECISION's transaction, so holding the predecessor from here to COMMIT is what makes "the prior
 * authority has not changed" true of the row the successor was validated against. A concurrent
 * `actOnApproval` on the predecessor queues behind it and then sees the state this function saw.
 *
 * It takes no locks it does not need. The reservation is read FOR SHARE rather than FOR UPDATE,
 * because this function never modifies it and an exclusive lock here would serialise requote
 * validation against every unrelated budget read on the same hold.
 */
export async function validateRequoteClaim(
  tx: ServiceCallTx,
  claim: RequoteLineageClaim,
  identity: RequoteCommercialIdentity,
): Promise<RequoteVerdict> {
  const { rows: priorRows } = await tx.query<Record<string, unknown>>(
    `SELECT * FROM untch_approval_requests
      WHERE approval_request_id = $1 FOR UPDATE`,
    [claim.supersedesApprovalRequestId],
  );
  const prior = priorRows[0];
  if (!prior) {
    return refuse(
      "REQUOTE_LINEAGE_NOT_FOUND",
      `no approval request ${claim.supersedesApprovalRequestId} exists to be superseded`,
    );
  }

  /**
   * The ACCOUNT CHECK COMES FIRST, and the two refusals below it are deliberately not distinguishable
   * by a stranger.
   *
   * Supersession releases budget and kills action tokens. Being able to aim it at another account's
   * request would be a way to cancel their approvals, and being able to probe which request ids exist
   * on other accounts would be the reconnaissance for it. So a cross-account claim gets the same
   * answer whether the lineage matches or not.
   */
  if (String(prior.account_id) !== identity.accountId) {
    return refuse("REQUOTE_ACCOUNT_MISMATCH", "the request named does not belong to this account");
  }

  if (String(prior.quote_lineage_id ?? "") !== claim.quoteLineageId) {
    return refuse(
      "REQUOTE_PRIOR_REQUEST_MISMATCH",
      `request ${claim.supersedesApprovalRequestId} is in lineage ` +
        `${String(prior.quote_lineage_id ?? "none")}, and the claim names ${claim.quoteLineageId}`,
    );
  }

  const priorState = String(prior.state);
  if (priorState === "SUPERSEDED") {
    return refuse(
      "REQUOTE_PRIOR_ALREADY_SUPERSEDED",
      `request ${claim.supersedesApprovalRequestId} was already replaced by ` +
        `${String(prior.superseded_by_approval_request_id ?? "another request")}`,
    );
  }
  if (!SUPERSEDABLE.has(priorState)) {
    return refuse(
      "REQUOTE_PRIOR_NOT_SUPERSEDABLE",
      `a ${priorState} request holds no live authority to retire`,
    );
  }

  const priorQuoteDigest = String(prior.quote_digest ?? "");
  if (priorQuoteDigest !== claim.previousQuoteDigest) {
    /**
     * The stale-client refusal. The caller is working from a view of this lineage that has moved, and
     * proceeding would replace a quote they have not seen.
     */
    return refuse(
      "REQUOTE_PREVIOUS_QUOTE_MISMATCH",
      "the previous quote digest named does not match the quote this request currently carries",
    );
  }

  if (priorQuoteDigest === identity.newQuoteDigest) {
    /**
     * Nothing changed. Allowing it would make a requote a way to mint a fresh request on the same terms
     * whenever the duplicate window, the cooldown or the rate limit was inconvenient — the protections
     * a requote is explicitly not relief from.
     */
    return refuse("REQUOTE_QUOTE_UNCHANGED", "this quote is identical to the one it claims to replace");
  }

  // ── The commercial identity. Only the amount may move. ────────────────────
  const mismatch = (
    field: string,
    was: string | null,
    now: string | null,
    refusal: RequoteRefusal,
  ): RequoteVerdict | null =>
    (was ?? "") === (now ?? "")
      ? null
      : refuse(refusal, `a requote may change the price and not the ${field}: was ${was ?? "none"}, now ${now ?? "none"}`);

  const checks: (RequoteVerdict | null)[] = [
    mismatch("requester", String(prior.requester_principal_ref ?? ""), identity.requesterPrincipalRef, "REQUOTE_REQUESTER_MISMATCH"),
    mismatch("provider", String(prior.provider ?? ""), identity.provider, "REQUOTE_PROVIDER_MISMATCH"),
    mismatch("capability", String(prior.capability ?? ""), identity.capability, "REQUOTE_CAPABILITY_MISMATCH"),
    mismatch("asset", String(prior.asset ?? ""), identity.asset, "REQUOTE_ASSET_MISMATCH"),
    mismatch("chain", String(prior.chain ?? ""), identity.chain, "REQUOTE_CHAIN_MISMATCH"),
    mismatch("task", String(prior.task_hash ?? ""), identity.taskHash, "REQUOTE_TASK_MISMATCH"),
    mismatch("acceptance criteria", String(prior.acceptance_hash ?? ""), identity.acceptanceHash, "REQUOTE_ACCEPTANCE_MISMATCH"),
    /**
     * The policy is part of the commercial identity because it is what the amount is measured against.
     * A requote that moved to a policy with a larger daily cap would be asking a different question.
     */
    mismatch("policy", String(prior.policy_id ?? ""), identity.policyId, "REQUOTE_POLICY_MISMATCH"),
  ];
  for (const c of checks) if (c) return c;

  const priorRecipient = prior.recipient === null ? null : String(prior.recipient);
  if (!sameAddress(priorRecipient, identity.recipient)) {
    return refuse(
      "REQUOTE_RECIPIENT_MISMATCH",
      `a requote may change the price and not the recipient: was ${priorRecipient ?? "none"}, ` +
        `now ${identity.recipient ?? "none"}`,
    );
  }

  // ── The predecessor's authority, named rather than found ──────────────────
  const { rows: rsvRows } = await tx.query<Record<string, unknown>>(
    `SELECT reservation_id, status FROM untch_budget_reservations
      WHERE approval_request_id = $1 ORDER BY created_at ASC`,
    [claim.supersedesApprovalRequestId],
  );
  const active = rsvRows.find((r) => String(r.status) === "ACTIVE");
  const activeId = active ? String(active.reservation_id) : null;

  if (claim.supersedesReservationId !== activeId) {
    if (claim.supersedesReservationId === null) {
      return refuse(
        "REQUOTE_RESERVATION_MISMATCH",
        `this request holds reservation ${activeId} and the claim names none`,
      );
    }
    const named = rsvRows.find((r) => String(r.reservation_id) === claim.supersedesReservationId);
    if (named) {
      /**
       * Named a real reservation on the right request, and it is no longer the live one. Distinct from
       * a wrong id because the caller is not confused about whose hold it is — they are working from a
       * moment that has passed, and the right answer names that rather than "not found".
       */
      return refuse(
        "REQUOTE_RESERVATION_ALREADY_CONSUMED",
        `reservation ${claim.supersedesReservationId} is ${String(named.status)} and no longer holds authority`,
      );
    }
    return refuse(
      "REQUOTE_RESERVATION_MISMATCH",
      activeId === null
        ? "this request holds no reservation, and the claim names one"
        : `this request holds reservation ${activeId}, and the claim names a different one`,
    );
  }

  /**
   * An APPROVED predecessor without a live hold has already had its authority consumed or released by
   * something else. Retiring it would be correct and pointless; what would be wrong is reporting a
   * released exposure the successor is about to inherit.
   */
  if (priorState === "APPROVED" && activeId === null) {
    return refuse(
      "REQUOTE_PRIOR_NOT_SUPERSEDABLE",
      "this request was approved and its authority is no longer held, so there is nothing to transfer",
    );
  }

  /**
   * ONE IN-FLIGHT SUCCESSOR PER LINEAGE.
   *
   * `untch_approval_one_provisional_per_lineage` enforces this at INSERT and is the real guarantee —
   * two concurrent requotes race there and one gets a unique violation. This read is what turns that
   * violation into a NAMED refusal for the ordinary sequential case, so a caller is told "somebody is
   * already requoting this" rather than shown a constraint name.
   */
  const { rows: openRows } = await tx.query<{ approval_request_id: string; state: string }>(
    `SELECT approval_request_id, state FROM untch_approval_requests
      WHERE quote_lineage_id = $1 AND state = 'PROVISIONAL'`,
    [claim.quoteLineageId],
  );
  const inFlight = openRows.find((r) => r.approval_request_id !== claim.supersedesApprovalRequestId);
  if (inFlight) {
    return refuse(
      "REQUOTE_SUCCESSOR_ALREADY_EXISTS",
      `lineage ${claim.quoteLineageId} already has an in-flight successor`,
    );
  }

  const priorVersion = Number(prior.quote_version ?? 1);
  return {
    ok: true,
    quoteLineageId: claim.quoteLineageId,
    priorApprovalRequestId: claim.supersedesApprovalRequestId,
    priorState,
    priorQuoteDigest,
    priorAmount: String(prior.amount),
    priorReservationId: activeId,
    quoteVersion: (Number.isFinite(priorVersion) ? priorVersion : 1) + 1,
  };
}
