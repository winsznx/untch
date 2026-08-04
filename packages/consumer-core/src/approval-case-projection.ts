import type { ServiceCallTx } from "./x402-service-calls";

/**
 * One approval, end to end, safe to show.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is called APPROVAL_CASE_PROJECTION rather than anything with "Explorer" in the name, because
 * Explorer ingestion does not exist and naming it after a thing that has not been built is how a
 * roadmap turns into a claim. This is a read model: it joins the objects that already exist and says
 * what happened.
 *
 * WHY THE PROJECTION IS AN ALLOW-LIST
 *
 * Built by naming what goes in, never by removing what must not. A deny-list grows a leak the moment
 * somebody adds a column, and the column that leaks is always the one nobody thought about. The
 * private fields are read INTO this function and deliberately dropped on the way out, so the query can
 * stay legible while the output stays safe.
 *
 * Specifically absent, and each for a reason:
 *   • accountId          — the account is identified by accountRefHash, which is one-way
 *   • walletBindingId    — walletAuthorityRef commits to the authority state without naming the row
 *   • channelUserId      — a Telegram chat id or Discord user id is a real person's handle
 *   • any token          — action tokens, link tokens and bearers are redeemable
 *   • delivery payloads  — what was said to a person is between the service and that person
 */

export const APPROVAL_CASE_PROJECTION_VERSION = 1 as const;

export interface PublicApprovalCase {
  readonly projection: "APPROVAL_CASE_PROJECTION";
  readonly version: typeof APPROVAL_CASE_PROJECTION_VERSION;
  readonly approvalRequestId: string;
  readonly accountRefHash: string | null;
  readonly requesterPrincipalRef: string | null;
  readonly walletAuthorityRef: string | null;

  readonly serviceCall: {
    readonly serviceCallId: string | null;
    readonly state: string | null;
    /** The confirmed settlement, by transaction. No payer address, no authorization. */
    readonly settlementTransactionHash: string | null;
    readonly settlementState: string | null;
  };

  readonly policy: {
    readonly policyId: string;
    readonly policyHash: string | null;
    readonly policySnapshotHash: string | null;
  };

  readonly decisionId: string | null;
  readonly intentHash: string | null;
  readonly quoteDigest: string | null;

  readonly obligation: {
    readonly amount: string;
    readonly asset: string;
    readonly chain: string | null;
    readonly provider: string;
    readonly capability: string;
    readonly recipient: string | null;
  };

  readonly approval: {
    readonly state: string;
    readonly approvalDigest: string;
    readonly approvalDigestSchemaVersion: number | null;
    readonly activatedAt: string | null;
    readonly resolvedAt: string | null;
    readonly expiresAt: string | null;
    readonly decisionCount: number;
  };

  /** Channel NAMES only. Which platform was told, never which account on it. */
  readonly deliveries: readonly {
    readonly channel: string;
    readonly status: string;
    readonly attempts: number;
    readonly sentAt: string | null;
  }[];

  readonly terminalDecision: {
    readonly decisionId: string;
    readonly channel: string;
    readonly decision: string;
    readonly decidedAt: string | null;
  } | null;

  readonly reservation: {
    readonly reservationId: string;
    readonly storedStatus: string;
    readonly effectiveStatus: string;
    readonly countsTowardExposure: boolean;
    readonly amount: string;
    readonly expiresAt: string | null;
    readonly economicClassification: "RESERVED_AUTHORITY_NOT_SPEND";
  } | null;

  readonly lineage: {
    readonly quoteLineageId: string | null;
    readonly previousQuoteDigest: string | null;
    readonly supersedesApprovalRequestId: string | null;
    readonly supersededByApprovalRequestId: string | null;
    readonly supersededAt: string | null;
    readonly supersessionReason: string | null;
  };
}

/** Fields that must never appear in a public case, asserted by the tests rather than hoped for. */
export const NEVER_PUBLIC_CASE_FIELDS = [
  "accountId",
  "account_id",
  "walletBindingId",
  "channelUserId",
  "channel_user_id",
  "channelChatId",
  "actor",
  "token",
  "actionToken",
  "bearer",
  "botToken",
  "externalSubjectId",
] as const;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

/**
 * Derived, not stored.
 *
 * A reservation whose expiry has passed stops counting the moment it passes, whether or not a sweeper
 * has updated its row. Presenting the stored status alone would show ACTIVE authority that no longer
 * exists, so both are published and the derived one is the one that carries meaning.
 */
function effectiveReservationStatus(
  storedStatus: string,
  expiresAt: Date | null,
  nowMs: number,
): { effectiveStatus: string; countsTowardExposure: boolean } {
  if (storedStatus !== "ACTIVE") return { effectiveStatus: storedStatus, countsTowardExposure: false };
  const expired = expiresAt !== null && expiresAt.getTime() <= nowMs;
  return {
    effectiveStatus: expired ? "EXPIRED" : "ACTIVE",
    countsTowardExposure: !expired,
  };
}

export async function approvalCaseProjection(
  tx: ServiceCallTx,
  approvalRequestId: string,
  nowMs: number = Date.now(),
): Promise<PublicApprovalCase | null> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT r.*,
            c.state         AS call_state,
            a.transaction_hash AS settlement_tx,
            a.state         AS settlement_state
       FROM untch_approval_requests r
       LEFT JOIN untch_x402_service_calls c ON c.service_call_id = r.service_call_id
       LEFT JOIN untch_x402_payment_attempts a ON a.attempt_id = r.settled_attempt_id
      WHERE r.approval_request_id = $1`,
    [approvalRequestId],
  );
  const r = rows[0];
  if (!r) return null;

  const { rows: deliveries } = await tx.query<Record<string, unknown>>(
    `SELECT channel, status, attempts, sent_at FROM untch_approval_deliveries
      WHERE approval_request_id = $1 ORDER BY queued_at`,
    [approvalRequestId],
  );

  const { rows: decisions } = await tx.query<Record<string, unknown>>(
    `SELECT decision_id, channel, decision, decided_at FROM untch_approval_decisions
      WHERE approval_request_id = $1 ORDER BY decided_at LIMIT 1`,
    [approvalRequestId],
  );

  const { rows: reservations } = await tx.query<Record<string, unknown>>(
    `SELECT reservation_id, status, amount, expires_at FROM untch_budget_reservations
      WHERE approval_request_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [approvalRequestId],
  );

  const rsv = reservations[0];
  const rsvExpiry = rsv?.expires_at instanceof Date ? rsv.expires_at : null;

  return {
    projection: "APPROVAL_CASE_PROJECTION",
    version: APPROVAL_CASE_PROJECTION_VERSION,
    approvalRequestId: String(r.approval_request_id),
    accountRefHash: r.account_ref_hash === null ? null : String(r.account_ref_hash),
    requesterPrincipalRef: r.requester_principal_ref === null ? null : String(r.requester_principal_ref),
    walletAuthorityRef: r.wallet_authority_ref === null ? null : String(r.wallet_authority_ref),

    serviceCall: {
      serviceCallId: r.service_call_id === null ? null : String(r.service_call_id),
      state: r.call_state === null || r.call_state === undefined ? null : String(r.call_state),
      settlementTransactionHash: r.settlement_tx === null || r.settlement_tx === undefined ? null : String(r.settlement_tx),
      settlementState: r.settlement_state === null || r.settlement_state === undefined ? null : String(r.settlement_state),
    },

    policy: {
      policyId: String(r.policy_id),
      policyHash: r.policy_hash === null ? null : String(r.policy_hash),
      policySnapshotHash: r.policy_snapshot_hash === null ? null : String(r.policy_snapshot_hash),
    },

    decisionId: r.decision_id === null ? null : String(r.decision_id),
    intentHash: r.intent_hash === null ? null : String(r.intent_hash),
    quoteDigest: r.quote_digest === null ? null : String(r.quote_digest),

    obligation: {
      amount: String(r.amount),
      asset: String(r.asset),
      chain: r.chain === null ? null : String(r.chain),
      provider: String(r.provider),
      capability: String(r.capability),
      recipient: r.recipient === null ? null : String(r.recipient),
    },

    approval: {
      state: String(r.state),
      approvalDigest: String(r.approval_digest),
      approvalDigestSchemaVersion:
        r.approval_digest_schema_version === null ? null : Number(r.approval_digest_schema_version),
      activatedAt: iso(r.activated_at),
      resolvedAt: iso(r.resolved_at),
      expiresAt: iso(r.expires_at),
      decisionCount: Number(r.decision_count ?? 0),
    },

    deliveries: deliveries.map((d) => ({
      channel: String(d.channel),
      status: String(d.status),
      attempts: Number(d.attempts ?? 0),
      sentAt: iso(d.sent_at),
    })),

    terminalDecision: decisions[0]
      ? {
          decisionId: String(decisions[0].decision_id),
          channel: String(decisions[0].channel),
          decision: String(decisions[0].decision),
          decidedAt: iso(decisions[0].decided_at),
        }
      : null,

    reservation: rsv
      ? {
          reservationId: String(rsv.reservation_id),
          storedStatus: String(rsv.status),
          ...effectiveReservationStatus(String(rsv.status), rsvExpiry, nowMs),
          amount: String(rsv.amount),
          expiresAt: rsvExpiry === null ? null : rsvExpiry.toISOString(),
          economicClassification: "RESERVED_AUTHORITY_NOT_SPEND",
        }
      : null,

    lineage: {
      quoteLineageId: r.quote_lineage_id === null ? null : String(r.quote_lineage_id),
      previousQuoteDigest: r.previous_quote_digest === null ? null : String(r.previous_quote_digest),
      supersedesApprovalRequestId:
        r.supersedes_approval_request_id === null ? null : String(r.supersedes_approval_request_id),
      supersededByApprovalRequestId:
        r.superseded_by_approval_request_id === null ? null : String(r.superseded_by_approval_request_id),
      supersededAt: iso(r.superseded_at),
      supersessionReason: r.supersession_reason === null ? null : String(r.supersession_reason),
    },
  };
}
