import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";

/**
 * The token that turns a button press into an authorised financial decision.
 *
 * WHY A PLAIN "YES" CANNOT REACH THIS FILE
 *
 * A channel adapter receives words. "approve", "ok", "send it" are all things a person types, and none
 * of them names an amount, a recipient or a quote. An approval built on words authorises whatever the
 * server happens to think the request is at the moment the words arrive, which is exactly the failure
 * the approval digest was built to close: raise for 6.00, re-quote to 6.50, and the word "yes" still
 * fits.
 *
 * So the only thing that can approve is a token that COMMITS to the whole obligation. Every field the
 * money depends on is inside the MAC. Change any of them and verification fails, because the token was
 * never about that payment.
 *
 * WHAT THIS IS NOT
 *
 * It is not a session and it is not a capability that can be widened. One token, one request, one
 * action, one channel binding, one use. The nonce is consumed by a PRIMARY KEY insert rather than by a
 * flag check, because two concurrent taps on the same Telegram button both pass a flag check and only
 * one can win an insert.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * No raw `accountId`. The token is handed to a channel and may be inspected by anyone holding it, so
 * it carries `accountRefHash` and an actor reference instead. Knowing which Untch account a message
 * belongs to is not a fact a Discord message should be able to leak.
 */

export const APPROVAL_ACTION_TOKEN_VERSION = 1 as const;

export type ApprovalAction = "APPROVE" | "DENY";

/**
 * Everything the token binds.
 *
 * Flat rather than nested, because every field here is hashed and a nested shape invites a future
 * edit that adds a field to an object the encoder does not walk.
 */
export interface ApprovalActionClaims {
  readonly v: typeof APPROVAL_ACTION_TOKEN_VERSION;
  readonly approvalRequestId: string;
  readonly approvalDigest: string;
  readonly intentHash: string;
  readonly quoteDigest: string;
  readonly policyId: string;
  readonly policyHash: string;
  /** Decimal string. Never a float: this value is hashed, compared, and shown to a person. */
  readonly amount: string;
  readonly asset: string;
  readonly chain: string;
  readonly recipient: string | null;
  readonly provider: string;
  readonly capability: string;
  readonly requesterPrincipalRef: string;
  readonly walletAuthorityRef: string;
  /** The account-scoped actor, never the raw accountId. */
  readonly accountRefHash: string;
  /** Which binding may use this token. A token minted for Telegram cannot be replayed through Discord. */
  readonly channelBindingId: string;
  readonly action: ApprovalAction;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type ActionTokenRefusal =
  | "MALFORMED"
  | "BAD_SIGNATURE"
  | "UNSUPPORTED_VERSION"
  | "EXPIRED"
  | "WRONG_REQUEST"
  | "WRONG_ACTION"
  | "WRONG_BINDING"
  | "DIGEST_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "ASSET_MISMATCH"
  | "RECIPIENT_MISMATCH"
  | "QUOTE_MISMATCH"
  | "POLICY_MISMATCH"
  | "REQUESTER_MISMATCH"
  | "WALLET_AUTHORITY_MISMATCH"
  | "ACTOR_MISMATCH";

export type ActionTokenVerdict =
  | { readonly ok: true; readonly claims: ApprovalActionClaims }
  | { readonly ok: false; readonly refusal: ActionTokenRefusal; readonly detail: string };

/**
 * The subject a token is checked AGAINST.
 *
 * Read from the database at action time, never from the token. A token that claimed its own truth
 * would be a bearer instrument for whatever it said, which is what a signature is supposed to prevent.
 */
export interface ApprovalActionSubject {
  readonly approvalRequestId: string;
  readonly approvalDigest: string;
  readonly intentHash: string;
  readonly quoteDigest: string;
  readonly policyId: string;
  readonly policyHash: string;
  readonly amount: string;
  readonly asset: string;
  readonly chain: string;
  readonly recipient: string | null;
  readonly provider: string;
  readonly capability: string;
  readonly requesterPrincipalRef: string;
  readonly walletAuthorityRef: string;
  readonly accountRefHash: string;
}

const ORDER: readonly (keyof ApprovalActionClaims)[] = [
  "v", "approvalRequestId", "approvalDigest", "intentHash", "quoteDigest", "policyId", "policyHash",
  "amount", "asset", "chain", "recipient", "provider", "capability", "requesterPrincipalRef",
  "walletAuthorityRef", "accountRefHash", "channelBindingId", "action", "nonce", "issuedAt", "expiresAt",
];

/**
 * Length-prefixed, like every other digest in this codebase.
 *
 * `provider="a" capability="bc"` and `provider="ab" capability="c"` must not produce one encoding, and
 * a separator only moves the problem to whichever field can contain the separator. Null is encoded
 * rather than omitted, because a request with no recipient and one with an empty recipient are
 * different facts.
 */
function encode(claims: ApprovalActionClaims): string {
  return ORDER.map((k) => {
    const value = claims[k];
    const s = value === null ? " null" : String(value);
    return `${k}=${Buffer.byteLength(s, "utf8")}:${s}`;
  }).join("|");
}

function mac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`untch.approval.action.v1.${payload}`).digest("base64url");
}

export function newActionNonce(): string {
  return `apn_${randomBytes(24).toString("hex")}`;
}

/** A safe-to-log identifier. One-way, so a log line cannot be redeemed. */
export function actionTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * A family identifier shared by every token minted for one request.
 *
 * Deliveries record the family rather than the tokens, so invalidating a delivery invalidates what it
 * carried without any row ever holding something redeemable.
 */
export function actionTokenFamily(approvalRequestId: string, issuedAt: number): string {
  return `atf_${createHash("sha256").update(`${approvalRequestId}.${issuedAt}`).digest("hex").slice(0, 24)}`;
}

export function mintApprovalActionToken(secret: string, claims: ApprovalActionClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${mac(secret, encode(claims))}`;
}

/**
 * Verify a token against what the database currently says.
 *
 * The order is deliberate. Signature first, because an unauthenticated payload's contents are not
 * evidence of anything and comparing them would be reading attacker input. Then expiry, then the
 * field-by-field comparison against the live subject.
 *
 * Every mismatch has its OWN refusal code. A caller that sees `AMOUNT_MISMATCH` learns something a
 * generic "invalid token" would have hidden, and the tests can assert the specific failure rather than
 * that something failed.
 */
export function verifyApprovalActionToken(
  secret: string,
  token: string,
  subject: ApprovalActionSubject,
  expected: { readonly action: ApprovalAction; readonly channelBindingId: string; readonly nowMs: number },
): ActionTokenVerdict {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, refusal: "MALFORMED", detail: "not a token" };

  let claims: ApprovalActionClaims;
  try {
    claims = JSON.parse(Buffer.from(token.slice(0, dot), "base64url").toString("utf8")) as ApprovalActionClaims;
  } catch {
    return { ok: false, refusal: "MALFORMED", detail: "payload is not JSON" };
  }
  if (typeof claims !== "object" || claims === null) {
    return { ok: false, refusal: "MALFORMED", detail: "payload is not an object" };
  }
  if (claims.v !== APPROVAL_ACTION_TOKEN_VERSION) {
    return { ok: false, refusal: "UNSUPPORTED_VERSION", detail: `token version ${String(claims.v)}` };
  }

  const presented = Buffer.from(token.slice(dot + 1), "utf8");
  const computed = Buffer.from(mac(secret, encode(claims)), "utf8");
  if (presented.length !== computed.length || !timingSafeEqual(presented, computed)) {
    return { ok: false, refusal: "BAD_SIGNATURE", detail: "signature does not match the claims" };
  }

  if (typeof claims.expiresAt !== "number" || claims.expiresAt <= expected.nowMs) {
    return { ok: false, refusal: "EXPIRED", detail: "this token is past its expiry" };
  }
  if (claims.approvalRequestId !== subject.approvalRequestId) {
    return { ok: false, refusal: "WRONG_REQUEST", detail: "token names a different approval request" };
  }
  if (claims.action !== expected.action) {
    return { ok: false, refusal: "WRONG_ACTION", detail: `token authorises ${claims.action}` };
  }
  if (claims.channelBindingId !== expected.channelBindingId) {
    return { ok: false, refusal: "WRONG_BINDING", detail: "token was minted for a different channel binding" };
  }

  /**
   * The comparison that makes a re-quote fatal to an old token.
   *
   * Checked one field at a time rather than by re-deriving the digest, because a caller debugging a
   * refusal needs to know WHICH term moved. The digest is checked too, so a field this list forgot
   * still cannot slip through.
   */
  const checks: readonly [keyof ApprovalActionSubject, ActionTokenRefusal][] = [
    ["approvalDigest", "DIGEST_MISMATCH"],
    ["amount", "AMOUNT_MISMATCH"],
    ["asset", "ASSET_MISMATCH"],
    ["recipient", "RECIPIENT_MISMATCH"],
    ["quoteDigest", "QUOTE_MISMATCH"],
    ["intentHash", "QUOTE_MISMATCH"],
    ["policyId", "POLICY_MISMATCH"],
    ["policyHash", "POLICY_MISMATCH"],
    ["provider", "POLICY_MISMATCH"],
    ["capability", "POLICY_MISMATCH"],
    ["chain", "POLICY_MISMATCH"],
    ["requesterPrincipalRef", "REQUESTER_MISMATCH"],
    ["walletAuthorityRef", "WALLET_AUTHORITY_MISMATCH"],
    ["accountRefHash", "ACTOR_MISMATCH"],
  ];
  for (const [field, refusal] of checks) {
    if (claims[field as keyof ApprovalActionClaims] !== subject[field]) {
      return {
        ok: false,
        refusal,
        detail: `${String(field)} changed since this token was issued`,
      };
    }
  }

  return { ok: true, claims };
}
