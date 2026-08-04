import { randomBytes } from "node:crypto";
import type { ServiceCallTx } from "./x402-service-calls";

/**
 * The browser as an approval channel, with no shortcuts.
 *
 * WHY THIS IS A REAL BINDING ROW AND NOT A SPECIAL CASE
 *
 * The tempting shape is to let the terminal-decision path accept "this request came from an
 * authenticated session" and skip the channel binding entirely. That produces two authorisation
 * paths: one where a Discord identity is checked against a stored binding with scopes and a status,
 * and one where a cookie is enough. The second is weaker, and the weaker path is the one that gets
 * exploited.
 *
 * So the web actor IS a `untch_channel_bindings` row, and `actOnApproval` cannot tell it apart from
 * Discord. Same scope check, same account-ownership check, same can-decide check, same action token.
 *
 * WHAT PROVES IT
 *
 * `verification_method = 'account_session_siwe'`. The proof is the SIWE signature that minted the
 * session plus the wallet binding behind it, both re-read at creation time. That is a genuinely
 * different proof from Telegram's or Discord's, and recording which one happened is the point.
 *
 * WHAT IT IS NOT
 *
 * It is not created by having a cookie. A session whose wallet does not hold `policy-authority`
 * produces no binding at all, so an identity-only browser session has nothing to act with.
 */

export type WebBindingRefusal =
  | "ACCOUNT_NOT_ACTIVE"
  | "WALLET_AUTHORITY_INACTIVE"
  | "AUTHORITY_NOT_DERIVABLE";

export type WebBindingResult =
  | { readonly ok: true; readonly bindingId: string; readonly created: boolean }
  | { readonly ok: false; readonly refusal: WebBindingRefusal; readonly detail: string };

/**
 * A stable per-account identity for the web surface.
 *
 * Derived from the account rather than random, so re-visiting the dashboard resolves to the same
 * binding instead of accumulating a row per session. It is not a secret: it identifies WHICH surface,
 * not who is using it.
 */
export function webChannelSubject(accountRefHash: string): string {
  return `web:${accountRefHash}`;
}

export function newWebBindingId(): string {
  return `cbnd_web_${randomBytes(12).toString("hex")}`;
}

/**
 * Ensure the account has a usable web approval binding.
 *
 * Idempotent: an existing ACTIVE row is returned rather than replaced, so a person clicking through
 * the dashboard twice does not supersede their own channel mid-approval.
 */
export async function ensureWebApprovalBinding(
  tx: ServiceCallTx,
  args: {
    readonly accountId: string;
    readonly accountRefHash: string;
    /** Scopes read from the LIVE wallet binding, not from the session token. */
    readonly walletScopes: readonly string[];
    readonly by?: string;
  },
): Promise<WebBindingResult> {
  const { rows: acct } = await tx.query<{ status: string }>(
    `SELECT status FROM untch_accounts WHERE account_id = $1`,
    [args.accountId],
  );
  if (!acct[0]) return { ok: false, refusal: "ACCOUNT_NOT_ACTIVE", detail: "no such account" };
  if (acct[0].status !== "ACTIVE") {
    return { ok: false, refusal: "ACCOUNT_NOT_ACTIVE", detail: `the account is ${acct[0].status}` };
  }

  /**
   * The wallet is re-read rather than trusted from the caller's claim. A session is a statement about
   * a moment, and the binding behind it can be revoked inside that session's lifetime.
   */
  const { rows: wallets } = await tx.query<{ n: string }>(
    `SELECT count(*)::text n FROM untch_wallet_bindings
      WHERE account_id = $1 AND status = 'ACTIVE'`,
    [args.accountId],
  );
  if (Number(wallets[0]?.n ?? "0") === 0) {
    return {
      ok: false,
      refusal: "WALLET_AUTHORITY_INACTIVE",
      detail: "this account has no active wallet binding",
    };
  }

  if (!args.walletScopes.includes("policy-authority")) {
    /**
     * The same refusal the paid decision route gives, and deliberately the same words. A browser is
     * not a way around the rule that proving who you are is not permission to spend.
     */
    return {
      ok: false,
      refusal: "AUTHORITY_NOT_DERIVABLE",
      detail:
        "this session proves identity and does not carry authority to approve payments under a policy",
    };
  }

  const subject = webChannelSubject(args.accountRefHash);
  const { rows: existing } = await tx.query<{ binding_id: string; account_id: string }>(
    `SELECT binding_id, account_id FROM untch_channel_bindings
      WHERE channel = 'web' AND channel_user_id = $1 AND status = 'ACTIVE' FOR UPDATE`,
    [subject],
  );
  if (existing[0]) {
    /**
     * The subject is derived from `accountRefHash`, which is one-way and per-account, so a collision
     * here would mean two accounts hashing alike. Checked anyway: a silent cross-account match on the
     * approval surface is worth a loud failure rather than a shrug.
     */
    if (existing[0].account_id !== args.accountId) {
      return {
        ok: false,
        refusal: "AUTHORITY_NOT_DERIVABLE",
        detail: "this web subject already belongs to a different account",
      };
    }
    return { ok: true, bindingId: existing[0].binding_id, created: false };
  }

  const bindingId = newWebBindingId();
  await tx.query(
    `INSERT INTO untch_channel_bindings
       (binding_id, account_id, channel, channel_user_id, channel_chat_id, display_label,
        can_decide, status, verified_at, scopes, account_ref_hash, verification_method,
        created_at, created_by, updated_at, updated_by)
     VALUES ($1,$2,'web',$3,NULL,'Untch dashboard', true,'ACTIVE', now(),
             ARRAY['notify','policy-approval'], $4,'account_session_siwe', now(),$5, now(),$5)`,
    [bindingId, args.accountId, subject, args.accountRefHash, args.by ?? "web-approval"],
  );
  return { ok: true, bindingId, created: true };
}
