import {
  APPROVAL_DIGEST_SCHEMA_VERSION,
  approvalDigest,
  newApprovalRequestId,
  newQuoteLineageId,
  requestFingerprint,
  type ApprovalSubject,
  type PgServiceCallStore,
  type RequoteLineageClaim,
  type ServiceCallTx,
} from "@untch/consumer-core";
import {
  authorizedTermsOf,
  type VerifiedPaymentAuthorizationContext,
} from "./payment-authorization";

/**
 * What an ESCALATED decision writes, inside the decision's own transaction.
 *
 * THE THREE OBJECTS, AND WHY THEY ARE CREATED TOGETHER
 *
 *   service call     — the request this fee buys, keyed on the identity a replay is matched against
 *   payment attempt  — the exact authorization presented, keyed on its nonce
 *   approval request — PROVISIONAL, meaning "raised and not yet actionable"
 *
 * All three or none. A service call without its attempt could not be reconciled, an attempt without its
 * request could not activate anything, and a request without either would be a promise to a human
 * bought by a payment nobody can name.
 *
 * WHY THE REQUEST IS PROVISIONAL AND NOT PENDING
 *
 * `docs/architecture/approval-settlement-boundary.md`: the handler's transaction commits BEFORE
 * `processSettlement` runs, and `processSettlement` reports a PENDING facilitator status as
 * `success: true`. So at the moment this code runs, nothing in the process knows whether the fee was
 * paid, and nothing it writes may be actionable. PROVISIONAL is that statement in the schema.
 *
 * Only `finalizeSettlement`, holding authoritative confirmation, moves it to PENDING. Nothing here can,
 * which is why this module has no path that writes PENDING, no outbox insert and no reservation.
 *
 * WHAT IT CANNOT REACH
 *
 * A facilitator, a signer, a channel or a provider. It is handed `VerifiedPaymentAuthorizationContext`,
 * which is inert data proven callable-free by `tsc`, and a transaction handle. There is nothing here
 * that could move money even if it decided to.
 */

export interface EscalatedApprovalInput {
  readonly route: string;
  readonly accountId: string;
  /**
   * The caller's key when they supplied one, and the intent hash when they did not.
   *
   * Never a fresh random value: the whole point of the identity is that a retry after a lost response
   * resolves to the SAME service call rather than buying a second one.
   */
  readonly idempotencyKey: string;
  readonly provider: string;
  readonly capability: string;
  readonly amount: string;
  readonly asset: string;
  readonly deadline: string;
  readonly chain: string;
  readonly recipient: string | null;

  readonly decisionId: string;
  readonly intentHash: string;
  readonly quoteDigest: string;
  readonly policySnapshotHash: string;
  readonly policyId: string;
  readonly policyHash: string;
  readonly policyVersion: number;
  readonly intentNonce: string;
  readonly taskHash: string;
  readonly acceptanceHash: string;

  readonly requesterPrincipalKind: string;
  readonly requesterPrincipalNamespace: string;
  readonly requesterPrincipalRef: string;
  readonly accountRefHash: string;
  readonly walletAuthorityRef: string;

  /** The engine's own word — `ESCALATED_THRESHOLD`, not the public `ESCALATED`. */
  readonly reason: string;
  /** ISO-8601. When the human's window to answer closes. */
  readonly approvalExpiresAt: string;
  /** Present only on a requote, and then it is the lineage the prior quote already carries. */
  readonly quoteLineageId?: string | undefined;
  /**
   * The predecessor this request replaces, ALREADY VALIDATED.
   *
   * This module does not check it. `validateRequoteClaim` runs first, in the same transaction, holding
   * the predecessor's row lock — and it is the thing entitled to say whether the claim is good. Passing
   * a validated verdict rather than a raw client claim is what stops this function growing a second,
   * weaker copy of those rules.
   *
   * Present here so the successor is WRITTEN with the claim bound into it, which is what lets the
   * finalizer discover the supersession from the row rather than being told about it by a caller that
   * may not exist any more.
   */
  readonly requote?: EscalatedRequoteBinding | undefined;
  readonly by?: string;
}

/** The validated claim, in the shape the row and the digest both need. */
export interface EscalatedRequoteBinding {
  readonly quoteLineageId: string;
  readonly quoteVersion: number;
  readonly previousQuoteDigest: string;
  readonly supersedesApprovalRequestId: string;
  readonly supersedesReservationId: string | null;
}

export interface EscalatedApprovalRecord {
  readonly serviceCallId: string;
  readonly paymentAttemptId: string;
  readonly approvalRequestId: string;
  readonly approvalDigest: string;
  readonly quoteLineageId: string;
  readonly quoteVersion: number;
  readonly authorizationNonce: string;
  readonly state: "PROVISIONAL";
  /**
   * What this request WILL retire, and has not.
   *
   * Named in the past tense nowhere: the predecessor is untouched at this point and stays untouched
   * until an authority confirms the fee. The field exists so the response can say which authority is
   * pending replacement without implying the replacement happened.
   */
  readonly supersedesOnSettlement: string | null;
}

/**
 * The identity a replay is matched on.
 *
 * Exported because the settled-replay resolver has to derive the SAME value from a bare request body
 * before the payment gate, and two derivations of one identity eventually disagree.
 */
export function escalatedRequestFingerprint(input: {
  readonly provider: string;
  readonly capability: string;
  readonly amount: string;
  readonly currency: string;
  readonly policyId: string | null;
  readonly deadline: string;
  /**
   * The requote claim, when there is one.
   *
   * In the identity because a requote IS a different request from the first quote it replaces, even
   * when a caller reuses their idempotency key — which is the ordinary case, since the key names the
   * logical piece of work and the requote is the same work at a new price. Without the lineage in here,
   * two quotes in one lineage at the same price would share an identity and the second would be
   * answered as a replay of the first.
   */
  readonly requote?: RequoteLineageClaim | null;
}): string {
  return requestFingerprint(input);
}

export class EscalatedApprovalRefused extends Error {
  constructor(
    message: string,
    readonly code:
      | "PAYMENT_AUTHORIZATION_ABSENT"
      | "SERVICE_CALL_NOT_CLAIMABLE"
      | "ATTEMPT_NONCE_REUSED",
  ) {
    super(message);
    this.name = "EscalatedApprovalRefused";
  }
}

/**
 * Write the three objects.
 *
 * `tx` is the DECISION's transaction, not a new one. That is what makes the whole escalated branch
 * atomic with the evidence, the replay marker and the decision-state window: a rollback removes the
 * approval request along with the decision that raised it, so the caller's request stays eligible.
 */
export async function persistEscalatedApproval(
  tx: ServiceCallTx,
  store: PgServiceCallStore,
  authorization: VerifiedPaymentAuthorizationContext | null,
  input: EscalatedApprovalInput,
): Promise<EscalatedApprovalRecord> {
  if (!authorization) {
    /**
     * No authorization means no payment can be named, and an approval request that cannot name the
     * payment that bought it can never be activated by the finalizer — it would sit PROVISIONAL
     * forever while a human waited. Refusing takes the transaction with it, so nothing is left behind.
     */
    throw new EscalatedApprovalRefused(
      "an escalated decision needs the payment authorization it was bought with, and none was presented",
      "PAYMENT_AUTHORIZATION_ABSENT",
    );
  }

  const fingerprint = escalatedRequestFingerprint({
    provider: input.provider,
    capability: input.capability,
    amount: input.amount,
    currency: input.asset,
    policyId: input.policyId,
    deadline: input.deadline,
    requote: input.requote
      ? {
          quoteLineageId: input.requote.quoteLineageId,
          previousQuoteDigest: input.requote.previousQuoteDigest,
          supersedesApprovalRequestId: input.requote.supersedesApprovalRequestId,
          supersedesReservationId: input.requote.supersedesReservationId,
        }
      : null,
  });

  const call = await store.upsertServiceCall(
    {
      accountId: input.accountId,
      route: input.route,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
    },
    {
      decisionId: input.decisionId,
      intentHash: input.intentHash,
      quoteDigest: input.quoteDigest,
      policyId: input.policyId,
      policyHash: input.policyHash,
      provider: input.provider,
      capability: input.capability,
      requesterPrincipalKind: input.requesterPrincipalKind,
      requesterPrincipalRef: input.requesterPrincipalRef,
      accountRefHash: input.accountRefHash,
      walletAuthorityRef: input.walletAuthorityRef,
    },
    tx,
  );

  /**
   * A call that is already FINALIZED must not grow a second attempt.
   *
   * The replay resolver in front of the payment gate is what normally prevents this, and it can only
   * answer for a request that carried an idempotency key it could parse. This is the same refusal one
   * layer down, where the identity is known for certain rather than derived from a raw body.
   */
  if (call.state === "FINALIZED" || call.state === "SETTLED" || call.state === "FINALIZATION_PENDING") {
    throw new EscalatedApprovalRefused(
      `service call ${call.serviceCallId} is ${call.state}: this request was already paid for, and a ` +
        "second attempt would take a second fee for one piece of work",
      "SERVICE_CALL_NOT_CLAIMABLE",
    );
  }

  /**
   * The attempt is keyed on the authorization nonce, which is the value the facilitator settles
   * against. Binding it here is what lets `finalizeSettlement` prove a settlement is for THIS payment
   * rather than for one that merely exists.
   */
  const terms = authorizedTermsOf(authorization);
  const attempt = await store.recordAttempt(
    call.serviceCallId,
    terms,
    { validAfter: authorization.validAfter, validBefore: authorization.validBefore },
    tx,
  );

  /**
   * The digest binds the settlement too.
   *
   * `serviceCallId` inside it is what stops an approval raised for one paid call satisfying another
   * call with identical terms — same obligation, same obligor, different purchase.
   */
  const subject: ApprovalSubject = {
    intentId: input.intentHash,
    quoteHash: input.quoteDigest,
    amount: input.amount,
    asset: input.asset,
    provider: input.provider,
    capability: input.capability,
    recipient: input.recipient,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    nonce: input.intentNonce,
    expiresAt: input.approvalExpiresAt,
    requester: {
      requesterPrincipalKind: input.requesterPrincipalKind,
      requesterPrincipalNamespace: input.requesterPrincipalNamespace,
      requesterPrincipalRef: input.requesterPrincipalRef,
      accountRefHash: input.accountRefHash,
      walletAuthorityRef: input.walletAuthorityRef,
      quoteDigest: input.quoteDigest,
    },
    v3: {
      serviceCallId: call.serviceCallId,
      decisionId: input.decisionId,
      intentHash: input.intentHash,
      policyHash: input.policyHash,
      policySnapshotHash: input.policySnapshotHash,
      chain: input.chain,
      taskHash: input.taskHash,
      acceptanceHash: input.acceptanceHash,
      requestExpiresAt: input.deadline,
    },
    /**
     * A requote's digest names what it replaces, so the person answering it is answering a question
     * that includes "and this retires the 6.00 you already said yes to". A digest that omitted it would
     * let the same yes be shown for two materially different asks.
     */
    ...(input.requote
      ? {
          requote: {
            quoteLineageId: input.requote.quoteLineageId,
            quoteVersion: input.requote.quoteVersion,
            previousQuoteDigest: input.requote.previousQuoteDigest,
            supersedesApprovalRequestId: input.requote.supersedesApprovalRequestId,
            supersedesReservationId: input.requote.supersedesReservationId,
          },
        }
      : {}),
  };
  const digest = approvalDigest(subject);

  const approvalRequestId = newApprovalRequestId();
  /**
   * A requote joins the lineage it named. A first quote mints one, so that the request it raises can be
   * requoted later without the caller having to have predicted that it would be.
   */
  const quoteLineageId = input.requote?.quoteLineageId ?? input.quoteLineageId ?? newQuoteLineageId();
  const quoteVersion = input.requote?.quoteVersion ?? 1;
  const by = input.by ?? "preflight-escalation";

  /**
   * Every field the action token will bind is written at INSERT.
   *
   * The immutability trigger refuses a later change to the approval digest, which is exactly right: a
   * request cannot have its subject rewritten after a human has been asked about it. Writing the whole
   * subject now is what makes that constraint satisfiable rather than an obstacle.
   */
  await tx.query(
    `INSERT INTO untch_approval_requests
       (approval_request_id, account_id, policy_id, policy_version, intent_id, quote_hash,
        provider, capability, amount, asset, reason, approval_digest, nonce, state, expires_at,
        created_by, updated_by, service_call_id, decision_id, approval_digest_schema_version,
        intent_hash, quote_digest, policy_hash, chain, recipient,
        requester_principal_kind, requester_principal_ref, wallet_authority_ref, account_ref_hash,
        quote_lineage_id, quote_version, task_hash, acceptance_hash,
        supersedes_approval_request_id, supersedes_reservation_id, previous_quote_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PROVISIONAL',$14::timestamptz,
             $15,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)`,
    [
      approvalRequestId,
      input.accountId,
      input.policyId,
      input.policyVersion,
      input.intentHash,
      input.quoteDigest,
      input.provider,
      input.capability,
      input.amount,
      input.asset,
      input.reason,
      digest,
      input.intentNonce,
      input.approvalExpiresAt,
      by,
      call.serviceCallId,
      input.decisionId,
      APPROVAL_DIGEST_SCHEMA_VERSION,
      input.intentHash,
      input.quoteDigest,
      input.policyHash,
      input.chain,
      input.recipient,
      input.requesterPrincipalKind,
      input.requesterPrincipalRef,
      input.walletAuthorityRef,
      input.accountRefHash,
      quoteLineageId,
      quoteVersion,
      /**
       * The task and the acceptance criteria, stored as columns as well as hashed into the digest.
       *
       * The digest answers "did everything match" and never "which field moved", so a requote that
       * quietly changed the work would be refused by a hash comparison with nothing to say about why.
       * These are what let that refusal name the field.
       */
      input.taskHash,
      input.acceptanceHash,
      /**
       * WRITTEN, AND ACTING ON NOTHING.
       *
       * These three columns are a CLAIM about the predecessor, not a change to it. The predecessor's
       * own row is untouched by this statement and stays untouched until `finalizeSettlement` holds
       * confirmation that the fee for this request actually settled.
       */
      input.requote?.supersedesApprovalRequestId ?? null,
      input.requote?.supersedesReservationId ?? null,
      input.requote?.previousQuoteDigest ?? null,
    ],
  );

  return {
    serviceCallId: call.serviceCallId,
    paymentAttemptId: attempt.attemptId,
    approvalRequestId,
    approvalDigest: digest,
    quoteLineageId,
    quoteVersion,
    authorizationNonce: authorization.authorizationNonce,
    state: "PROVISIONAL",
    supersedesOnSettlement: input.requote?.supersedesApprovalRequestId ?? null,
  };
}
