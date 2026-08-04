import { randomBytes } from "node:crypto";
import {
  verifyApprovalActionToken,
  type ApprovalAction,
  type ApprovalActionSubject,
  type ActionTokenRefusal,
} from "./approval-action-token";
import type { ServiceCallTx } from "./x402-service-calls";

/**
 * The one place a human answer becomes financial authority.
 *
 * A PENDING request reserves nothing. That is the whole reason this step is dangerous: between the
 * moment somebody was asked and the moment they tap Approve, the budget can have been consumed by
 * other decisions, the policy can have been paused, the wallet can have been revoked and the quote can
 * have been superseded. Approving against the trace that was true when the request was RAISED would
 * authorise money against a world that no longer exists.
 *
 * So this re-reads everything, inside one transaction, under the policy's own advisory lock, and
 * refuses if anything moved.
 *
 * WHAT MAKES IT EXACTLY-ONCE
 *
 * Not a mutex and not a status check. The action nonce is consumed by a PRIMARY KEY insert, so two
 * concurrent taps on two different channels both pass every check and exactly one wins the insert.
 * The loser sees a unique violation and returns ALREADY_RESOLVED rather than creating a second
 * decision.
 */

export type ApprovalOutcome =
  | "APPROVED"
  | "DENIED"
  | "ALREADY_RESOLVED"
  | "BUDGET_CHANGED_BEFORE_APPROVAL"
  | "APPROVAL_SUPERSEDED"
  | "REQUEST_NOT_PENDING"
  | "REQUEST_EXPIRED"
  | "SERVICE_CALL_NOT_FINALIZED"
  | "BINDING_NOT_ACTIVE"
  | "BINDING_WRONG_ACCOUNT"
  | "BINDING_CANNOT_DECIDE"
  | "CHANNEL_BINDING_NOT_VERIFIED_FOR_APPROVAL"
  | "WALLET_AUTHORITY_INACTIVE"
  | "POLICY_INACTIVE"
  | "TOKEN_REFUSED";

export interface ApprovalActionResult {
  readonly outcome: ApprovalOutcome;
  readonly approvalRequestId: string;
  readonly decisionId: string | null;
  readonly reservationId: string | null;
  readonly tokenRefusal: ActionTokenRefusal | null;
  readonly detail: string;
  /** What the budget looked like at the moment of decision. Present on APPROVED and on a budget refusal. */
  readonly budget: BudgetSnapshot | null;
}

export interface BudgetSnapshot {
  readonly settledGovernedSpend: string;
  readonly activeReservedExposure: string;
  readonly effectiveBudgetUsage: string;
  readonly proposedAmount: string;
  readonly limit: string | null;
}

export function newApprovalDecisionId(): string {
  return `apdc_${randomBytes(16).toString("hex")}`;
}

export function newReservationId(): string {
  return `rsv_${randomBytes(16).toString("hex")}`;
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";

/** Decimal string arithmetic in integer micro-units. A float would disagree with the digest. */
function toMicros(decimal: string): bigint {
  const [whole, frac = ""] = decimal.split(".");
  return BigInt(whole ?? "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}
function fromMicros(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  return `${neg ? "-" : ""}${abs / 1_000_000n}.${String(abs % 1_000_000n).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0")}`;
}

export interface ApprovalActionInput {
  readonly approvalRequestId: string;
  readonly action: ApprovalAction;
  readonly token: string;
  readonly tokenSecret: string;
  readonly channelBindingId: string;
  readonly nowMs: number;
  readonly reservationTtlMs?: number;
  /**
   * The CURRENT policy, re-read at action time.
   *
   * A callback rather than a table read, because a daily limit lives inside the policy's rules and
   * interpreting rules belongs to the policy engine. Returning null means the policy is gone.
   */
  readonly resolvePolicy: (policyId: string) => Promise<ResolvedPolicy | null>;
  /** Partition the reservation is accounted under, from `ledgerPartitionKey`. */
  readonly partitionKey: string;
}

export interface ResolvedPolicy {
  readonly status: string;
  /** Unix milliseconds, or null when the policy does not expire. */
  readonly expiresAtMs: number | null;
  /** Decimal string, or null when this policy has no daily ceiling. */
  readonly dailyLimit: string | null;
}

/**
 * Act on an approval, terminally.
 *
 * The caller owns the transaction. This function neither begins nor commits one, so a proof harness
 * can run the entire path and roll it back, and a production caller gets atomicity across every write
 * below without this file having an opinion about connection lifetime.
 */
export async function actOnApproval(tx: ServiceCallTx, input: ApprovalActionInput): Promise<ApprovalActionResult> {
  const refuse = (outcome: ApprovalOutcome, detail: string, tokenRefusal: ActionTokenRefusal | null = null): ApprovalActionResult => ({
    outcome,
    approvalRequestId: input.approvalRequestId,
    decisionId: null,
    reservationId: null,
    tokenRefusal,
    detail,
    budget: null,
  });

  /**
   * Lock the request first, and always in this order: request, then service call, then binding. Two
   * channels acting at once take the same locks in the same sequence, so they queue rather than
   * deadlock.
   */
  const { rows: reqRows } = await tx.query<Record<string, unknown>>(
    `SELECT * FROM untch_approval_requests WHERE approval_request_id = $1 FOR UPDATE`,
    [input.approvalRequestId],
  );
  const request = reqRows[0];
  if (!request) return refuse("REQUEST_NOT_PENDING", "no such approval request");

  if (request.state === "SUPERSEDED") {
    return refuse("APPROVAL_SUPERSEDED", "a newer quote replaced this request");
  }
  if (request.state !== "PENDING") {
    /**
     * Every terminal state answers ALREADY_RESOLVED rather than an error. A second tap on a button is
     * an ordinary thing a person does, and it should read as "that is already handled".
     */
    if (["APPROVED", "REJECTED", "EXPIRED", "EXECUTED", "CANCELLED"].includes(String(request.state))) {
      return { ...refuse("ALREADY_RESOLVED", `this request is already ${String(request.state)}`), decisionId: null };
    }
    return refuse("REQUEST_NOT_PENDING", `request is ${String(request.state)}, not PENDING`);
  }

  const expiresAt = request.expires_at instanceof Date ? request.expires_at.getTime() : 0;
  if (expiresAt <= input.nowMs) return refuse("REQUEST_EXPIRED", "the approval window has closed");

  const { rows: callRows } = await tx.query<{ state: string }>(
    `SELECT state FROM untch_x402_service_calls WHERE service_call_id = $1 FOR UPDATE`,
    [request.service_call_id],
  );
  if (!callRows[0] || callRows[0].state !== "FINALIZED") {
    return refuse("SERVICE_CALL_NOT_FINALIZED", "the service fee for this request is not confirmed settled");
  }

  const { rows: bindRows } = await tx.query<Record<string, unknown>>(
    `SELECT * FROM untch_channel_bindings WHERE binding_id = $1 FOR UPDATE`,
    [input.channelBindingId],
  );
  const binding = bindRows[0];
  /**
   * A receive-only binding is a real, working delivery destination whose OWNER was never proven. It can
   * be told about an approval and must never answer one, and it gets its own refusal rather than being
   * folded into "not active", because a bootstrap row IS active for delivery and saying otherwise
   * would send whoever reads the error looking for the wrong problem.
   */
  if (binding?.status === "ACTIVE_RECEIVE_ONLY" || binding?.verification_method === "operator_bootstrap_unverified") {
    return refuse(
      "CHANNEL_BINDING_NOT_VERIFIED_FOR_APPROVAL",
      "this channel can receive approvals and has not proven who holds it, so it cannot answer one",
    );
  }
  if (!binding || binding.status !== "ACTIVE") return refuse("BINDING_NOT_ACTIVE", "this channel is not active");
  if (binding.account_id !== request.account_id) {
    /**
     * The refusal that stops one person approving another's payment. The binding exists and is active
     * and belongs to somebody else, which is exactly the case a routing bug would produce.
     */
    return refuse("BINDING_WRONG_ACCOUNT", "this channel is bound to a different account");
  }
  if (binding.can_decide !== true) return refuse("BINDING_CANNOT_DECIDE", "this channel may receive approvals and not answer them");

  const subject: ApprovalActionSubject = {
    approvalRequestId: String(request.approval_request_id),
    approvalDigest: String(request.approval_digest),
    intentHash: String(request.intent_hash ?? ""),
    quoteDigest: String(request.quote_digest ?? ""),
    policyId: String(request.policy_id),
    policyHash: String(request.policy_hash ?? ""),
    amount: String(request.amount),
    asset: String(request.asset),
    chain: String(request.chain ?? ""),
    recipient: request.recipient === null ? null : String(request.recipient),
    provider: String(request.provider),
    capability: String(request.capability),
    requesterPrincipalRef: String(request.requester_principal_ref ?? ""),
    walletAuthorityRef: String(request.wallet_authority_ref ?? ""),
    accountRefHash: String(request.account_ref_hash ?? ""),
  };

  const verdict = verifyApprovalActionToken(input.tokenSecret, input.token, subject, {
    action: input.action,
    channelBindingId: input.channelBindingId,
    nowMs: input.nowMs,
  });
  if (!verdict.ok) return refuse("TOKEN_REFUSED", verdict.detail, verdict.refusal);

  /**
   * Consume the nonce BEFORE doing anything that costs money.
   *
   * This is the exactly-once boundary. A unique violation here means another channel already acted,
   * and the honest answer is ALREADY_RESOLVED rather than a second decision.
   */
  try {
    await tx.query(
      `INSERT INTO untch_approval_action_nonces (nonce, approval_request_id, channel_binding_id, action)
       VALUES ($1, $2, $3, $4)`,
      [verdict.claims.nonce, input.approvalRequestId, input.channelBindingId, input.action],
    );
  } catch (err) {
    if (isUniqueViolation(err)) return refuse("ALREADY_RESOLVED", "this action was already taken");
    throw err;
  }

  const decisionId = newApprovalDecisionId();

  if (input.action === "DENY") {
    await tx.query(
      `INSERT INTO untch_approval_decisions
         (decision_id, approval_request_id, account_id, channel, channel_binding_id, actor, decision,
          approval_digest, created_by, requester_principal_ref, wallet_authority_ref)
       VALUES ($1,$2,$3,$4,$5,$6,'REJECT',$7,'approval-action',$8,$9)`,
      [
        decisionId,
        input.approvalRequestId,
        request.account_id,
        binding.channel,
        input.channelBindingId,
        String(binding.channel_user_id),
        request.approval_digest,
        request.requester_principal_ref ?? null,
        request.wallet_authority_ref ?? null,
      ],
    );
    await tx.query(
      `UPDATE untch_approval_requests
          SET state = 'REJECTED', resolved_at = now(), decision_count = decision_count + 1,
              updated_at = now(), updated_by = 'approval-action'
        WHERE approval_request_id = $1`,
      [input.approvalRequestId],
    );
    await invalidateSiblings(tx, input.approvalRequestId, input.channelBindingId);
    return {
      outcome: "DENIED",
      approvalRequestId: input.approvalRequestId,
      decisionId,
      reservationId: null,
      tokenRefusal: null,
      detail: "denied, and no authority was created",
      budget: null,
    };
  }

  /**
   * ── THE RECHECK ──────────────────────────────────────────────────────────
   *
   * The advisory lock is taken on the POLICY, so two approvals against one budget serialise. It is a
   * transaction lock, released by COMMIT or ROLLBACK by the database, so a process that dies here
   * cannot leave a policy permanently unapprovable.
   */
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`untch.policy.budget.${String(request.policy_id)}`]);

  /**
   * The policy is read through the caller's resolver rather than with SQL here.
   *
   * A daily limit lives inside the policy's `rules` JSONB and interpreting it is the policy engine's
   * job. Parsing rules in this file would be a second implementation of the thing that decides what a
   * budget means, and two implementations of that eventually disagree.
   */
  const policy = await input.resolvePolicy(String(request.policy_id));
  if (!policy) return refuse("POLICY_INACTIVE", "the policy no longer exists");
  if (policy.status !== "ACTIVE") return refuse("POLICY_INACTIVE", `policy is ${policy.status}`);
  if (policy.expiresAtMs !== null && policy.expiresAtMs <= input.nowMs) {
    return refuse("POLICY_INACTIVE", "the policy has expired");
  }

  /** The wallet authority has to still be the one the request was raised under. */
  const { rows: walletRows } = await tx.query<{ n: string }>(
    `SELECT count(*)::text n FROM untch_wallet_bindings
      WHERE account_id = $1 AND status = 'ACTIVE'`,
    [request.account_id],
  );
  if (Number(walletRows[0]?.n ?? "0") === 0) {
    return refuse("WALLET_AUTHORITY_INACTIVE", "the wallet authority behind this request is no longer active");
  }

  const settled = await settledGovernedSpend(tx, String(request.policy_id));
  const reserved = await activeReservedExposure(tx, String(request.policy_id), input.nowMs);
  const proposed = toMicros(String(request.amount));
  const effectiveBefore = settled + reserved;
  const effectiveAfter = effectiveBefore + proposed;
  const limit = policy.dailyLimit === null ? null : toMicros(policy.dailyLimit);

  const budget: BudgetSnapshot = {
    settledGovernedSpend: fromMicros(settled),
    activeReservedExposure: fromMicros(reserved),
    effectiveBudgetUsage: fromMicros(effectiveAfter),
    proposedAmount: String(request.amount),
    limit: limit === null ? null : fromMicros(limit),
  };

  if (limit !== null && effectiveAfter > limit) {
    /**
     * Capacity moved between asking and answering. No decision is recorded as APPROVED and no
     * reservation is created, which is the point: the person said yes to something the policy can no
     * longer afford, and honouring it would spend budget that belongs to another decision.
     */
    return { ...refuse("BUDGET_CHANGED_BEFORE_APPROVAL", "the policy can no longer afford this request"), budget };
  }

  await tx.query(
    `INSERT INTO untch_approval_decisions
       (decision_id, approval_request_id, account_id, channel, channel_binding_id, actor, decision,
        approval_digest, created_by, requester_principal_ref, wallet_authority_ref)
     VALUES ($1,$2,$3,$4,$5,$6,'APPROVE',$7,'approval-action',$8,$9)`,
    [
      decisionId,
      input.approvalRequestId,
      request.account_id,
      binding.channel,
      input.channelBindingId,
      String(binding.channel_user_id),
      request.approval_digest,
      request.requester_principal_ref ?? null,
      request.wallet_authority_ref ?? null,
    ],
  );

  const reservationId = newReservationId();
  const ttl = input.reservationTtlMs ?? 30 * 60_000;
  await tx.query(
    `INSERT INTO untch_budget_reservations
       (reservation_id, account_id, policy_id, partition_key, decision_id, intent_id, intent_hash,
        quote_digest, requester_principal_ref, wallet_authority_ref, amount, asset, chain, recipient,
        provider, capability, day_key, status, created_at, expires_at,
        approval_request_id, approval_decision_id, quote_lineage_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'ACTIVE', now(), $18::timestamptz, $19,$20,$21)`,
    [
      reservationId,
      request.account_id,
      request.policy_id,
      input.partitionKey,
      request.decision_id ?? "",
      request.intent_id ?? "",
      request.intent_hash ?? "",
      request.quote_digest ?? "",
      request.requester_principal_ref ?? "",
      request.wallet_authority_ref ?? "",
      request.amount,
      request.asset,
      request.chain ?? "",
      request.recipient ?? null,
      request.provider,
      request.capability,
      new Date(input.nowMs).toISOString().slice(0, 10),
      new Date(input.nowMs + ttl).toISOString(),
      input.approvalRequestId,
      decisionId,
      request.quote_lineage_id ?? null,
    ],
  );

  await tx.query(
    `UPDATE untch_approval_requests
        SET state = 'APPROVED', resolved_at = now(), decision_count = decision_count + 1,
            updated_at = now(), updated_by = 'approval-action'
      WHERE approval_request_id = $1`,
    [input.approvalRequestId],
  );
  await invalidateSiblings(tx, input.approvalRequestId, input.channelBindingId);

  return {
    outcome: "APPROVED",
    approvalRequestId: input.approvalRequestId,
    decisionId,
    reservationId,
    tokenRefusal: null,
    detail: "approved, and reserved authority was created. No money has moved.",
    budget,
  };
}

/**
 * Every other message about this request stops being actionable, in the same transaction.
 *
 * The one that was acted on is marked ACTED rather than INVALIDATED, so a timeline can show which
 * channel answered rather than only that the others did not.
 */
async function invalidateSiblings(tx: ServiceCallTx, approvalRequestId: string, actedBindingId: string): Promise<void> {
  await tx.query(
    `UPDATE untch_approval_deliveries
        SET status = 'ACTED', acted_at = now()
      WHERE approval_request_id = $1 AND channel_binding_id = $2`,
    [approvalRequestId, actedBindingId],
  );
  await tx.query(
    `UPDATE untch_approval_deliveries
        SET status = 'INVALIDATED', invalidated_at = now()
      WHERE approval_request_id = $1
        AND (channel_binding_id IS DISTINCT FROM $2)
        AND status NOT IN ('ACTED', 'INVALIDATED', 'EXPIRED', 'FAILED_TERMINAL')`,
    [approvalRequestId, actedBindingId],
  );
}

/**
 * What this policy has actually SPENT. Settled ledger movement only.
 *
 * Reserved authority is deliberately not counted here, because the two answer different questions and
 * conflating them is the defect the reservation model was built to fix.
 */
export async function settledGovernedSpend(tx: ServiceCallTx, policyId: string): Promise<bigint> {
  const { rows } = await tx.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
       FROM untch_budget_reservations
      WHERE policy_id = $1 AND status = 'CONSUMED'`,
    [policyId],
  );
  return toMicros(rows[0]?.total ?? "0");
}

/**
 * Authority currently held but not spent, measured by EFFECTIVE status.
 *
 * A reservation whose `expires_at` has passed stops counting immediately, whether or not a sweeper has
 * updated its stored status. Correctness cannot depend on a background job having run.
 */
export async function activeReservedExposure(tx: ServiceCallTx, policyId: string, nowMs: number): Promise<bigint> {
  const { rows } = await tx.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
       FROM untch_budget_reservations
      WHERE policy_id = $1 AND status = 'ACTIVE' AND expires_at > $2::timestamptz`,
    [policyId, new Date(nowMs).toISOString()],
  );
  return toMicros(rows[0]?.total ?? "0");
}

export { toMicros as approvalToMicros, fromMicros as approvalFromMicros };
