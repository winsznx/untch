import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ServiceCallTx } from "./x402-service-calls";
import {
  APPROVAL_ACTION_TOKEN_VERSION,
  actionTokenFingerprint,
  mintApprovalActionToken,
  type ApprovalAction,
} from "./approval-action-token";

/**
 * The thing a Discord link actually carries.
 *
 * WHY NOT THE TOKEN
 *
 * A Discord message is a semi-public artifact. It gets copied, quoted, screenshotted, unfurled by
 * Discord's own link preview service and crawled. Put the action token in the URL and every one of
 * those becomes a bearer instrument for a financial decision — which is the opposite of what the token
 * is for, since it commits to the whole obligation precisely so that holding it means something.
 *
 * So the URL carries THIS: an opaque identifier that names a row, and names nothing else. The row says
 * which request, which binding and which action. The token is minted server-side, at the moment a
 * re-verified human presses the button, and never exists anywhere a link can reach.
 *
 * WHAT THE REFERENCE ALONE PROVES
 *
 * Nothing. It is not identity, not authority and not intent. Possession gets you as far as an OAuth
 * prompt, and the Discord subject that comes back has to match the exact ChannelBinding this reference
 * was minted for. That is the whole point: a leaked URL leads a stranger to a login screen that will
 * refuse them.
 */

export const APPROVAL_ACTION_REF_SCHEMA_VERSION = 1 as const;

export type ActionRefRefusal =
  | "NOT_FOUND"
  | "EXPIRED"
  | "ALREADY_CONSUMED"
  | "INVALIDATED"
  | "REQUEST_NOT_PENDING"
  | "DIGEST_MOVED"
  | "BINDING_NOT_ACTIVE"
  | "BINDING_CANNOT_DECIDE"
  | "SUBJECT_MISMATCH";

export interface ResolvedActionRef {
  readonly actionReferenceId: string;
  readonly approvalRequestId: string;
  readonly accountId: string;
  readonly accountRefHash: string;
  readonly channelBindingId: string;
  readonly channel: string;
  readonly action: ApprovalAction;
  readonly nonce: string;
  readonly approvalDigest: string;
  readonly expiresAt: string;
  /** The platform identity that must be presented to use this reference. Never surfaced publicly. */
  readonly channelUserId: string;
  /**
   * The binding's scopes, carried out so a caller can require one without a second query.
   *
   * `can_decide` and `policy-approval` are checked separately on purpose. The column is what the
   * binding is CONFIGURED to do; the scope is what the account granted it. A binding can have the
   * column set and the grant withdrawn, and the OAuth callback refuses on either.
   */
  readonly scopes: readonly string[];
}

export type ActionRefVerdict =
  | { readonly ok: true; readonly ref: ResolvedActionRef }
  | { readonly ok: false; readonly refusal: ActionRefRefusal; readonly detail: string };

export function newActionReferenceId(): string {
  /**
   * 32 bytes. It appears in a URL that will sit in a chat log, so it has to be unguessable rather than
   * merely unique — an identifier somebody could enumerate would turn every approval into a target.
   */
  return `aref_${randomBytes(32).toString("base64url")}`;
}

export function newActionRefNonce(): string {
  return `apn_${randomBytes(24).toString("hex")}`;
}

/** Constant-time, because this compares a value an attacker supplies against a stored one. */
function sameSubject(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Mint the two references a message needs, or return the live ones that already exist.
 *
 * Idempotent per (request, binding, action) through a partial unique index, so a retried delivery
 * reuses the same URLs rather than leaving two pressable messages pointing at one request.
 */
export async function ensureActionReferences(
  tx: ServiceCallTx,
  args: {
    readonly approvalRequestId: string;
    readonly accountId: string;
    readonly accountRefHash: string;
    readonly channelBindingId: string;
    readonly approvalDigest: string;
    readonly expiresAt: string;
    readonly by?: string;
  },
): Promise<Record<ApprovalAction, string>> {
  const out: Partial<Record<ApprovalAction, string>> = {};
  for (const action of ["APPROVE", "DENY"] as const) {
    const { rows: existing } = await tx.query<{ action_reference_id: string }>(
      `SELECT action_reference_id FROM untch_approval_action_refs
        WHERE approval_request_id = $1 AND channel_binding_id = $2 AND action = $3
          AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [args.approvalRequestId, args.channelBindingId, action],
    );
    if (existing[0]) {
      out[action] = existing[0].action_reference_id;
      continue;
    }
    const id = newActionReferenceId();
    await tx.query(
      `INSERT INTO untch_approval_action_refs
         (action_reference_id, approval_request_id, account_id, channel_binding_id, approval_digest,
          account_ref_hash, action, nonce, expires_at, schema_version, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11)`,
      [
        id,
        args.approvalRequestId,
        args.accountId,
        args.channelBindingId,
        args.approvalDigest,
        args.accountRefHash,
        action,
        newActionRefNonce(),
        args.expiresAt,
        APPROVAL_ACTION_REF_SCHEMA_VERSION,
        args.by ?? "approval-delivery",
      ],
    );
    out[action] = id;
  }
  return out as Record<ApprovalAction, string>;
}

/**
 * Resolve a reference for DISPLAY, having proven who is asking.
 *
 * Every check that could refuse the action is made here, before a confirmation page is rendered, so a
 * person is never shown a button that was always going to fail. It consumes nothing: a GET must be able
 * to run twice, or a page refresh would burn the reference.
 *
 * `presentedSubject` is the platform identity the OAuth round trip just proved. Passing null resolves
 * for a caller that has not authenticated yet, and every identity-dependent check is then skipped —
 * which is why the caller must never treat a null-subject resolution as permission to act.
 */
export async function resolveActionRef(
  tx: ServiceCallTx,
  actionReferenceId: string,
  presentedSubject: string | null,
  nowMs: number,
): Promise<ActionRefVerdict> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT r.*, b.status AS binding_status, b.can_decide, b.channel, b.channel_user_id, b.scopes,
            q.state AS request_state, q.approval_digest AS current_digest
       FROM untch_approval_action_refs r
       JOIN untch_channel_bindings b ON b.binding_id = r.channel_binding_id
       JOIN untch_approval_requests q ON q.approval_request_id = r.approval_request_id
      WHERE r.action_reference_id = $1`,
    [actionReferenceId],
  );
  const row = rows[0];
  if (!row) return { ok: false, refusal: "NOT_FOUND", detail: "no such action reference" };

  if (row.invalidated_at !== null) {
    return {
      ok: false,
      refusal: "INVALIDATED",
      detail: `this action is no longer valid: ${String(row.invalidation_reason ?? "it was superseded or resolved")}`,
    };
  }
  if (row.consumed_at !== null) {
    return { ok: false, refusal: "ALREADY_CONSUMED", detail: "this action has already been used" };
  }
  const expiresAt = row.expires_at instanceof Date ? row.expires_at.getTime() : 0;
  if (expiresAt <= nowMs) return { ok: false, refusal: "EXPIRED", detail: "this action link has expired" };

  if (row.request_state !== "PENDING") {
    return { ok: false, refusal: "REQUEST_NOT_PENDING", detail: `this request is ${String(row.request_state)}` };
  }
  /**
   * The subject moved. A requote writes a new request with a new digest, and a reference minted against
   * the old one must stop working even if nothing got around to invalidating it yet — the token would
   * refuse anyway, and a button that silently fails is worse than one that explains itself.
   */
  if (String(row.current_digest) !== String(row.approval_digest)) {
    return { ok: false, refusal: "DIGEST_MOVED", detail: "the payment this link described has changed" };
  }

  if (row.binding_status !== "ACTIVE") {
    return { ok: false, refusal: "BINDING_NOT_ACTIVE", detail: "this channel is no longer active" };
  }
  if (row.can_decide !== true) {
    return { ok: false, refusal: "BINDING_CANNOT_DECIDE", detail: "this channel may receive approvals and not answer them" };
  }

  if (presentedSubject !== null && !sameSubject(String(row.channel_user_id), presentedSubject)) {
    /**
     * The refusal that makes possession of the URL worthless. The link resolved, the request is live,
     * and the person who authenticated is not the person this channel belongs to.
     */
    return { ok: false, refusal: "SUBJECT_MISMATCH", detail: "this action belongs to a different account holder" };
  }

  return {
    ok: true,
    ref: {
      actionReferenceId: String(row.action_reference_id),
      approvalRequestId: String(row.approval_request_id),
      accountId: String(row.account_id),
      accountRefHash: String(row.account_ref_hash),
      channelBindingId: String(row.channel_binding_id),
      channel: String(row.channel),
      action: String(row.action) as ApprovalAction,
      nonce: String(row.nonce),
      approvalDigest: String(row.approval_digest),
      expiresAt: new Date(expiresAt).toISOString(),
      channelUserId: String(row.channel_user_id),
      scopes: Array.isArray(row.scopes) ? row.scopes.map((s) => String(s)) : [],
    },
  };
}

/**
 * Spend an OAuth state nonce, once.
 *
 * The INSERT is the check. A read-then-write would let two callbacks arriving together both find the
 * nonce unspent and both proceed, which is exactly the replay the nonce exists to stop — so the primary
 * key decides, and a duplicate is a refusal rather than a thrown error.
 *
 * Returns false when the nonce has already been spent. Every other failure still throws, because a
 * database that is refusing for some OTHER reason must not be read as "this was a replay".
 */
export async function consumeOAuthStateNonce(
  tx: ServiceCallTx,
  state: {
    readonly stateNonce: string;
    readonly purpose: string;
    readonly actionReferenceId: string;
    readonly channelBindingId: string;
    readonly action: ApprovalAction;
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly subject: string | null;
  },
): Promise<boolean> {
  const { rows } = await tx.query<{ state_nonce: string }>(
    `INSERT INTO untch_approval_oauth_states
       (state_nonce, purpose, action_reference_id, channel_binding_id, action, issued_at, expires_at, subject)
     VALUES ($1,$2,$3,$4,$5, to_timestamp($6/1000.0), to_timestamp($7/1000.0), $8)
     ON CONFLICT (state_nonce) DO NOTHING
     RETURNING state_nonce`,
    [
      state.stateNonce,
      state.purpose,
      state.actionReferenceId,
      state.channelBindingId,
      state.action,
      state.issuedAt,
      state.expiresAt,
      state.subject,
    ],
  );
  return rows.length === 1;
}

/**
 * Mint the token this reference stands for, at the moment of use.
 *
 * The claims are read from the REQUEST row rather than from the reference, so a token can only ever
 * describe what the database currently says. The reference contributes the nonce and the binding, which
 * is what makes the token single-use and channel-bound.
 */
export async function mintTokenForRef(
  tx: ServiceCallTx,
  secret: string,
  ref: ResolvedActionRef,
  nowMs: number,
  ttlMs: number,
): Promise<string | null> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT * FROM untch_approval_requests WHERE approval_request_id = $1`,
    [ref.approvalRequestId],
  );
  const r = rows[0];
  if (!r) return null;

  return mintApprovalActionToken(secret, {
    v: APPROVAL_ACTION_TOKEN_VERSION,
    approvalRequestId: String(r.approval_request_id),
    approvalDigest: String(r.approval_digest),
    intentHash: String(r.intent_hash ?? ""),
    quoteDigest: String(r.quote_digest ?? ""),
    policyId: String(r.policy_id),
    policyHash: String(r.policy_hash ?? ""),
    amount: String(r.amount),
    asset: String(r.asset),
    chain: String(r.chain ?? ""),
    recipient: r.recipient === null ? null : String(r.recipient),
    provider: String(r.provider),
    capability: String(r.capability),
    requesterPrincipalRef: String(r.requester_principal_ref ?? ""),
    walletAuthorityRef: String(r.wallet_authority_ref ?? ""),
    accountRefHash: String(r.account_ref_hash ?? ""),
    channelBindingId: ref.channelBindingId,
    action: ref.action,
    nonce: ref.nonce,
    issuedAt: nowMs,
    expiresAt: nowMs + ttlMs,
  });
}

/**
 * Burn the reference.
 *
 * Called in the SAME transaction as the terminal decision, so a decision that rolls back leaves the
 * reference usable and a decision that commits leaves it spent. The update is conditional on the row
 * still being unconsumed, so two concurrent presses cannot both claim it.
 */
export async function consumeActionRef(
  tx: ServiceCallTx,
  actionReferenceId: string,
  token: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ action_reference_id: string }>(
    `UPDATE untch_approval_action_refs
        SET consumed_at = now(), token_fingerprint = $2
      WHERE action_reference_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL
      RETURNING action_reference_id`,
    [actionReferenceId, actionTokenFingerprint(token)],
  );
  return rows.length === 1;
}

/**
 * Retire every reference for a request.
 *
 * Used by the terminal decision and by supersession. A link that outlived what it described is a button
 * that takes a person somewhere confusing, and the cost of retiring them is one UPDATE.
 */
export async function invalidateActionRefs(
  tx: ServiceCallTx,
  approvalRequestId: string,
  reason: string,
): Promise<number> {
  const { rows } = await tx.query<{ action_reference_id: string }>(
    `UPDATE untch_approval_action_refs
        SET invalidated_at = now(), invalidation_reason = $2
      WHERE approval_request_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL
      RETURNING action_reference_id`,
    [approvalRequestId, reason],
  );
  return rows.length;
}

/** A safe-to-log identifier for a reference. One-way, so a log line cannot be pressed. */
export function actionRefFingerprint(actionReferenceId: string): string {
  return createHash("sha256").update(actionReferenceId).digest("hex").slice(0, 16);
}
