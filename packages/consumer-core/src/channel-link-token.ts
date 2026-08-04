import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ServiceCallTx } from "./x402-service-calls";

/**
 * The token that lets a person prove a Telegram or Discord identity is theirs.
 *
 * WHAT IT IS FOR, AND WHAT IT IS NOT FOR
 *
 * It carries an account across a boundary Untch does not control. The human opens a link, the platform
 * authenticates them, and the platform tells us who they are. The token's only job is to make that
 * callback attributable to one account, one channel and one scope — so a callback cannot be replayed
 * onto a different account, and a link requested for `notify` cannot come back holding approval
 * authority.
 *
 * It is NOT proof of anything by itself. A generated token is a question. Only the platform callback
 * answers it, and only the answer creates a binding.
 *
 * WHY THE RAW TOKEN IS NEVER STORED
 *
 * The database keeps a fingerprint. A stored token is redeemable, which makes a database dump a way to
 * bind somebody else's Telegram to your account. The fingerprint proves which token was consumed
 * without being able to consume it.
 *
 * WHY CONSUMPTION IS AN UPDATE WITH A PREDICATE
 *
 * Single-use is enforced by `WHERE status = 'PENDING'` returning a row, not by reading the status and
 * then writing it. Two callbacks arriving together both pass a read-then-write; only one can win an
 * UPDATE that names the state it expects to find.
 */

export const CHANNEL_LINK_TOKEN_VERSION = 1 as const;

export type LinkChannel = "telegram" | "discord";
export type LinkScope = "notify" | "policy-approval";

export interface ChannelLinkClaims {
  readonly v: typeof CHANNEL_LINK_TOKEN_VERSION;
  readonly codeId: string;
  readonly accountRefHash: string;
  readonly channel: LinkChannel;
  readonly scopes: readonly LinkScope[];
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type LinkRefusal =
  | "MALFORMED"
  | "BAD_SIGNATURE"
  | "UNSUPPORTED_VERSION"
  | "EXPIRED"
  | "ALREADY_CONSUMED"
  | "UNKNOWN_CODE"
  | "WRONG_CHANNEL"
  | "WRONG_ACCOUNT"
  | "SCOPE_CHANGED"
  | "NONCE_CHANGED"
  | "NO_PLATFORM_SUBJECT"
  | "IDENTITY_BOUND_ELSEWHERE"
  | "ACCOUNT_NOT_ACTIVE"
  | "WALLET_AUTHORITY_INACTIVE";

export type LinkVerdict =
  | { readonly ok: true; readonly claims: ChannelLinkClaims }
  | { readonly ok: false; readonly refusal: LinkRefusal; readonly detail: string };

export function newLinkCodeId(): string {
  return `clnk_${randomBytes(16).toString("hex")}`;
}

export function newLinkNonce(): string {
  return randomBytes(24).toString("hex");
}

/** One-way and safe to store or log. A fingerprint cannot be redeemed. */
export function linkTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function encode(c: ChannelLinkClaims): string {
  const field = (name: string, value: string | number): string =>
    `${name}=${Buffer.byteLength(String(value), "utf8")}:${String(value)}`;
  return [
    field("v", c.v),
    field("codeId", c.codeId),
    field("accountRef", c.accountRefHash),
    field("channel", c.channel),
    field("scopes", [...c.scopes].sort().join(",")),
    field("nonce", c.nonce),
    field("issuedAt", c.issuedAt),
    field("expiresAt", c.expiresAt),
  ].join("|");
}

function mac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`untch.channel.link.v1.${payload}`).digest("base64url");
}

export function mintChannelLinkToken(secret: string, claims: ChannelLinkClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${mac(secret, encode(claims))}`;
}

/**
 * Check the token's own integrity. Says nothing about whether it has been used.
 *
 * Kept separate from consumption so the signature can be checked before touching the database, and so
 * a caller cannot accidentally treat a well-formed token as a redeemed one.
 */
export function readChannelLinkToken(
  secret: string,
  token: string,
  expected: { readonly channel: LinkChannel; readonly nowMs: number },
): LinkVerdict {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, refusal: "MALFORMED", detail: "not a link token" };

  let claims: ChannelLinkClaims;
  try {
    claims = JSON.parse(Buffer.from(token.slice(0, dot), "base64url").toString("utf8")) as ChannelLinkClaims;
  } catch {
    return { ok: false, refusal: "MALFORMED", detail: "payload is not JSON" };
  }
  if (claims?.v !== CHANNEL_LINK_TOKEN_VERSION) {
    return { ok: false, refusal: "UNSUPPORTED_VERSION", detail: "unsupported link token version" };
  }

  const presented = Buffer.from(token.slice(dot + 1), "utf8");
  const computed = Buffer.from(mac(secret, encode(claims)), "utf8");
  if (presented.length !== computed.length || !timingSafeEqual(presented, computed)) {
    return { ok: false, refusal: "BAD_SIGNATURE", detail: "signature does not match the claims" };
  }
  if (typeof claims.expiresAt !== "number" || claims.expiresAt <= expected.nowMs) {
    return { ok: false, refusal: "EXPIRED", detail: "this link has expired" };
  }
  if (claims.channel !== expected.channel) {
    return { ok: false, refusal: "WRONG_CHANNEL", detail: `this link is for ${claims.channel}` };
  }
  return { ok: true, claims };
}

/** What the platform told us about who just interacted. */
export interface PlatformSubject {
  /** The platform's own user id. Never published. */
  readonly externalSubjectId: string;
  /** Where to deliver. A Telegram chat id, a Discord channel id. */
  readonly deliveryTargetId: string | null;
  /** A Discord guild or Slack workspace. Null for a direct message. */
  readonly workspaceRef: string | null;
  readonly displayLabel: string | null;
  /**
   * How the platform proved it. Recorded verbatim on the binding, because a row that claims a proof
   * method it did not use is worse than one that admits it was never verified.
   */
  readonly verificationMethod: string;
}

export type ConsumeResult =
  | {
      readonly ok: true;
      readonly bindingId: string;
      readonly accountId: string;
      readonly channel: LinkChannel;
      readonly scopes: readonly LinkScope[];
      readonly supersededBindingId: string | null;
    }
  | { readonly ok: false; readonly refusal: LinkRefusal; readonly detail: string };

export function newLinkedChannelBindingId(): string {
  return `cbnd_${randomBytes(16).toString("hex")}`;
}

/**
 * Turn a verified callback into a binding, exactly once.
 *
 * The caller owns the transaction, so a proof harness can run the whole flow and roll it back.
 *
 * Every refusal below is a real attack or a real mistake, not a hypothetical:
 *   • a replayed callback would bind a stale link a second time
 *   • a callback with no platform subject is somebody POSTing to the webhook by hand
 *   • an identity already bound elsewhere is one person trying to decide for two accounts
 *   • a revoked wallet means the account holder proving a channel no longer controls the account
 */
export async function consumeChannelLink(
  tx: ServiceCallTx,
  args: {
    readonly claims: ChannelLinkClaims;
    readonly tokenFingerprint: string;
    readonly subject: PlatformSubject;
    readonly nowMs: number;
  },
): Promise<ConsumeResult> {
  if (!args.subject.externalSubjectId || args.subject.externalSubjectId.trim() === "") {
    return {
      ok: false,
      refusal: "NO_PLATFORM_SUBJECT",
      detail: "the callback carried no platform-authenticated identity",
    };
  }

  /**
   * Consume by UPDATE with a predicate, not by read-then-write. The returned row IS the proof that
   * this caller is the one that consumed it, so two simultaneous callbacks cannot both proceed.
   */
  const { rows: codeRows } = await tx.query<Record<string, unknown>>(
    `UPDATE untch_channel_bind_codes
        SET status = 'COMPLETED', consumed_at = now()
      WHERE code_id = $1
        AND status = 'PENDING'
        AND expires_at > $2::timestamptz
        AND code_hash = $3
      RETURNING *`,
    [args.claims.codeId, new Date(args.nowMs).toISOString(), args.tokenFingerprint],
  );
  const code = codeRows[0];
  if (!code) {
    /**
     * One query, several possible reasons. Read the row to say which, so an operator debugging a
     * failed link is not left guessing between expired, already used and never existed.
     */
    const { rows: probe } = await tx.query<{ status: string; expires_at: Date }>(
      `SELECT status, expires_at FROM untch_channel_bind_codes WHERE code_id = $1`,
      [args.claims.codeId],
    );
    if (!probe[0]) return { ok: false, refusal: "UNKNOWN_CODE", detail: "no such link request" };
    if (probe[0].status !== "PENDING") {
      return { ok: false, refusal: "ALREADY_CONSUMED", detail: "this link was already used" };
    }
    return { ok: false, refusal: "EXPIRED", detail: "this link has expired" };
  }

  if (String(code.channel) !== args.claims.channel) {
    return { ok: false, refusal: "WRONG_CHANNEL", detail: "the stored request names a different channel" };
  }
  if (String(code.nonce ?? "") !== args.claims.nonce) {
    return { ok: false, refusal: "NONCE_CHANGED", detail: "the link nonce does not match the stored request" };
  }
  const storedScopes = (code.requested_scopes as string[] | null) ?? [];
  const claimed = [...args.claims.scopes].sort();
  if (JSON.stringify([...storedScopes].sort()) !== JSON.stringify(claimed)) {
    /**
     * The refusal that stops a `notify` link coming back as an approval link. The scope a person
     * agreed to when they opened the link is the scope they get.
     */
    return { ok: false, refusal: "SCOPE_CHANGED", detail: "the requested scopes do not match the stored request" };
  }
  if (String(code.account_ref_hash ?? "") !== args.claims.accountRefHash) {
    return { ok: false, refusal: "WRONG_ACCOUNT", detail: "the link does not belong to the named account" };
  }

  const accountId = String(code.account_id);

  const { rows: acct } = await tx.query<{ status: string }>(
    `SELECT status FROM untch_accounts WHERE account_id = $1`,
    [accountId],
  );
  if (!acct[0] || acct[0].status !== "ACTIVE") {
    return { ok: false, refusal: "ACCOUNT_NOT_ACTIVE", detail: "the account is not active" };
  }

  /**
   * Approval authority requires a live wallet authority behind it. A channel that can commit money for
   * an account whose wallet has been revoked would outlive the thing that made the account trustworthy.
   */
  if (claimed.includes("policy-approval")) {
    const { rows: wallet } = await tx.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_wallet_bindings
        WHERE account_id = $1 AND status = 'ACTIVE' AND 'policy-authority' = ANY(scopes)`,
      [accountId],
    );
    if (Number(wallet[0]?.n ?? "0") === 0) {
      return {
        ok: false,
        refusal: "WALLET_AUTHORITY_INACTIVE",
        detail: "this account has no active wallet authority to approve under",
      };
    }
  }

  /**
   * One platform identity, one account. Checked before insert so the refusal names the real problem
   * rather than surfacing as a unique-index violation.
   */
  const { rows: existing } = await tx.query<{ binding_id: string; account_id: string }>(
    `SELECT binding_id, account_id FROM untch_channel_bindings
      WHERE channel = $1 AND channel_user_id = $2 AND status IN ('PENDING','ACTIVE','ACTIVE_RECEIVE_ONLY')
      FOR UPDATE`,
    [args.claims.channel, args.subject.externalSubjectId],
  );
  let supersededBindingId: string | null = null;
  if (existing[0]) {
    if (existing[0].account_id !== accountId) {
      return {
        ok: false,
        refusal: "IDENTITY_BOUND_ELSEWHERE",
        detail: "this platform identity is already linked to another account",
      };
    }
    /**
     * Same account re-linking. The old row is superseded in this transaction rather than updated, so
     * the provenance of each binding stays exactly what it was when it was created.
     */
    await tx.query(
      `UPDATE untch_channel_bindings
          SET status = 'SUPERSEDED', updated_at = now(), updated_by = 'channel-link'
        WHERE binding_id = $1`,
      [existing[0].binding_id],
    );
    supersededBindingId = existing[0].binding_id;
  }

  const bindingId = newLinkedChannelBindingId();
  const canDecide = claimed.includes("policy-approval");
  await tx.query(
    `INSERT INTO untch_channel_bindings
       (binding_id, account_id, channel, channel_user_id, channel_chat_id, display_label,
        can_decide, status, verified_at, scopes, account_ref_hash, verification_method,
        proof_ref, workspace_ref, superseded_by, created_at, created_by, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE', now(), $8,$9,$10,$11,$12, NULL, now(),'channel-link', now(),'channel-link')`,
    [
      bindingId,
      accountId,
      args.claims.channel,
      args.subject.externalSubjectId,
      args.subject.deliveryTargetId,
      args.subject.displayLabel,
      canDecide,
      claimed,
      args.claims.accountRefHash,
      args.subject.verificationMethod,
      args.claims.codeId,
      args.subject.workspaceRef,
    ],
  );
  if (supersededBindingId) {
    await tx.query(`UPDATE untch_channel_bindings SET superseded_by = $2 WHERE binding_id = $1`, [
      supersededBindingId,
      bindingId,
    ]);
  }

  return {
    ok: true,
    bindingId,
    accountId,
    channel: args.claims.channel,
    scopes: claimed as LinkScope[],
    supersededBindingId,
  };
}
