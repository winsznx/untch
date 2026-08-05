import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "./db";

/**
 * An approval that names the exact thing it approves.
 *
 * THE FAILURE THIS EXISTS TO CLOSE
 *
 * The escalation lifecycle already answers "did an authorised person say yes". It cannot answer "yes to
 * WHAT", because the thing it checks is a code — a code proves the responder held a secret, not that
 * they agreed to a particular payment. So this sequence is possible without the digest below:
 *
 *   1. an approval is raised for a 6.00 quote
 *   2. the quote is re-fetched and comes back 6.50 — a different obligation, the same intent
 *   3. the owner approves, holding a code that was never bound to either number
 *
 * The fix is not another check. It is making the approval BE a commitment to a value: every field that
 * changes what the money does goes into one digest, and a decision carries that digest or it is not a
 * decision. Re-quote and the digest changes; the old approval matches nothing.
 *
 * WHY A PLAIN "YES" CANNOT AUTHORISE ANYTHING
 *
 * `approval_digest` is NOT NULL on every decision row, and the value is computed server-side from the
 * request rather than accepted from the channel. An adapter that received the word "yes" has nothing to
 * put in that column; an adapter that wants to supply its own cannot, because the comparison is against
 * the server's own recomputation. The property holds by construction rather than by every future
 * channel author remembering it.
 */

export type ApprovalState = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "SUPERSEDED" | "EXECUTED";
export type DecisionKind = "APPROVE" | "REJECT";
export type DecisionChannel = "dashboard" | "telegram" | "discord" | "email" | "operator";
export type DeliveryOutcome = "SENT" | "SKIPPED" | "FAILED";

/**
 * WHO the approval is for, bound into the digest alongside WHAT it approves.
 *
 * THE FAILURE THIS CLOSES, WHICH THE AMOUNT CHECK DOES NOT
 *
 * Without this, two accounts asking for the same work at the same price under the same policy ruleset
 * produce the same digest. An approval one of them obtained matches the other's request exactly — the
 * digest doing its job perfectly and authorising the wrong payer. The 6.00/6.50 case is about the
 * obligation changing; this is about the obligor being someone else entirely.
 *
 * `walletAuthorityRef` is what makes revocation bite. It hashes the wallet's authority STATE
 * including the moment it was proven, so revoking and later reactivating a binding produces a
 * different value — an approval created under the old authority matches nothing afterwards, and
 * reactivation cannot revive it.
 *
 * `policyId` is separate from `policyHash` for the reason the whole V3 pass exists: the on-chain hash
 * commits the RULESET, and two policies sharing an owner and a ruleset are indistinguishable to the
 * contract. An approval raised under one must not satisfy a request under the other.
 */
export interface ApprovalRequester {
  readonly requesterPrincipalKind: string;
  readonly requesterPrincipalNamespace: string;
  readonly requesterPrincipalRef: string;
  readonly accountRefHash: string;
  readonly walletAuthorityRef: string;
  /** The V3 quote digest the decision was taken against. */
  readonly quoteDigest: string;
}

/** Everything the digest binds. Changing ANY of these produces a different approval. */
export interface ApprovalSubject {
  readonly intentId: string;
  readonly quoteHash: string;
  /** Decimal string. Never a float — the value is hashed, compared and shown to a person. */
  readonly amount: string;
  readonly asset: string;
  readonly provider: string;
  readonly capability: string;
  /** Null is legitimate: some capabilities have no deterministic recipient until execution. */
  readonly recipient: string | null;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly nonce: string;
  /** ISO-8601. An approval that outlived the quote it named would authorise a stale obligation. */
  readonly expiresAt: string;
  /**
   * Present on every V3 request; absent on approvals raised before V3 existed.
   *
   * Optional rather than required, and the digest below encodes the two cases as different VERSIONS
   * rather than treating an absent requester as an empty one. An approval already sitting PENDING in
   * production hashed exactly eleven fields, and re-deriving it over twelve would silently invalidate
   * a real person's pending decision — which is the "quietly rewrite the past" failure this pass is
   * about, arriving through the fix rather than the bug.
   */
  readonly requester?: ApprovalRequester | undefined;
  /**
   * The settlement-bound fields, present on every request raised through the paid account path.
   *
   * Separate from `requester` and encoded as its own VERSION for the same reason v2 was: approvals
   * already sitting PENDING were hashed over exactly what v1 or v2 covered, and re-deriving them over
   * more fields would hand a real person DIGEST_MISMATCH on a decision nothing about which changed.
   */
  readonly v3?: ApprovalSettlementBinding | undefined;
  /**
   * The predecessor this approval replaces, present only on a requote.
   *
   * Its own VERSION for the third time and for the third identical reason: a v3 approval sitting
   * PROVISIONAL was hashed over exactly the v3 field set, and widening that set — even with empty
   * strings — would hand the finalizer a digest mismatch on a request nothing about which had changed.
   *
   * It is in the digest because a requote is a claim about somebody else's authority. The digest is
   * what the human is shown and what the action token commits to, so "this yes retires that 6.00" has
   * to be part of what they are answering rather than a fact the server holds separately.
   */
  readonly requote?: ApprovalRequoteBinding | undefined;
}

/**
 * What a requote approval commits to beyond its own terms.
 *
 * `previousQuoteDigest` is here rather than only in the row because it is the anti-substitution field:
 * without it, a client holding a stale view of a lineage could aim a requote at a predecessor that has
 * already been replaced, and every other field would still match.
 */
export interface ApprovalRequoteBinding {
  readonly quoteLineageId: string;
  readonly quoteVersion: number;
  readonly previousQuoteDigest: string;
  readonly supersedesApprovalRequestId: string;
  readonly supersedesReservationId: string | null;
}

/**
 * What a V3 approval commits to beyond its terms and its requester.
 *
 * `serviceCallId` is here because an approval is bought by exactly one service call, and a digest that
 * did not name it would let an approval raised for one paid call satisfy a request from another that
 * happened to carry identical terms. That is the same class of failure the requester binding closed,
 * one level down: same obligation, same obligor, different purchase.
 *
 * `requestExpiresAt` is separate from the subject's `expiresAt`, which is when the APPROVAL window
 * closes. A request also ages out on its own terms, because the quote it names has a life independent
 * of how long a human is given to answer.
 */
export interface ApprovalSettlementBinding {
  readonly serviceCallId: string;
  readonly decisionId: string;
  readonly intentHash: string;
  readonly policyHash: string;
  readonly policySnapshotHash: string;
  readonly chain: string;
  readonly taskHash: string;
  readonly acceptanceHash: string;
  /** ISO-8601. When the request itself stops being a live obligation. */
  readonly requestExpiresAt: string;
}

/**
 * The version a NEW request is written under. Stored per row rather than assumed, so a later version
 * can be introduced without a migration that rewrites what earlier rows committed to.
 */
export const APPROVAL_DIGEST_SCHEMA_VERSION = 3 as const;

/**
 * The digest.
 *
 * LENGTH-PREFIXED, NOT CONCATENATED. `provider="a" capability="bc"` and `provider="ab" capability="c"`
 * are different approvals and must not collide; joining with a separator only moves the problem to
 * whichever field can contain the separator. Each field is written as its byte length, a colon, then
 * its bytes, so no arrangement of contents can produce another arrangement's encoding.
 *
 * NULL IS ENCODED, NOT OMITTED. A missing recipient and an empty-string recipient are different facts,
 * and a digest that dropped the field for one of them would let a request with no recipient be
 * satisfied by a decision about a request with an empty one.
 */
export function approvalDigest(subject: ApprovalSubject): string {
  const field = (name: string, value: string | number | null): string => {
    const encoded = value === null ? "\u0000null" : String(value);
    return `${name}=${Buffer.byteLength(encoded, "utf8")}:${encoded}`;
  };
  const requester = subject.requester;
  const payload = [
    /**
     * THE VERSION IS THE FIRST FIELD, AND IT IS WHY OLD APPROVALS SURVIVE.
     *
     * `v=1` is the exact twelve-field encoding that approvals already sitting PENDING in production
     * were hashed under, byte for byte. Widening it to always carry requester fields — even as empty
     * strings — would change every stored digest, so the next person to tap Approve on a decision
     * raised yesterday would get DIGEST_MISMATCH for a payment nothing about which had changed. That
     * is the "quietly rewrite the past" failure this whole pass is about, arriving through the fix.
     *
     * `v=2` binds the requester, and every V3 request produces one — so the requester-bound form is
     * what the live path uses and `v=1` covers only what was already written. The version being
     * INSIDE the hash is what stops a v1 digest being mistaken for a v2 digest over the same terms.
     */
    /**
     * `v=4` binds the predecessor a requote replaces. A requote is always also a V3 request, so the
     * v3 block below is still emitted and the v3 payload stays a strict prefix — the version field is
     * what stops a v3 digest and a v4 digest over the same terms being the same value.
     */
    field("v", subject.requote ? 4 : subject.v3 ? 3 : requester ? 2 : 1),
    field("intent", subject.intentId),
    field("quote", subject.quoteHash),
    field("amount", subject.amount),
    field("asset", subject.asset),
    field("provider", subject.provider),
    field("capability", subject.capability),
    field("recipient", subject.recipient),
    field("policy", subject.policyId),
    field("policyVersion", subject.policyVersion),
    field("nonce", subject.nonce),
    field("expires", subject.expiresAt),
    ...(requester
      ? [
          field("requesterKind", requester.requesterPrincipalKind),
          field("requesterNamespace", requester.requesterPrincipalNamespace),
          field("requesterRef", requester.requesterPrincipalRef),
          field("accountRef", requester.accountRefHash),
          field("walletAuthority", requester.walletAuthorityRef),
          field("quoteDigest", requester.quoteDigest),
        ]
      : []),
    /**
     * Appended AFTER the v2 fields rather than interleaved, so a v2 digest is a strict prefix of the
     * payload a v3 digest hashes. The version field at the front is what keeps them from colliding,
     * and the ordering keeps the encoding readable when a mismatch has to be debugged against a real
     * stored value.
     */
    ...(subject.v3
      ? [
          field("serviceCall", subject.v3.serviceCallId),
          field("decision", subject.v3.decisionId),
          field("intentHash", subject.v3.intentHash),
          field("policyHash", subject.v3.policyHash),
          field("policySnapshot", subject.v3.policySnapshotHash),
          field("chain", subject.v3.chain),
          field("taskHash", subject.v3.taskHash),
          field("acceptanceHash", subject.v3.acceptanceHash),
          field("requestExpires", subject.v3.requestExpiresAt),
        ]
      : []),
    /**
     * Appended after the v3 block for the same reason the v3 block follows the v2 one.
     *
     * `supersedesReservationId` is encoded as NULL rather than omitted when the predecessor holds no
     * hold. "There was no reservation" and "we did not look" are different claims, and only the first
     * is one this record is entitled to make.
     */
    ...(subject.requote
      ? [
          field("lineage", subject.requote.quoteLineageId),
          field("quoteVersion", subject.requote.quoteVersion),
          field("previousQuote", subject.requote.previousQuoteDigest),
          field("supersedes", subject.requote.supersedesApprovalRequestId),
          field("supersedesReservation", subject.requote.supersedesReservationId),
        ]
      : []),
  ].join("|");
  return `apd_${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/** Constant-time, and a refusal rather than a throw when a stored value is malformed. */
export function digestMatches(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function newApprovalRequestId(): string {
  return `aprq_${randomBytes(16).toString("hex")}`;
}

export function newDecisionId(): string {
  return `apdc_${randomBytes(16).toString("hex")}`;
}

export function newApprovalNonce(): string {
  return randomBytes(16).toString("hex");
}

export interface ApprovalRequest extends ApprovalSubject {
  readonly approvalRequestId: string;
  readonly accountId: string;
  /**
   * The paid service call that bought the right to ask, or null on a request raised before the paid
   * model existed.
   *
   * Exposed because it is what tells the two lifecycles apart, and telling them apart is a SAFETY
   * decision rather than a presentation one: a service-call-backed request may only be resolved
   * through `actOnApproval`, and the legacy decide route refuses one on sight. A caller that had to
   * infer this from the presence of some other field would eventually infer it wrong.
   */
  readonly serviceCallId: string | null;
  readonly quoteId: string | null;
  readonly reason: string;
  readonly triggeringRules: readonly unknown[];
  readonly approvalDigest: string;
  readonly state: ApprovalState;
  readonly requiredQuorum: number;
  readonly decisionCount: number;
  readonly supersededBy: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

export interface ApprovalDecision {
  readonly decisionId: string;
  readonly approvalRequestId: string;
  readonly accountId: string;
  readonly channel: DecisionChannel;
  readonly channelBindingId: string | null;
  readonly actor: string;
  readonly decision: DecisionKind;
  readonly approvalDigest: string;
  readonly correlationRef: string | null;
  readonly provenance: Record<string, unknown>;
  readonly decidedAt: string;
  /**
   * Who the answered request was for, copied from it at decision time.
   *
   * The `approvalDigest` above already binds these — a decision that matched a v2 digest matched a
   * requester too. These columns make that legible without recomputing a hash, and make "which
   * decisions were taken under the wallet authority that has since been revoked" a query rather than
   * an offline recomputation over every row.
   */
  readonly requesterPrincipalKind: string | null;
  readonly requesterPrincipalRef: string | null;
  readonly walletAuthorityRef: string | null;
}

export interface ApprovalDelivery {
  readonly deliveryId: string;
  readonly channel: string;
  readonly channelBindingId: string | null;
  readonly outcome: DeliveryOutcome;
  readonly detail: string | null;
  readonly attemptedAt: string;
}

export type DecideFailure =
  | "NOT_FOUND"
  | "NOT_PENDING"
  | "EXPIRED"
  | "DIGEST_MISMATCH"
  | "NOT_YOUR_APPROVAL"
  | "ALREADY_DECIDED"
  | "CHANNEL_CANNOT_DECIDE";

export type DecideOutcome =
  | { readonly ok: true; readonly request: ApprovalRequest; readonly decision: ApprovalDecision; readonly repeat: boolean }
  | { readonly ok: false; readonly reason: DecideFailure; readonly detail?: string };

export class ApprovalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

interface RequestRow {
  approval_request_id: string;
  service_call_id: string | null;
  account_id: string;
  policy_id: string;
  policy_version: number;
  intent_id: string;
  quote_id: string | null;
  quote_hash: string;
  provider: string;
  capability: string;
  amount: string;
  asset: string;
  recipient: string | null;
  reason: string;
  triggering_rules: unknown[];
  approval_digest: string;
  nonce: string;
  state: ApprovalState;
  required_quorum: number;
  decision_count: number;
  superseded_by: string | null;
  expires_at: Date;
  resolved_at: Date | null;
  created_at: Date;
  // Null on an approval raised before V3. Their v1 digests remain valid over exactly what they hashed.
  requester_principal_kind: string | null;
  requester_principal_namespace: string | null;
  requester_principal_ref: string | null;
  account_ref_hash: string | null;
  wallet_authority_ref: string | null;
  quote_digest: string | null;
}

function toRequester(row: {
  requester_principal_kind: string | null;
  requester_principal_namespace: string | null;
  requester_principal_ref: string | null;
  account_ref_hash: string | null;
  wallet_authority_ref: string | null;
  quote_digest: string | null;
}): ApprovalRequester | undefined {
  // All-or-nothing. A half-populated requester would produce a digest neither encoding recomputes,
  // which is a stored value nothing can ever match — worse than the absence it came from.
  if (
    row.requester_principal_kind === null ||
    row.requester_principal_namespace === null ||
    row.requester_principal_ref === null ||
    row.account_ref_hash === null ||
    row.wallet_authority_ref === null ||
    row.quote_digest === null
  ) {
    return undefined;
  }
  return {
    requesterPrincipalKind: row.requester_principal_kind,
    requesterPrincipalNamespace: row.requester_principal_namespace,
    requesterPrincipalRef: row.requester_principal_ref,
    accountRefHash: row.account_ref_hash,
    walletAuthorityRef: row.wallet_authority_ref,
    quoteDigest: row.quote_digest,
  };
}

function toRequest(row: RequestRow): ApprovalRequest {
  const requester = toRequester(row);
  return {
    ...(requester !== undefined ? { requester } : {}),
    approvalRequestId: row.approval_request_id,
    accountId: row.account_id,
    serviceCallId: row.service_call_id ?? null,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    intentId: row.intent_id,
    quoteId: row.quote_id,
    quoteHash: row.quote_hash,
    provider: row.provider,
    capability: row.capability,
    amount: row.amount,
    asset: row.asset,
    recipient: row.recipient,
    reason: row.reason,
    triggeringRules: row.triggering_rules ?? [],
    approvalDigest: row.approval_digest,
    nonce: row.nonce,
    state: row.state,
    requiredQuorum: row.required_quorum,
    decisionCount: row.decision_count,
    supersededBy: row.superseded_by,
    expiresAt: row.expires_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

interface DecisionRow {
  decision_id: string;
  approval_request_id: string;
  account_id: string;
  channel: DecisionChannel;
  channel_binding_id: string | null;
  actor: string;
  decision: DecisionKind;
  approval_digest: string;
  correlation_ref: string | null;
  provenance: Record<string, unknown>;
  decided_at: Date;
  requester_principal_kind: string | null;
  requester_principal_ref: string | null;
  wallet_authority_ref: string | null;
}

function toDecision(row: DecisionRow): ApprovalDecision {
  return {
    requesterPrincipalKind: row.requester_principal_kind ?? null,
    requesterPrincipalRef: row.requester_principal_ref ?? null,
    walletAuthorityRef: row.wallet_authority_ref ?? null,
    decisionId: row.decision_id,
    approvalRequestId: row.approval_request_id,
    accountId: row.account_id,
    channel: row.channel,
    channelBindingId: row.channel_binding_id,
    actor: row.actor,
    decision: row.decision,
    approvalDigest: row.approval_digest,
    correlationRef: row.correlation_ref,
    provenance: row.provenance ?? {},
    decidedAt: row.decided_at.toISOString(),
  };
}

export class PgApprovalStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Raise a request, superseding any open one for the same intent.
   *
   * The supersession is the re-quote path and it is deliberately not a caller decision. An intent whose
   * quote moved has TWO candidate obligations, and leaving both open would let one human approve 6.00
   * while another approves 6.50 for the same action — whichever wrote last winning. So the open request
   * is closed, told what replaced it, and the new one carries the new digest.
   */
  async raise(args: {
    readonly accountId: string;
    readonly subject: ApprovalSubject;
    readonly quoteId: string | null;
    readonly reason: string;
    readonly triggeringRules: readonly unknown[];
    readonly requiredQuorum?: number;
    readonly by: string;
  }): Promise<{ readonly request: ApprovalRequest; readonly superseded: string | null }> {
    const digest = approvalDigest(args.subject);
    const approvalRequestId = newApprovalRequestId();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // An identical digest that is already open is the SAME approval, not a new one. Raising a second
      // request for it would produce two rows a person could each answer, for one obligation.
      const { rows: open } = await client.query<RequestRow>(
        `SELECT * FROM untch_approval_requests
          WHERE intent_id = $1 AND state = 'PENDING' FOR UPDATE`,
        [args.subject.intentId],
      );
      const existing = open[0];
      if (existing && digestMatches(existing.approval_digest, digest)) {
        await client.query("COMMIT");
        return { request: toRequest(existing), superseded: null };
      }

      if (existing) {
        await client.query(
          `UPDATE untch_approval_requests
              SET state = 'SUPERSEDED', superseded_by = $2, resolved_at = now(),
                  updated_at = now(), updated_by = $3
            WHERE approval_request_id = $1`,
          [existing.approval_request_id, approvalRequestId, args.by],
        );
      }

      const r = args.subject.requester;
      const { rows } = await client.query<RequestRow>(
        `INSERT INTO untch_approval_requests
           (approval_request_id, account_id, policy_id, policy_version, intent_id, quote_id, quote_hash,
            provider, capability, amount, asset, recipient, reason, triggering_rules, approval_digest,
            nonce, required_quorum, expires_at, created_by, updated_by,
            requester_principal_kind, requester_principal_namespace, requester_principal_ref,
            account_ref_hash, wallet_authority_ref, quote_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,
                 $20,$21,$22,$23,$24,$25)
         RETURNING *`,
        [
          approvalRequestId,
          args.accountId,
          args.subject.policyId,
          args.subject.policyVersion,
          args.subject.intentId,
          args.quoteId,
          args.subject.quoteHash,
          args.subject.provider,
          args.subject.capability,
          args.subject.amount,
          args.subject.asset,
          args.subject.recipient,
          args.reason,
          JSON.stringify(args.triggeringRules),
          digest,
          args.subject.nonce,
          args.requiredQuorum ?? 1,
          args.subject.expiresAt,
          args.by,
          r?.requesterPrincipalKind ?? null,
          r?.requesterPrincipalNamespace ?? null,
          r?.requesterPrincipalRef ?? null,
          r?.accountRefHash ?? null,
          r?.walletAuthorityRef ?? null,
          r?.quoteDigest ?? null,
        ],
      );
      await client.query("COMMIT");
      return {
        request: toRequest(rows[0] as RequestRow),
        superseded: existing ? existing.approval_request_id : null,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async get(approvalRequestId: string): Promise<ApprovalRequest | null> {
    const { rows } = await this.pool.query<RequestRow>(
      "SELECT * FROM untch_approval_requests WHERE approval_request_id = $1",
      [approvalRequestId],
    );
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async listForAccount(
    accountId: string,
    filter: { readonly state?: ApprovalState; readonly limit?: number } = {},
  ): Promise<readonly ApprovalRequest[]> {
    const { rows } = await this.pool.query<RequestRow>(
      `SELECT * FROM untch_approval_requests
        WHERE account_id = $1 AND ($2::text IS NULL OR state = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [accountId, filter.state ?? null, Math.min(filter.limit ?? 50, 200)],
    );
    return rows.map(toRequest);
  }

  /**
   * Record a decision against a digest.
   *
   * `digest` is what the DECIDER is committing to, and it is compared against the server's stored value
   * rather than trusted. Every refusal below is a way an approval could otherwise be applied to
   * something other than what was shown:
   *
   *   • DIGEST_MISMATCH   — the quote moved between display and answer. This is the 6.00/6.50 case.
   *   • EXPIRED           — the approval outlived the quote it named.
   *   • NOT_PENDING       — already resolved, or superseded by a re-quote.
   *   • NOT_YOUR_APPROVAL — a decision arriving for another account's request.
   *
   * An IDENTICAL repeat is not an error. A user who double-taps, or a channel that redelivers, must not
   * see a failure for having agreed twice to the same thing — so a matching prior decision returns the
   * one already recorded, and the unique index is what makes that check race-free.
   */
  async decide(args: {
    readonly approvalRequestId: string;
    readonly accountId: string;
    readonly digest: string;
    readonly decision: DecisionKind;
    readonly channel: DecisionChannel;
    readonly channelBindingId: string | null;
    readonly actor: string;
    readonly correlationRef: string | null;
    readonly provenance?: Record<string, unknown>;
    readonly nowMs: number;
    readonly by: string;
  }): Promise<DecideOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<RequestRow>(
        "SELECT * FROM untch_approval_requests WHERE approval_request_id = $1 FOR UPDATE",
        [args.approvalRequestId],
      );
      const row = rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "NOT_FOUND" };
      }
      if (row.account_id !== args.accountId) {
        await client.query("ROLLBACK");
        // Same answer a stranger gets for a nonexistent id. Distinguishing them tells an attacker
        // which opaque ids are real.
        return { ok: false, reason: "NOT_FOUND" };
      }

      const priorMatch = await client.query<DecisionRow>(
        `SELECT * FROM untch_approval_decisions
          WHERE approval_request_id = $1 AND channel = $2 AND actor = $3`,
        [args.approvalRequestId, args.channel, args.actor],
      );
      const prior = priorMatch.rows[0];
      if (prior) {
        await client.query("ROLLBACK");
        if (prior.decision === args.decision && digestMatches(prior.approval_digest, args.digest)) {
          const current = await this.get(args.approvalRequestId);
          return { ok: true, request: current as ApprovalRequest, decision: toDecision(prior), repeat: true };
        }
        return {
          ok: false,
          reason: "ALREADY_DECIDED",
          detail: `this actor already answered ${prior.decision} on ${prior.decided_at.toISOString()}; a ` +
            "conflicting second answer is refused rather than silently overwriting the first",
        };
      }

      if (row.state !== "PENDING") {
        await client.query("ROLLBACK");
        return {
          ok: false,
          reason: "NOT_PENDING",
          detail:
            row.state === "SUPERSEDED"
              ? `that approval was superseded by ${row.superseded_by} — the quote changed, so the ` +
                "amount you were shown is no longer the amount that would be paid"
              : `that approval is ${row.state}`,
        };
      }
      if (row.expires_at.getTime() <= args.nowMs) {
        await client.query(
          `UPDATE untch_approval_requests SET state = 'EXPIRED', resolved_at = now(),
                  updated_at = now(), updated_by = $2
            WHERE approval_request_id = $1 AND state = 'PENDING'`,
          [args.approvalRequestId, args.by],
        );
        await client.query("COMMIT");
        return { ok: false, reason: "EXPIRED" };
      }
      if (!digestMatches(row.approval_digest, args.digest)) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          reason: "DIGEST_MISMATCH",
          detail:
            "the approval you are answering does not describe the payment this request now names. " +
            "Re-open it and check the amount, recipient and quote before approving.",
        };
      }

      const decisionId = newDecisionId();
      const { rows: decisionRows } = await client.query<DecisionRow>(
        `INSERT INTO untch_approval_decisions
           (decision_id, approval_request_id, account_id, channel, channel_binding_id, actor, decision,
            approval_digest, correlation_ref, provenance, created_by,
            requester_principal_kind, requester_principal_ref, wallet_authority_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          decisionId,
          args.approvalRequestId,
          args.accountId,
          args.channel,
          args.channelBindingId,
          args.actor,
          args.decision,
          args.digest,
          args.correlationRef,
          JSON.stringify(args.provenance ?? {}),
          args.by,
          // Copied from the REQUEST, never taken from the caller. A channel able to supply its own
          // requester could name a payer the approval was never raised for.
          row.requester_principal_kind,
          row.requester_principal_ref,
          row.wallet_authority_ref,
        ],
      );

      const nextCount = row.decision_count + 1;
      // REJECT is terminal on the first vote regardless of quorum. A quorum exists to require more
      // agreement before money moves, never to require more agreement before it stops.
      const resolved =
        args.decision === "REJECT" ? "REJECTED" : nextCount >= row.required_quorum ? "APPROVED" : "PENDING";

      const { rows: updated } = await client.query<RequestRow>(
        `UPDATE untch_approval_requests
            SET decision_count = $2,
                state = $3,
                resolved_at = CASE WHEN $3 = 'PENDING' THEN NULL ELSE now() END,
                updated_at = now(), updated_by = $4
          WHERE approval_request_id = $1
          RETURNING *`,
        [args.approvalRequestId, nextCount, resolved, args.by],
      );
      await client.query("COMMIT");
      return {
        ok: true,
        request: toRequest(updated[0] as RequestRow),
        decision: toDecision(decisionRows[0] as DecisionRow),
        repeat: false,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async decisionsFor(approvalRequestId: string): Promise<readonly ApprovalDecision[]> {
    const { rows } = await this.pool.query<DecisionRow>(
      "SELECT * FROM untch_approval_decisions WHERE approval_request_id = $1 ORDER BY decided_at",
      [approvalRequestId],
    );
    return rows.map(toDecision);
  }

  /**
   * Record that a channel was, or was not, told.
   *
   * A SKIPPED delivery is as important as a SENT one. An approval that expired unanswered because a
   * channel's credential was unrotated is a different failure from one the owner saw and ignored, and a
   * timeline that cannot tell them apart will blame the wrong party.
   */
  async recordDelivery(args: {
    readonly approvalRequestId: string;
    readonly channel: string;
    readonly channelBindingId: string | null;
    readonly outcome: DeliveryOutcome;
    readonly detail: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO untch_approval_deliveries
         (delivery_id, approval_request_id, channel, channel_binding_id, outcome, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        `apdl_${randomBytes(12).toString("hex")}`,
        args.approvalRequestId,
        args.channel,
        args.channelBindingId,
        args.outcome,
        args.detail,
      ],
    );
  }

  async deliveriesFor(approvalRequestId: string): Promise<readonly ApprovalDelivery[]> {
    const { rows } = await this.pool.query<{
      delivery_id: string;
      channel: string;
      channel_binding_id: string | null;
      outcome: DeliveryOutcome;
      detail: string | null;
      attempted_at: Date;
    }>("SELECT * FROM untch_approval_deliveries WHERE approval_request_id = $1 ORDER BY attempted_at", [
      approvalRequestId,
    ]);
    return rows.map((r) => ({
      deliveryId: r.delivery_id,
      channel: r.channel,
      channelBindingId: r.channel_binding_id,
      outcome: r.outcome,
      detail: r.detail,
      attemptedAt: r.attempted_at.toISOString(),
    }));
  }

  /** Sweep. An unanswered approval must not stay answerable forever with the quote long gone. */
  async expire(nowMs: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE untch_approval_requests
          SET state = 'EXPIRED', resolved_at = now(), updated_at = now(), updated_by = 'sweeper'
        WHERE state = 'PENDING' AND expires_at <= $1`,
      [new Date(nowMs).toISOString()],
    );
    return rowCount ?? 0;
  }

  /**
   * Move an APPROVED request to EXECUTED.
   *
   * Separate from approval, and it can only be called by whatever actually ran the action. While
   * providers are disabled nothing calls it, which is exactly why the approval centre reports
   * APPROVED_AWAITING_EXECUTION rather than implying a payment occurred.
   */
  async markExecuted(args: { readonly approvalRequestId: string; readonly by: string }): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE untch_approval_requests
          SET state = 'EXECUTED', updated_at = now(), updated_by = $2
        WHERE approval_request_id = $1 AND state = 'APPROVED'`,
      [args.approvalRequestId, args.by],
    );
    return (rowCount ?? 0) === 1;
  }
}

/**
 * What the UI should say about a state, given whether execution is even possible right now.
 *
 * The distinction the product depends on: APPROVED with providers disabled is NOT "paid". Saying so is
 * the difference between an honest demo and a claim that a purchase happened.
 */
export function describeApprovalState(
  state: ApprovalState,
  executionEnabled: boolean,
): { readonly code: string; readonly label: string } {
  switch (state) {
    case "APPROVED":
      return executionEnabled
        ? { code: "APPROVED", label: "Approved — execution queued." }
        : {
            code: "APPROVED_AWAITING_EXECUTION",
            label: "Approved. Nothing has been paid: provider execution is disabled on this deployment.",
          };
    case "EXECUTED":
      return { code: "EXECUTED", label: "Executed." };
    case "REJECTED":
      return { code: "REJECTED", label: "Rejected. Nothing was paid." };
    case "EXPIRED":
      return { code: "EXPIRED", label: "Expired unanswered. Nothing was paid." };
    case "SUPERSEDED":
      return {
        code: "SUPERSEDED",
        label: "Replaced by a newer request — the quote changed, so this one no longer describes the payment.",
      };
    default:
      return { code: "PENDING", label: "Waiting for your decision." };
  }
}
