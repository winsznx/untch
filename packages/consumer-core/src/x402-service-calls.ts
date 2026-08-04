import { randomBytes, createHash } from "node:crypto";
import type { Pool } from "./db";

/**
 * A structural transaction handle, matching `DecisionStateTx` in `./decision-state`.
 *
 * Structural rather than pg's `PoolClient` for the reason that module gives: the caller owns the
 * transaction, and a function that takes one of these cannot open or close it. A test can pass a
 * recording double without standing up a driver.
 */
export interface ServiceCallTx {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: R[] }>;
}

/**
 * The payment half of an approval, and the finalizer that is the only thing allowed to make an
 * approval actionable.
 *
 * WHY THIS IS NOT PART OF THE HANDLER
 *
 * `docs/architecture/x402-settlement-lifecycle.md` established that the business handler's transaction
 * commits BEFORE `processSettlement` runs, and that a settlement failure afterwards discards the
 * handler's response while keeping everything it wrote. So a handler physically cannot know whether
 * the fee was paid. Anything it writes has to be non-actionable.
 *
 * `docs/architecture/approval-settlement-boundary.md` established the sharper constraint:
 *
 *     processSettlement returns success:true for BOTH "success" AND "pending".
 *
 * A pending settlement is accepted and unconfirmed. It produces real settlement headers and a 2xx
 * indistinguishable from a confirmed one. So the middleware's boolean, the header and the status are
 * all evidence of ACCEPTANCE and none of them is evidence of CONFIRMATION.
 *
 * Everything here follows from that. `finalizeSettlement` refuses any evidence that is not
 * authoritative, and the database refuses to record a SETTLED attempt with no transaction hash, so the
 * rule holds even if a future caller passes the wrong thing.
 */

export type ServiceCallState =
  | "EVALUATED"
  | "PAYMENT_AUTH_VERIFIED"
  | "SETTLEMENT_PENDING"
  | "SETTLED"
  | "SETTLEMENT_FAILED"
  | "FINALIZATION_PENDING"
  | "FINALIZED"
  | "CANCELLED";

export type PaymentAttemptState =
  | "VERIFIED"
  | "SETTLEMENT_PENDING"
  | "SETTLED"
  | "FAILED"
  | "SUPERSEDED"
  | "ABANDONED"
  | "UNKNOWN";

export interface ServiceCallIdentity {
  readonly accountId: string;
  readonly route: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface ServiceCallRow extends ServiceCallIdentity {
  readonly serviceCallId: string;
  readonly state: ServiceCallState;
  readonly decisionId: string | null;
  readonly intentHash: string | null;
  readonly quoteDigest: string | null;
  readonly policyId: string | null;
  readonly settledAt: string | null;
  readonly finalizedAt: string | null;
}

export interface PaymentAttemptRow {
  readonly attemptId: string;
  readonly serviceCallId: string;
  readonly authorizationNonce: string;
  readonly payer: string;
  readonly token: string;
  readonly amount: string;
  readonly payTo: string;
  readonly chain: string;
  readonly state: PaymentAttemptState;
  readonly transactionHash: string | null;
  readonly paymentId: string | null;
  readonly facilitatorStatus: string | null;
}

/**
 * The exact terms a settlement has to match.
 *
 * Carried as a value rather than re-read inside the finalizer, so the comparison is against what was
 * AUTHORIZED rather than against whatever the row happens to say by the time reconciliation runs.
 */
export interface AuthorizedTerms {
  readonly authorizationNonce: string;
  readonly payer: string;
  readonly token: string;
  readonly amount: string;
  readonly payTo: string;
  readonly chain: string;
}

/**
 * Settlement evidence the finalizer will accept.
 *
 * `source` is required and is not decoration. It records WHICH authority said so, because
 * "the facilitator confirmed it" and "the middleware returned true" are different claims and only one
 * of them may activate an approval.
 */
export type SettlementEvidence =
  | {
      readonly kind: "CONFIRMED";
      /** `facilitator_status` query, an on-chain transfer match, or another protocol authority. */
      readonly source: "facilitator_settle_status" | "onchain_transfer_match" | "facilitator_success";
      readonly transactionHash: string;
      readonly paymentId: string | null;
      readonly terms: AuthorizedTerms;
    }
  | { readonly kind: "PENDING"; readonly transactionHash: string | null; readonly paymentId: string | null }
  | { readonly kind: "FAILED"; readonly failureCode: string; readonly failureDetail: string | null }
  | { readonly kind: "UNKNOWN"; readonly detail: string };

export class SettlementEvidenceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "EVIDENCE_NOT_AUTHORITATIVE"
      | "TERMS_MISMATCH"
      | "ATTEMPT_NOT_FOUND"
      | "APPROVAL_NOT_PROVISIONAL"
      | "CONFLICTING_EVIDENCE",
  ) {
    super(message);
    this.name = "SettlementEvidenceError";
  }
}

export function newServiceCallId(): string {
  return `svc_${randomBytes(16).toString("hex")}`;
}

export function newPaymentAttemptId(): string {
  return `pay_${randomBytes(16).toString("hex")}`;
}

export function newApprovalOutboxEventId(): string {
  return `aoev_${randomBytes(16).toString("hex")}`;
}

/**
 * The server's own view of what was asked for.
 *
 * A client idempotency key is the CLIENT's namespace. Two different requests carrying one key must not
 * resolve to each other, so the identity a replay is matched on includes a fingerprint the server
 * derived from the terms rather than one the caller chose.
 *
 * Length-prefixed for the same reason the approval digest is: joining with a separator only moves the
 * collision to whichever field can contain the separator.
 */
export function requestFingerprint(parts: {
  readonly provider: string;
  readonly capability: string;
  readonly amount: string;
  readonly currency: string;
  readonly policyId: string | null;
  readonly deadline: string;
}): string {
  const field = (name: string, value: string | null): string => {
    const encoded = value === null ? " null" : value;
    return `${name}=${Buffer.byteLength(encoded, "utf8")}:${encoded}`;
  };
  const payload = [
    field("provider", parts.provider),
    field("capability", parts.capability),
    field("amount", parts.amount),
    field("currency", parts.currency),
    field("policy", parts.policyId),
    field("deadline", parts.deadline),
  ].join("|");
  return `rfp_${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/**
 * A digest over the authorized terms.
 *
 * The complete signed authorization is NEVER stored: it is a bearer instrument, and a database holding
 * one is a database that can spend it. This is what lets a later comparison prove the terms are the
 * same without keeping the thing that could move the money.
 */
export function authorizationDigest(terms: AuthorizedTerms): string {
  const field = (name: string, value: string): string =>
    `${name}=${Buffer.byteLength(value, "utf8")}:${value}`;
  const payload = [
    field("nonce", terms.authorizationNonce),
    field("payer", terms.payer.toLowerCase()),
    field("token", terms.token.toLowerCase()),
    field("amount", terms.amount),
    field("payTo", terms.payTo.toLowerCase()),
    field("chain", terms.chain),
  ].join("|");
  return `azd_${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

const sameAddress = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export class PgServiceCallStore {
  constructor(private readonly pool: Pool) {}

  async upsertServiceCall(
    id: ServiceCallIdentity,
    extra: {
      readonly serviceCallId?: string;
      readonly decisionId?: string | null;
      readonly intentHash?: string | null;
      readonly quoteDigest?: string | null;
      readonly policyId?: string | null;
      readonly policyHash?: string | null;
      readonly provider?: string | null;
      readonly capability?: string | null;
      readonly requesterPrincipalKind?: string | null;
      readonly requesterPrincipalRef?: string | null;
      readonly accountRefHash?: string | null;
      readonly walletAuthorityRef?: string | null;
    } = {},
    client?: ServiceCallTx,
  ): Promise<ServiceCallRow> {
    const q = client ?? this.pool;
    const serviceCallId = extra.serviceCallId ?? newServiceCallId();
    /**
     * ON CONFLICT DO UPDATE rather than DO NOTHING, because DO NOTHING returns no row and the caller
     * would have to issue a second read that a concurrent writer could interleave with. The update is
     * a no-op touch of `updated_at`, which is enough to make RETURNING give back the winner.
     */
    const { rows } = await q.query<Record<string, unknown>>(
      `INSERT INTO untch_x402_service_calls
         (service_call_id, account_id, route, idempotency_key, request_fingerprint,
          decision_id, intent_hash, quote_digest, policy_id, policy_hash, provider, capability,
          requester_principal_kind, requester_principal_ref, account_ref_hash, wallet_authority_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (account_id, route, idempotency_key, request_fingerprint)
         DO UPDATE SET updated_at = now()
       RETURNING *`,
      [
        serviceCallId,
        id.accountId,
        id.route,
        id.idempotencyKey,
        id.requestFingerprint,
        extra.decisionId ?? null,
        extra.intentHash ?? null,
        extra.quoteDigest ?? null,
        extra.policyId ?? null,
        extra.policyHash ?? null,
        extra.provider ?? null,
        extra.capability ?? null,
        extra.requesterPrincipalKind ?? null,
        extra.requesterPrincipalRef ?? null,
        extra.accountRefHash ?? null,
        extra.walletAuthorityRef ?? null,
      ],
    );
    return toServiceCall(rows[0]!);
  }

  async findByIdentity(id: ServiceCallIdentity, client?: ServiceCallTx): Promise<ServiceCallRow | null> {
    const q = client ?? this.pool;
    const { rows } = await q.query<Record<string, unknown>>(
      `SELECT * FROM untch_x402_service_calls
        WHERE account_id = $1 AND route = $2 AND idempotency_key = $3 AND request_fingerprint = $4`,
      [id.accountId, id.route, id.idempotencyKey, id.requestFingerprint],
    );
    return rows[0] ? toServiceCall(rows[0]) : null;
  }

  async recordAttempt(
    serviceCallId: string,
    terms: AuthorizedTerms,
    window: { readonly validAfter: string | null; readonly validBefore: string | null },
    client?: ServiceCallTx,
  ): Promise<PaymentAttemptRow> {
    const q = client ?? this.pool;
    const { rows } = await q.query<Record<string, unknown>>(
      `INSERT INTO untch_x402_payment_attempts
         (attempt_id, service_call_id, authorization_nonce, authorization_digest,
          payer, token, amount, pay_to, chain, valid_after, valid_before)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        newPaymentAttemptId(),
        serviceCallId,
        terms.authorizationNonce,
        authorizationDigest(terms),
        terms.payer,
        terms.token,
        terms.amount,
        terms.payTo,
        terms.chain,
        window.validAfter,
        window.validBefore,
      ],
    );
    await q.query(
      `UPDATE untch_x402_service_calls SET state = 'PAYMENT_AUTH_VERIFIED', updated_at = now()
        WHERE service_call_id = $1 AND state = 'EVALUATED'`,
      [serviceCallId],
    );
    return toAttempt(rows[0]!);
  }

  async attemptByNonce(nonce: string, client?: ServiceCallTx): Promise<PaymentAttemptRow | null> {
    const q = client ?? this.pool;
    const { rows } = await q.query<Record<string, unknown>>(
      `SELECT * FROM untch_x402_payment_attempts WHERE authorization_nonce = $1`,
      [nonce],
    );
    return rows[0] ? toAttempt(rows[0]) : null;
  }
}

export interface FinalizeResult {
  readonly outcome: "ACTIVATED" | "ALREADY_ACTIVE" | "PAYMENT_FAILED" | "LEFT_UNRESOLVED";
  readonly approvalRequestId: string | null;
  readonly outboxEventId: string | null;
  readonly serviceCallState: ServiceCallState;
}

/**
 * The ONLY path from PROVISIONAL to PENDING.
 *
 * Everything it does happens inside one transaction the caller supplies, so a caller that rolls back
 * gets no partial activation. The locks are taken in a fixed order — service call, then attempt, then
 * request — because two replicas reconciling the same call concurrently would otherwise be free to
 * take them in opposite orders and deadlock.
 *
 * Repeated calls with the same evidence return ALREADY_ACTIVE rather than doing the work again, and
 * that answer comes from reading the committed state rather than from a cache, so it survives a
 * restart between the two calls.
 */
export async function finalizeSettlement(
  client: ServiceCallTx,
  args: {
    readonly serviceCallId: string;
    readonly evidence: SettlementEvidence;
    readonly now?: () => string;
  },
): Promise<FinalizeResult> {
  const now = args.now ?? (() => new Date().toISOString());

  const { rows: callRows } = await client.query<Record<string, unknown>>(
    `SELECT * FROM untch_x402_service_calls WHERE service_call_id = $1 FOR UPDATE`,
    [args.serviceCallId],
  );
  const call = callRows[0];
  if (!call) throw new SettlementEvidenceError(`no service call ${args.serviceCallId}`, "ATTEMPT_NOT_FOUND");

  const { rows: reqRows } = await client.query<Record<string, unknown>>(
    `SELECT * FROM untch_approval_requests WHERE service_call_id = $1 FOR UPDATE`,
    [args.serviceCallId],
  );
  const request = reqRows[0];

  /**
   * Already done. Returned before any evidence check, because a second caller arriving with weaker
   * evidence must not be able to disturb a completed activation, and because this is the answer a
   * client retry after a lost response needs.
   */
  if (call.state === "FINALIZED") {
    const { rows: ev } = await client.query<{ event_id: string }>(
      `SELECT event_id FROM untch_approval_outbox WHERE approval_request_id = $1 AND name = 'approval.request.ready.v1'`,
      [request?.approval_request_id ?? ""],
    );
    return {
      outcome: "ALREADY_ACTIVE",
      approvalRequestId: (request?.approval_request_id as string) ?? null,
      outboxEventId: ev[0]?.event_id ?? null,
      serviceCallState: "FINALIZED",
    };
  }

  if (args.evidence.kind === "FAILED") {
    await client.query(
      `UPDATE untch_x402_payment_attempts
          SET state = 'FAILED', failure_code = $2, failure_detail = $3, updated_at = now(), reconciled_at = now()
        WHERE service_call_id = $1 AND state IN ('VERIFIED','SETTLEMENT_PENDING','UNKNOWN')`,
      [args.serviceCallId, args.evidence.failureCode, args.evidence.failureDetail],
    );
    await client.query(
      `UPDATE untch_x402_service_calls SET state = 'SETTLEMENT_FAILED', updated_at = now() WHERE service_call_id = $1`,
      [args.serviceCallId],
    );
    if (request) {
      await client.query(
        `UPDATE untch_approval_requests SET state = 'PAYMENT_FAILED', updated_at = now(), updated_by = 'finalizer'
          WHERE approval_request_id = $1 AND state = 'PROVISIONAL'`,
        [request.approval_request_id],
      );
    }
    return {
      outcome: "PAYMENT_FAILED",
      approvalRequestId: (request?.approval_request_id as string) ?? null,
      outboxEventId: null,
      serviceCallState: "SETTLEMENT_FAILED",
    };
  }

  /**
   * PENDING and UNKNOWN both leave the world exactly as they found it.
   *
   * A pending facilitator status is the case the whole design turns on: `processSettlement` would have
   * reported it as `success: true`, and treating it as confirmation is how an unpaid request becomes a
   * promise to a human. It is recorded so the reconciler knows to ask again, and nothing else.
   */
  if (args.evidence.kind === "PENDING" || args.evidence.kind === "UNKNOWN") {
    const state = args.evidence.kind === "PENDING" ? "SETTLEMENT_PENDING" : "UNKNOWN";
    await client.query(
      `UPDATE untch_x402_payment_attempts
          SET state = $2, transaction_hash = COALESCE($3, transaction_hash),
              payment_id = COALESCE($4, payment_id), updated_at = now()
        WHERE service_call_id = $1 AND state IN ('VERIFIED','SETTLEMENT_PENDING','UNKNOWN')`,
      [
        args.serviceCallId,
        state,
        args.evidence.kind === "PENDING" ? args.evidence.transactionHash : null,
        args.evidence.kind === "PENDING" ? args.evidence.paymentId : null,
      ],
    );
    await client.query(
      `UPDATE untch_x402_service_calls SET state = 'SETTLEMENT_PENDING', updated_at = now()
        WHERE service_call_id = $1 AND state NOT IN ('SETTLED','FINALIZATION_PENDING','FINALIZED')`,
      [args.serviceCallId],
    );
    return {
      outcome: "LEFT_UNRESOLVED",
      approvalRequestId: (request?.approval_request_id as string) ?? null,
      outboxEventId: null,
      serviceCallState: "SETTLEMENT_PENDING",
    };
  }

  const evidence = args.evidence;
  if (evidence.source === "facilitator_success" && !evidence.transactionHash) {
    throw new SettlementEvidenceError(
      "a facilitator success without a transaction hash is not authoritative: processSettlement reports pending as success too",
      "EVIDENCE_NOT_AUTHORITATIVE",
    );
  }

  const { rows: attemptRows } = await client.query<Record<string, unknown>>(
    `SELECT * FROM untch_x402_payment_attempts
      WHERE service_call_id = $1 AND authorization_nonce = $2 FOR UPDATE`,
    [args.serviceCallId, evidence.terms.authorizationNonce],
  );
  const attempt = attemptRows[0];
  if (!attempt) {
    throw new SettlementEvidenceError(
      `no payment attempt on ${args.serviceCallId} for nonce ${evidence.terms.authorizationNonce}`,
      "ATTEMPT_NOT_FOUND",
    );
  }

  /**
   * The settlement has to be for the payment we authorized, not merely for one that exists. Every
   * term is compared, because a settlement matching on nonce alone could still differ in amount or
   * recipient if evidence were assembled from the wrong source.
   */
  const mismatches: string[] = [];
  if (!sameAddress(String(attempt.payer), evidence.terms.payer)) mismatches.push("payer");
  if (!sameAddress(String(attempt.token), evidence.terms.token)) mismatches.push("token");
  if (String(attempt.amount) !== evidence.terms.amount) mismatches.push("amount");
  if (!sameAddress(String(attempt.pay_to), evidence.terms.payTo)) mismatches.push("payTo");
  if (String(attempt.chain) !== evidence.terms.chain) mismatches.push("chain");
  if (mismatches.length > 0) {
    throw new SettlementEvidenceError(
      `settlement evidence does not match the authorized terms: ${mismatches.join(", ")}`,
      "TERMS_MISMATCH",
    );
  }

  if (
    attempt.state === "SETTLED" &&
    attempt.transaction_hash !== null &&
    String(attempt.transaction_hash) !== evidence.transactionHash
  ) {
    throw new SettlementEvidenceError(
      `attempt ${attempt.attempt_id} is already settled by a different transaction`,
      "CONFLICTING_EVIDENCE",
    );
  }

  const stamp = now();
  await client.query(
    `UPDATE untch_x402_payment_attempts
        SET state = 'SETTLED', transaction_hash = $2, payment_id = COALESCE($3, payment_id),
            facilitator_status = $4, settled_at = COALESCE(settled_at, $5::timestamptz),
            reconciled_at = now(), updated_at = now()
      WHERE attempt_id = $1`,
    [attempt.attempt_id, evidence.transactionHash, evidence.paymentId, evidence.source, stamp],
  );
  await client.query(
    `UPDATE untch_x402_service_calls
        SET state = 'FINALIZATION_PENDING', settled_at = COALESCE(settled_at, $2::timestamptz), updated_at = now()
      WHERE service_call_id = $1`,
    [args.serviceCallId, stamp],
  );

  let outboxEventId: string | null = null;
  if (request) {
    if (request.state !== "PROVISIONAL") {
      throw new SettlementEvidenceError(
        `approval ${request.approval_request_id} is ${request.state}, not PROVISIONAL`,
        "APPROVAL_NOT_PROVISIONAL",
      );
    }
    await client.query(
      `UPDATE untch_approval_requests
          SET state = 'PENDING', settled_attempt_id = $2, activated_at = $3::timestamptz,
              updated_at = now(), updated_by = 'finalizer'
        WHERE approval_request_id = $1`,
      [request.approval_request_id, attempt.attempt_id, stamp],
    );
    outboxEventId = newApprovalOutboxEventId();
    /**
     * ON CONFLICT DO NOTHING against the one-ready-event index, so a concurrent finalizer that got
     * here first leaves exactly one event rather than one of the two transactions aborting. The
     * SELECT afterwards returns whichever event actually exists.
     */
    await client.query(
      `INSERT INTO untch_approval_outbox (event_id, approval_request_id, name, data)
       VALUES ($1, $2, 'approval.request.ready.v1', $3::jsonb)
       ON CONFLICT (approval_request_id, name) DO NOTHING`,
      [outboxEventId, request.approval_request_id, JSON.stringify(readyEventData(request, attempt, stamp))],
    );
    const { rows: ev } = await client.query<{ event_id: string }>(
      `SELECT event_id FROM untch_approval_outbox WHERE approval_request_id = $1 AND name = 'approval.request.ready.v1'`,
      [request.approval_request_id],
    );
    outboxEventId = ev[0]?.event_id ?? outboxEventId;
  }

  await client.query(
    `UPDATE untch_x402_service_calls SET state = 'FINALIZED', finalized_at = $2::timestamptz, updated_at = now()
      WHERE service_call_id = $1`,
    [args.serviceCallId, stamp],
  );

  return {
    outcome: "ACTIVATED",
    approvalRequestId: (request?.approval_request_id as string) ?? null,
    outboxEventId,
    serviceCallState: "FINALIZED",
  };
}

/**
 * The allow-listed event body.
 *
 * Built by naming what goes in rather than by removing what must not, because a projection that
 * subtracts fields grows a leak the moment somebody adds a column. There is no accountId here, no
 * wallet binding id, no token of any kind.
 */
function readyEventData(
  request: Record<string, unknown>,
  attempt: Record<string, unknown>,
  activatedAt: string,
): Record<string, unknown> {
  return {
    approvalRequestId: request.approval_request_id,
    accountRefHash: request.account_ref_hash ?? null,
    requesterPrincipalKind: request.requester_principal_kind ?? null,
    requesterPrincipalRef: request.requester_principal_ref ?? null,
    walletAuthorityRef: request.wallet_authority_ref ?? null,
    decisionId: request.decision_id ?? null,
    intentHash: request.intent_hash ?? null,
    quoteDigest: request.quote_digest ?? null,
    policyId: request.policy_id ?? null,
    provider: request.provider ?? null,
    capability: request.capability ?? null,
    amount: request.amount ?? null,
    asset: request.asset ?? null,
    chain: request.chain ?? null,
    recipient: request.recipient ?? null,
    approvalDigest: request.approval_digest,
    approvalDigestSchemaVersion: request.approval_digest_schema_version ?? null,
    approvalExpiresAt: request.expires_at instanceof Date ? request.expires_at.toISOString() : request.expires_at,
    settledTransactionHash: attempt.transaction_hash ?? null,
    activatedAt,
  };
}

function toServiceCall(r: Record<string, unknown>): ServiceCallRow {
  return {
    serviceCallId: String(r.service_call_id),
    accountId: String(r.account_id),
    route: String(r.route),
    idempotencyKey: String(r.idempotency_key),
    requestFingerprint: String(r.request_fingerprint),
    state: String(r.state) as ServiceCallState,
    decisionId: r.decision_id === null ? null : String(r.decision_id),
    intentHash: r.intent_hash === null ? null : String(r.intent_hash),
    quoteDigest: r.quote_digest === null ? null : String(r.quote_digest),
    policyId: r.policy_id === null ? null : String(r.policy_id),
    settledAt: r.settled_at instanceof Date ? r.settled_at.toISOString() : null,
    finalizedAt: r.finalized_at instanceof Date ? r.finalized_at.toISOString() : null,
  };
}

function toAttempt(r: Record<string, unknown>): PaymentAttemptRow {
  return {
    attemptId: String(r.attempt_id),
    serviceCallId: String(r.service_call_id),
    authorizationNonce: String(r.authorization_nonce),
    payer: String(r.payer),
    token: String(r.token),
    amount: String(r.amount),
    payTo: String(r.pay_to),
    chain: String(r.chain),
    state: String(r.state) as PaymentAttemptState,
    transactionHash: r.transaction_hash === null ? null : String(r.transaction_hash),
    paymentId: r.payment_id === null ? null : String(r.payment_id),
    facilitatorStatus: r.facilitator_status === null ? null : String(r.facilitator_status),
  };
}
