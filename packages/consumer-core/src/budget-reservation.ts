/**
 * Authority reserved, consumed and released — kept separate from money spent.
 *
 * THE DISTINCTION THIS MODULE EXISTS TO HOLD
 *
 *   0.05 USDT0  the x402 fee paid to Untch for the preflight service. Real money. Untch revenue.
 *   4.00 USDT0  the governed amount the request asks PERMISSION to spend. No money. Not revenue,
 *               not provider principal, not settled spend, and no provider liability.
 *
 * The second number used to be added to a counter named `spentTodayByAgent`, which the ledger, the
 * reconcile report and the dashboard all read literally. An approved decision therefore appeared as a
 * completed payment at four layers.
 *
 * WHY NOT SIMPLY STOP COUNTING IT
 *
 * Because then two agents could each be approved against the same remaining budget: neither approval
 * would be visible to the other until money moved, and money may never move. Approved authority has
 * to be visible to the next decision without being called spend. That is a reservation.
 *
 * THE LIFECYCLE, WHICH IS THE PART A COUNTER CANNOT EXPRESS
 *
 *   ACTIVE      granted, executable, counts toward exposure
 *   CONSUMED    the exact authorised execution reached its financial commitment point
 *   RELEASED    expired, rejected, superseded, cancelled, or failed before money moved
 *   EXPIRED     the authorisation outlived its own deadline
 *   SUPERSEDED  a re-quote replaced it
 *
 * Only ACTIVE counts. Everything else is history, and history is never deleted.
 */

import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import type { DecisionStateTx } from "./decision-state";

export type ReservationStatus = "ACTIVE" | "CONSUMED" | "RELEASED" | "EXPIRED" | "SUPERSEDED";

/**
 * Why a hold stopped counting. A named reason rather than a boolean, because "the quote was
 * superseded" and "execution failed before money moved" are different facts a dispute needs to tell
 * apart, and both would otherwise read as `released: true`.
 */
export type ReleaseReason =
  | "AUTHORIZATION_EXPIRED"
  | "REQUEST_REJECTED"
  | "QUOTE_SUPERSEDED"
  | "USER_CANCELLED"
  | "EXECUTION_FAILED_BEFORE_PAYMENT"
  | "SERVICE_UNAVAILABLE"
  | "AUTHORITY_REVOKED"
  | "WALLET_BINDING_REVOKED"
  | "POLICY_INVALIDATED";

export interface BudgetReservation {
  readonly reservationId: string;
  /** Private. Never rendered in a public projection. */
  readonly accountId: string;
  readonly policyId: string;
  readonly partitionKey: string;
  readonly decisionId: string;
  readonly intentId: string;
  readonly intentHash: Hex;
  readonly quoteDigest: Hex;
  readonly requesterPrincipalRef: string;
  readonly walletAuthorityRef: Hex;
  readonly amount: string;
  readonly asset: string;
  readonly chain: string;
  readonly recipient: string | null;
  readonly provider: string;
  readonly capability: string;
  readonly dayKey: string;
  readonly status: ReservationStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly releasedAt: string | null;
  readonly releaseReason: ReleaseReason | null;
  readonly executionRef: string | null;
  readonly settlementRef: string | null;
}

export function newReservationId(): string {
  return `rsv_${randomBytes(16).toString("hex")}`;
}

export class ReservationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReservationError";
  }
}

export interface CreateReservationInput {
  readonly reservationId?: string;
  readonly accountId: string;
  readonly policyId: string;
  readonly partitionKey: string;
  readonly decisionId: string;
  readonly intentId: string;
  readonly intentHash: Hex;
  readonly quoteDigest: Hex;
  readonly requesterPrincipalRef: string;
  readonly walletAuthorityRef: Hex;
  readonly amount: string;
  readonly asset: string;
  readonly chain: string;
  readonly recipient: string | null;
  readonly provider: string;
  readonly capability: string;
  readonly dayKey: string;
  /** ISO-8601. A hold must not outlive the authorisation that granted it. */
  readonly expiresAt: string;
}

/**
 * Create the hold, in the caller's transaction.
 *
 * No `ON CONFLICT DO NOTHING`. A conflict means an ACTIVE hold already exists for this intent hash
 * under this partition — a retry, or two concurrent approvals of one intent — and the correct outcome
 * is a loud refusal rather than a second hold against the same budget for work authorised once.
 */
export async function createReservation(
  tx: DecisionStateTx,
  input: CreateReservationInput,
): Promise<string> {
  const reservationId = input.reservationId ?? newReservationId();
  try {
    await tx.query(
      `INSERT INTO untch_budget_reservations
         (reservation_id, account_id, policy_id, partition_key, decision_id, intent_id, intent_hash,
          quote_digest, requester_principal_ref, wallet_authority_ref, amount, asset, chain,
          recipient, provider, capability, day_key, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'ACTIVE',$18)`,
      [
        reservationId, input.accountId, input.policyId, input.partitionKey, input.decisionId,
        input.intentId, input.intentHash, input.quoteDigest, input.requesterPrincipalRef,
        input.walletAuthorityRef, input.amount, input.asset, input.chain, input.recipient,
        input.provider, input.capability, input.dayKey, input.expiresAt,
      ],
    );
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("untch_reservation_one_active_per_intent")) {
      throw new ReservationError(
        "RESERVATION_ALREADY_ACTIVE",
        `intent ${input.intentHash} already holds an ACTIVE reservation under ${input.partitionKey}. ` +
          "Work authorised once must not reserve budget twice.",
      );
    }
    throw err;
  }
  return reservationId;
}

/**
 * What the budget rule needs: settled money and still-executable authority, separately.
 *
 * A hold past `expires_at` is excluded here without being swept first. A sweeper that had not run yet
 * would otherwise keep shrinking a user's budget with authority nobody can still use — the read is the
 * authority on what counts, and the sweeper is only bookkeeping.
 */
export async function budgetExposure(
  tx: DecisionStateTx,
  partitionKey: string,
  dayKey: string,
  nowIso: string,
): Promise<{ readonly settledToday: number; readonly reservedActiveToday: number; readonly effectiveToday: number }> {
  const settled = (await tx.query(
    "SELECT coalesce(sum(amount),0)::text AS n FROM untch_settled_spend WHERE partition_key = $1 AND day_key = $2",
    [partitionKey, dayKey],
  )) as { rows: { n: string }[] };

  const reserved = (await tx.query(
    `SELECT coalesce(sum(amount),0)::text AS n
       FROM untch_budget_reservations
      WHERE partition_key = $1 AND day_key = $2 AND status = 'ACTIVE' AND expires_at > $3`,
    [partitionKey, dayKey, nowIso],
  )) as { rows: { n: string }[] };

  const settledToday = Number(settled.rows[0]?.n ?? 0);
  const reservedActiveToday = Number(reserved.rows[0]?.n ?? 0);
  return { settledToday, reservedActiveToday, effectiveToday: settledToday + reservedActiveToday };
}

/**
 * Consume the hold, at the financial commitment point and nowhere earlier.
 *
 * Guarded on `status = 'ACTIVE'` in the WHERE clause, so a retry that reaches here twice updates zero
 * rows the second time and is told so. That is what makes execution idempotent without an
 * in-process mutex: the database decides, and two replicas get the same answer.
 *
 * The full binding is in the WHERE clause rather than checked beforehand. Checking first and updating
 * after is two statements a concurrent writer can interleave; one statement cannot be interleaved.
 */
export async function consumeReservation(
  tx: DecisionStateTx,
  args: {
    readonly reservationId: string;
    readonly accountId: string;
    readonly intentHash: Hex;
    readonly quoteDigest: Hex;
    readonly requesterPrincipalRef: string;
    readonly policyId: string;
    readonly amount: string;
    readonly executionRef: string;
    readonly settlementRef: string | null;
    readonly nowIso: string;
  },
): Promise<{ readonly consumed: boolean; readonly reason: string | null }> {
  const { rows } = (await tx.query(
    `UPDATE untch_budget_reservations
        SET status = 'CONSUMED', consumed_at = $9, execution_ref = $7, settlement_ref = $8
      WHERE reservation_id = $1
        AND status = 'ACTIVE'
        AND account_id = $2
        AND intent_hash = $3
        AND quote_digest = $4
        AND requester_principal_ref = $5
        AND policy_id = $6
        AND amount = $10::numeric
        AND expires_at > $9
      RETURNING reservation_id`,
    [
      args.reservationId, args.accountId, args.intentHash, args.quoteDigest,
      args.requesterPrincipalRef, args.policyId, args.executionRef, args.settlementRef,
      args.nowIso, args.amount,
    ],
  )) as { rows: { reservation_id: string }[] };

  if (rows.length === 1) return { consumed: true, reason: null };

  // Nothing matched. Say WHICH fact failed, because "already consumed", "expired", "belongs to
  // another account" and "the amount does not match the authorisation" are four different problems
  // and a caller that cannot tell them apart will report the wrong one to a person.
  const { rows: found } = (await tx.query(
    `SELECT status, account_id, intent_hash, quote_digest, requester_principal_ref, policy_id,
            amount::text AS amount, expires_at::text AS expires_at
       FROM untch_budget_reservations WHERE reservation_id = $1`,
    [args.reservationId],
  )) as {
    rows: {
      status: string; account_id: string; intent_hash: string; quote_digest: string;
      requester_principal_ref: string; policy_id: string; amount: string; expires_at: string;
    }[];
  };
  const r = found[0];
  if (!r) return { consumed: false, reason: "RESERVATION_NOT_FOUND" };
  if (r.status !== "ACTIVE") return { consumed: false, reason: `RESERVATION_${r.status}` };
  if (r.account_id !== args.accountId) return { consumed: false, reason: "RESERVATION_BELONGS_TO_ANOTHER_ACCOUNT" };
  if (r.intent_hash.toLowerCase() !== args.intentHash.toLowerCase()) return { consumed: false, reason: "INTENT_MISMATCH" };
  if (r.quote_digest.toLowerCase() !== args.quoteDigest.toLowerCase()) return { consumed: false, reason: "QUOTE_MISMATCH" };
  if (r.requester_principal_ref !== args.requesterPrincipalRef) return { consumed: false, reason: "REQUESTER_MISMATCH" };
  if (r.policy_id !== args.policyId) return { consumed: false, reason: "POLICY_MISMATCH" };
  if (Number(r.amount) !== Number(args.amount)) return { consumed: false, reason: "AMOUNT_MISMATCH" };
  if (Date.parse(r.expires_at) <= Date.parse(args.nowIso)) return { consumed: false, reason: "RESERVATION_EXPIRED" };
  return { consumed: false, reason: "RESERVATION_NOT_CONSUMABLE" };
}

/** Record settled money, in the same transaction that consumes the hold it settles. */
export async function recordSettledSpend(
  tx: DecisionStateTx,
  partitionKey: string,
  dayKey: string,
  amount: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO untch_settled_spend (partition_key, day_key, amount)
     VALUES ($1,$2,$3)
     ON CONFLICT (partition_key, day_key)
       DO UPDATE SET amount = untch_settled_spend.amount + EXCLUDED.amount, updated_at = now()`,
    [partitionKey, dayKey, amount],
  );
}

/** Release a hold. Guarded on ACTIVE, so a released reservation cannot be released twice. */
export async function releaseReservation(
  tx: DecisionStateTx,
  args: {
    readonly reservationId: string;
    readonly reason: ReleaseReason;
    readonly status?: Extract<ReservationStatus, "RELEASED" | "EXPIRED" | "SUPERSEDED">;
    readonly nowIso: string;
  },
): Promise<boolean> {
  const status = args.status ?? "RELEASED";
  const { rows } = (await tx.query(
    `UPDATE untch_budget_reservations
        SET status = $2, released_at = $3, release_reason = $4
      WHERE reservation_id = $1 AND status = 'ACTIVE'
      RETURNING reservation_id`,
    [args.reservationId, status, args.nowIso, args.reason],
  )) as { rows: unknown[] };
  return rows.length === 1;
}

/**
 * Sweep holds past their own deadline.
 *
 * Bookkeeping, not enforcement: `budgetExposure` already excludes expired holds by date, so a sweeper
 * that never ran would not over-count anybody's budget. This keeps the status column honest for
 * anybody reading rows directly.
 */
export async function expireStaleReservations(tx: DecisionStateTx, nowIso: string): Promise<number> {
  const { rows } = (await tx.query(
    `UPDATE untch_budget_reservations
        SET status = 'EXPIRED', released_at = $1, release_reason = 'AUTHORIZATION_EXPIRED'
      WHERE status = 'ACTIVE' AND expires_at <= $1
      RETURNING reservation_id`,
    [nowIso],
  )) as { rows: unknown[] };
  return rows.length;
}

interface ReservationRow {
  reservation_id: string; account_id: string; policy_id: string; partition_key: string;
  decision_id: string; intent_id: string; intent_hash: string; quote_digest: string;
  requester_principal_ref: string; wallet_authority_ref: string; amount: string; asset: string;
  chain: string; recipient: string | null; provider: string; capability: string; day_key: string;
  status: ReservationStatus; created_at: string; expires_at: string; consumed_at: string | null;
  released_at: string | null; release_reason: ReleaseReason | null;
  execution_ref: string | null; settlement_ref: string | null;
}

function toReservation(r: ReservationRow): BudgetReservation {
  return {
    reservationId: r.reservation_id, accountId: r.account_id, policyId: r.policy_id,
    partitionKey: r.partition_key, decisionId: r.decision_id, intentId: r.intent_id,
    intentHash: r.intent_hash as Hex, quoteDigest: r.quote_digest as Hex,
    requesterPrincipalRef: r.requester_principal_ref, walletAuthorityRef: r.wallet_authority_ref as Hex,
    amount: r.amount, asset: r.asset, chain: r.chain, recipient: r.recipient, provider: r.provider,
    capability: r.capability, dayKey: r.day_key, status: r.status, createdAt: r.created_at,
    expiresAt: r.expires_at, consumedAt: r.consumed_at, releasedAt: r.released_at,
    releaseReason: r.release_reason, executionRef: r.execution_ref, settlementRef: r.settlement_ref,
  };
}

export async function getReservation(tx: DecisionStateTx, reservationId: string): Promise<BudgetReservation | null> {
  const { rows } = (await tx.query(
    `SELECT reservation_id, account_id, policy_id, partition_key, decision_id, intent_id, intent_hash,
            quote_digest, requester_principal_ref, wallet_authority_ref, amount::text AS amount, asset,
            chain, recipient, provider, capability, day_key, status, created_at::text AS created_at,
            expires_at::text AS expires_at, consumed_at::text AS consumed_at,
            released_at::text AS released_at, release_reason, execution_ref, settlement_ref
       FROM untch_budget_reservations WHERE reservation_id = $1`,
    [reservationId],
  )) as { rows: ReservationRow[] };
  return rows[0] ? toReservation(rows[0]) : null;
}

export async function reservationForIntent(
  tx: DecisionStateTx,
  partitionKey: string,
  intentHash: Hex,
): Promise<BudgetReservation | null> {
  const { rows } = (await tx.query(
    `SELECT reservation_id, account_id, policy_id, partition_key, decision_id, intent_id, intent_hash,
            quote_digest, requester_principal_ref, wallet_authority_ref, amount::text AS amount, asset,
            chain, recipient, provider, capability, day_key, status, created_at::text AS created_at,
            expires_at::text AS expires_at, consumed_at::text AS consumed_at,
            released_at::text AS released_at, release_reason, execution_ref, settlement_ref
       FROM untch_budget_reservations
      WHERE partition_key = $1 AND intent_hash = $2 AND status = 'ACTIVE'`,
    [partitionKey, intentHash],
  )) as { rows: ReservationRow[] };
  return rows[0] ? toReservation(rows[0]) : null;
}

/**
 * Whether a hold is still executable, computed rather than read off the status column.
 *
 * WHY THE STORED STATUS IS NOT THE ANSWER
 *
 * A hold past `expires_at` stops counting toward exposure immediately — `budgetExposure` filters on
 * the date, so correctness never waits for a sweeper. But the ROW still says `ACTIVE` until one runs.
 * Correct for the budget, misleading for everybody else: an API, the Explorer or a person reading
 * that row would conclude 4.00 of authority is still live when none is.
 *
 * So the stored status is preserved exactly — it is immutable history — and the derived answer is
 * published beside it. Nothing mutates a historical row to make a projection look tidier.
 */
export type EffectiveReservationStatus = ReservationStatus;

export interface ReservationEffectiveState {
  /** Exactly what the row says. Never rewritten to match the projection. */
  readonly storedStatus: ReservationStatus;
  /** What is true right now. `ACTIVE` only when stored ACTIVE and not past its own deadline. */
  readonly effectiveStatus: EffectiveReservationStatus;
  /** The single question the budget rule asks. True for exactly one case. */
  readonly countsTowardExposure: boolean;
  readonly expiresAt: string;
  /** Why it is terminal, when it is. Null while genuinely ACTIVE. */
  readonly terminalReason: string | null;
}

export function reservationEffectiveState(
  r: { readonly status: ReservationStatus; readonly expiresAt: string; readonly releaseReason?: ReleaseReason | null },
  nowIso: string,
): ReservationEffectiveState {
  if (r.status !== "ACTIVE") {
    return {
      storedStatus: r.status,
      effectiveStatus: r.status,
      countsTowardExposure: false,
      expiresAt: r.expiresAt,
      terminalReason: r.releaseReason ?? (r.status === "CONSUMED" ? "CONSUMED_AT_SETTLEMENT" : r.status),
    };
  }
  const expired = Date.parse(r.expiresAt) <= Date.parse(nowIso);
  return {
    storedStatus: "ACTIVE",
    effectiveStatus: expired ? "EXPIRED" : "ACTIVE",
    countsTowardExposure: !expired,
    expiresAt: r.expiresAt,
    // Named even though no sweeper has written it, because "why is this not counting" needs an answer
    // at the moment somebody asks, not at the moment a background job gets round to it.
    terminalReason: expired ? "AUTHORIZATION_EXPIRED" : null,
  };
}

/**
 * The public view of a hold.
 *
 * An ALLOW-LIST. `accountId` is absent by construction: a reservation is public evidence that
 * authority was granted, and the durable account identifier is not part of what that has to disclose.
 */
export function publicReservationProjection(r: BudgetReservation, nowIso = new Date().toISOString()): Record<string, unknown> {
  const eff = reservationEffectiveState(r, nowIso);
  return {
    ...eff,
    reservationId: r.reservationId,
    policyId: r.policyId,
    decisionId: r.decisionId,
    intentHash: r.intentHash,
    quoteDigest: r.quoteDigest,
    requesterPrincipalRef: r.requesterPrincipalRef,
    walletAuthorityRef: r.walletAuthorityRef,
    amount: r.amount,
    asset: r.asset,
    chain: r.chain,
    recipient: r.recipient,
    provider: r.provider,
    capability: r.capability,
    /**
     * `status` is kept as the STORED value for anyone already reading it, and is now accompanied by
     * `storedStatus`, `effectiveStatus` and `countsTowardExposure`. A reader who wants the truth about
     * executability reads `effectiveStatus`; a reader auditing the row reads `storedStatus`.
     */
    status: r.status,
    /**
     * The classification, carried on the record rather than left to a reader.
     *
     * Every surface that renders a reservation gets this string, so none of them has to decide for
     * itself what the amount means — which is how "approved" became "spent" four times over.
     */
    economicClassification:
      r.status === "CONSUMED"
        ? "SETTLED_GOVERNED_SPEND"
        : eff.countsTowardExposure
          ? "RESERVED_AUTHORITY_NOT_SPEND"
          : "AUTHORITY_NO_LONGER_EXECUTABLE",
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    consumedAt: r.consumedAt,
    releasedAt: r.releasedAt,
    releaseReason: r.releaseReason,
  };
}
