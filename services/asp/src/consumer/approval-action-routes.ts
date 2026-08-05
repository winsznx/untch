import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import {
  actOnApproval,
  consumeActionRef,
  mintTokenForRef,
  resolveActionRef,
  type Pool,
  type ResolvedActionRef,
} from "@untch/consumer-core";
import { ledgerPartitionKey } from "@untch/policy-engine";
import { openAccountSession } from "./account-auth";

/**
 * The human half: a link in a chat message that ends in an authorised financial decision.
 *
 * THE SHAPE, AND WHY IT IS THIS SHAPE
 *
 *   GET  /consumer/approvals/action/:ref            → redirect into Discord OAuth. Writes nothing.
 *   GET  /consumer/approvals/action/:ref/return     → OAuth returns. Verifies the subject. Writes nothing.
 *   POST /consumer/approvals/action/:ref/confirm    → the ONLY thing that decides.
 *   POST /consumer/approvals/:id/act                → the web actor, same implementation.
 *
 * EVERY GET IS INERT, AND THAT IS NOT A STYLE PREFERENCE
 *
 * Discord unfurls links. So do Slack, iMessage, Signal and every crawler that sees a URL in a public
 * channel. Browsers prefetch. Users refresh. Anti-virus scanners follow links in transit. If a GET
 * could approve a payment, then posting the message would approve the payment, and the person it was
 * addressed to would never have touched it.
 *
 * So no GET here writes financial state. The OAuth callback does not act either, which is the subtler
 * half: it is still a GET, it arrives with a code Discord supplied, and treating "the OAuth round trip
 * completed" as "the user pressed Approve" would let a prefetched callback URL decide.
 *
 * POSSESSION OF THE URL IS NOT IDENTITY
 *
 * The reference is opaque and unguessable, and that is a defence in depth rather than the mechanism.
 * The mechanism is that the Discord subject returned by OAuth must equal the `channel_user_id` on the
 * exact ChannelBinding the reference was minted against. A stranger holding the URL reaches a login
 * screen and then a refusal.
 */

export const APPROVAL_ACTION_START_ROUTE = "/consumer/approvals/action/:actionReferenceId" as const;
export const APPROVAL_ACTION_RETURN_ROUTE = "/consumer/approvals/action/:actionReferenceId/return" as const;
export const APPROVAL_ACTION_CONFIRM_ROUTE = "/consumer/approvals/action/:actionReferenceId/confirm" as const;
export const WEB_APPROVAL_ACTION_ROUTE = "/consumer/approvals/:approvalRequestId/act" as const;

/** How long a minted token lives. Short: it exists only between a confirmation page and its POST. */
const TOKEN_TTL_MS = 10 * 60_000;
/** How long the OAuth-proven subject stays usable without re-authenticating. */
const ACTOR_TTL_MS = 10 * 60_000;

export interface ApprovalActionDeps {
  readonly pool: Pool;
  /** The account-session secret. Also seals the short-lived actor cookie and the CSRF token. */
  readonly secret: string;
  readonly publicBaseUrl: string;
  readonly discord: {
    readonly applicationId: string | null;
    readonly redirectUri: string | null;
    /** Exchanges an OAuth code for the authenticated subject. Never stores the access token. */
    readonly exchangeCode: (code: string, redirectUri: string) => Promise<{ subject: string } | null>;
  };
  /** Reads the CURRENT policy at action time. The same resolver shape `actOnApproval` demands. */
  readonly resolvePolicy: (policyId: string) => Promise<{ status: string; expiresAtMs: number | null; dailyLimit: string | null } | null>;
  readonly now?: () => number;
}

const ACTOR_COOKIE = "untch_approval_actor";

/** The states from which no further answer is possible. Kept beside the refusal that reads them. */
const TERMINAL_REQUEST_STATES = new Set(["APPROVED", "REJECTED", "EXPIRED", "EXECUTED", "CANCELLED", "SUPERSEDED"]);

/**
 * Read one cookie from the raw header.
 *
 * Done by hand rather than by mounting `cookie-parser`, because a global parser would change what every
 * other route on this app sees, and this is the only surface in the service that needs a cookie at all.
 */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The proof that an OAuth round trip happened, sealed so the browser cannot forge one.
 *
 * A cookie rather than a server-side session row on purpose: it is scoped to one action reference and
 * lives ten minutes, so a table would be a table of things that expire faster than they are read. It
 * carries the SUBJECT so the POST can re-check it against the binding without a second OAuth trip, and
 * it is bound to the reference so a cookie minted for one action cannot confirm another.
 */
function sealActor(secret: string, actionReferenceId: string, subject: string, expiresAt: number): string {
  const payload = `${actionReferenceId}.${subject}.${expiresAt}`;
  const mac = createHmac("sha256", secret).update(`untch.approval.actor.v1.${payload}`).digest("base64url");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${mac}`;
}

function openActor(
  secret: string,
  sealed: string | undefined,
  actionReferenceId: string,
  nowMs: number,
): { subject: string } | null {
  if (!sealed) return null;
  const dot = sealed.lastIndexOf(".");
  if (dot <= 0) return null;
  let payload: string;
  try {
    payload = Buffer.from(sealed.slice(0, dot), "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(`untch.approval.actor.v1.${payload}`).digest("base64url");
  const a = Buffer.from(sealed.slice(dot + 1), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const parts = payload.split(".");
  if (parts.length !== 3) return null;
  const [ref, subject, expiry] = parts as [string, string, string];
  if (ref !== actionReferenceId) return null;
  if (!Number.isFinite(Number(expiry)) || Number(expiry) <= nowMs) return null;
  return { subject };
}

/**
 * CSRF, derived rather than stored.
 *
 * The token is an HMAC over the reference and the proven subject, so producing one requires already
 * holding the sealed actor cookie. A cross-site form post carries the cookie but cannot read it, so it
 * cannot put the matching token in the body.
 */
function csrfToken(secret: string, actionReferenceId: string, subject: string): string {
  return createHmac("sha256", secret).update(`untch.approval.csrf.v1.${actionReferenceId}.${subject}`).digest("base64url");
}

function csrfOk(secret: string, actionReferenceId: string, subject: string, presented: unknown): boolean {
  if (typeof presented !== "string" || presented === "") return false;
  const expected = Buffer.from(csrfToken(secret, actionReferenceId, subject), "utf8");
  const got = Buffer.from(presented, "utf8");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

const REFUSAL_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  EXPIRED: 410,
  ALREADY_CONSUMED: 409,
  INVALIDATED: 409,
  REQUEST_NOT_PENDING: 409,
  DIGEST_MOVED: 409,
  BINDING_NOT_ACTIVE: 403,
  BINDING_CANNOT_DECIDE: 403,
  SUBJECT_MISMATCH: 403,
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

interface RequestFacts {
  readonly provider: string;
  readonly capability: string;
  readonly amount: string;
  readonly asset: string;
  readonly recipient: string | null;
  readonly policyId: string;
  readonly state: string;
  readonly requestExpiresAt: string;
  readonly approvalExpiresAt: string;
}

async function requestFacts(pool: Pool, approvalRequestId: string): Promise<RequestFacts | null> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT q.provider, q.capability, q.amount, q.asset, q.recipient, q.policy_id, q.state,
            q.expires_at, c.settled_at
       FROM untch_approval_requests q
       LEFT JOIN untch_x402_service_calls c ON c.service_call_id = q.service_call_id
      WHERE q.approval_request_id = $1`,
    [approvalRequestId],
  );
  const r = rows[0];
  if (!r) return null;
  const expires = r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at);
  return {
    provider: String(r.provider),
    capability: String(r.capability),
    amount: String(r.amount),
    asset: String(r.asset),
    recipient: r.recipient === null ? null : String(r.recipient),
    policyId: String(r.policy_id),
    state: String(r.state),
    requestExpiresAt: expires,
    approvalExpiresAt: expires,
  };
}

/**
 * The confirmation page.
 *
 * It states the EXACT obligation, because "Approve?" with no numbers is how a person authorises
 * something they never saw. The recipient is shown truncated in the middle rather than in full: enough
 * to check against what they expect, not a full address pasted into a page that might be shoulder-read.
 *
 * The only interactive element is a form that POSTs. There is no link that decides.
 */
function confirmationPage(args: {
  readonly ref: ResolvedActionRef;
  readonly facts: RequestFacts;
  readonly csrf: string;
  readonly postTo: string;
}): string {
  const { ref, facts } = args;
  const safeRecipient =
    facts.recipient === null
      ? "none — this capability has no deterministic recipient until execution"
      : `${facts.recipient.slice(0, 10)}…${facts.recipient.slice(-8)}`;
  const verb = ref.action === "APPROVE" ? "Approve" : "Deny";
  const row = (label: string, value: string): string =>
    `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${escapeHtml(verb)} payment · Untch</title>
<style>
 body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#111}
 table{border-collapse:collapse;width:100%;margin:1.5rem 0}
 th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid #e5e5e5;vertical-align:top}
 th{width:12rem;font-weight:600;color:#555}
 .amount{font-size:1.5rem;font-weight:700}
 button{font:inherit;padding:.7rem 1.4rem;border-radius:.4rem;border:0;cursor:pointer}
 .go{background:${ref.action === "APPROVE" ? "#0a7" : "#c33"};color:#fff}
 .note{color:#666;font-size:.9rem}
</style></head><body>
<h1>${escapeHtml(verb)} this payment?</h1>
<p class="amount">${escapeHtml(facts.amount)} ${escapeHtml(facts.asset)}</p>
<table>
${row("Action", verb)}
${row("Provider", facts.provider)}
${row("Capability", facts.capability)}
${row("Amount", `${facts.amount} ${facts.asset}`)}
${row("Recipient", safeRecipient)}
${row("Policy", facts.policyId)}
${row("Current status", facts.state)}
${row("Request expires", facts.requestExpiresAt)}
${row("Approval expires", ref.expiresAt)}
</table>
<form method="POST" action="${escapeHtml(args.postTo)}">
  <input type="hidden" name="csrf" value="${escapeHtml(args.csrf)}">
  <button class="go" type="submit">${escapeHtml(verb)} ${escapeHtml(facts.amount)} ${escapeHtml(facts.asset)}</button>
</form>
<p class="note">Nothing has happened yet. ${
    ref.action === "APPROVE"
      ? "Approving reserves this amount as authority under your policy. It does not move money and runs no provider."
      : "Denying records a refusal and creates no authority."
  }</p>
</body></html>`;
}

export function registerApprovalActionRoutes(app: Express, deps: ApprovalActionDeps | null): void {
  const form = express.urlencoded({ extended: false, limit: "16kb" });
  const json = express.json({ limit: "16kb" });

  if (!deps) {
    const why = "the approval action surface is not wired on this instance";
    const unavailable = (_req: Request, res: Response): void => {
      res.status(503).json({ code: "APPROVAL_ACTIONS_UNAVAILABLE", message: why, retryable: false, docsUrl: null });
    };
    app.get(APPROVAL_ACTION_START_ROUTE, unavailable);
    app.get(APPROVAL_ACTION_RETURN_ROUTE, unavailable);
    app.post(APPROVAL_ACTION_CONFIRM_ROUTE, unavailable);
    app.post(WEB_APPROVAL_ACTION_ROUTE, unavailable);
    return;
  }

  const d = deps;
  const now = (): number => d.now?.() ?? Date.now();

  const refuse = (res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void => {
    res.status(status).json({ code, message, retryable: false, docsUrl: null, wroteNothing: true, ...extra });
  };

  /**
   * ── GET: begin authentication, and nothing else ───────────────────────────
   *
   * It resolves the reference far enough to know the link is worth an OAuth round trip, and refuses
   * early on a dead one so a person is not bounced through Discord to reach an error. It passes null as
   * the presented subject, so no identity check happens here and none is implied.
   */
  app.get(APPROVAL_ACTION_START_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const id = req.params.actionReferenceId ?? "";
      const verdict = await resolveActionRef(d.pool, id, null, now());
      if (!verdict.ok) {
        return refuse(res, REFUSAL_STATUS[verdict.refusal] ?? 409, `ACTION_${verdict.refusal}`, verdict.detail);
      }
      if (!d.discord.applicationId || !d.discord.redirectUri) {
        return refuse(res, 503, "DISCORD_NOT_CONFIGURED", "this deployment cannot verify a Discord identity");
      }

      /**
       * `state` carries the reference so the callback knows which action it is returning for. It is
       * signed, because an unsigned state is a parameter an attacker chooses, and the callback would
       * then verify a subject against a binding of their choosing.
       */
      const state = sealActor(d.secret, id, "pending", now() + ACTOR_TTL_MS);
      const url =
        `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(d.discord.applicationId)}` +
        `&response_type=code&scope=identify` +
        `&redirect_uri=${encodeURIComponent(d.discord.redirectUri)}` +
        `&state=${encodeURIComponent(state)}` +
        `&prompt=none`;

      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.redirect(302, url);
    })().catch(next);
  });

  /**
   * ── OAuth return: prove who they are, show them the facts, decide nothing ─
   *
   * This is a GET and it stays inert. A crawler, a prefetch or a refresh reaching it produces a page and
   * no state change. Treating a completed OAuth round trip as consent would mean a prefetched callback
   * URL could approve a payment nobody looked at.
   */
  app.get(APPROVAL_ACTION_RETURN_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const id = req.params.actionReferenceId ?? "";
      const code = typeof req.query.code === "string" ? req.query.code : null;
      if (!code) return refuse(res, 400, "OAUTH_CODE_REQUIRED", "discord did not return an authorisation code");
      if (!d.discord.redirectUri) {
        return refuse(res, 503, "DISCORD_NOT_CONFIGURED", "this deployment cannot verify a Discord identity");
      }

      const exchanged = await d.discord.exchangeCode(code, d.discord.redirectUri);
      if (!exchanged) {
        return refuse(res, 400, "NO_PLATFORM_SUBJECT", "discord did not confirm an authenticated identity");
      }

      /** The subject is checked against the binding HERE, by the resolver, in one place. */
      const verdict = await resolveActionRef(d.pool, id, exchanged.subject, now());
      if (!verdict.ok) {
        return refuse(res, REFUSAL_STATUS[verdict.refusal] ?? 409, `ACTION_${verdict.refusal}`, verdict.detail);
      }
      const facts = await requestFacts(d.pool, verdict.ref.approvalRequestId);
      if (!facts) return refuse(res, 404, "ACTION_NOT_FOUND", "no such approval request");

      const expiresAt = now() + ACTOR_TTL_MS;
      /**
       * `HttpOnly` so script cannot read it, `Secure` so it never travels in clear, `SameSite=Lax` so a
       * cross-site POST does not carry it, and `Path` scoped to this reference so it is useless
       * anywhere else. The CSRF token is derived from its contents, so a form that cannot read the
       * cookie cannot produce the token either.
       */
      res.setHeader(
        "Set-Cookie",
        `${ACTOR_COOKIE}=${encodeURIComponent(sealActor(d.secret, id, exchanged.subject, expiresAt))}` +
          `; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ACTOR_TTL_MS / 1000)}` +
          `; Path=/consumer/approvals/action/${encodeURIComponent(id)}`,
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(
        confirmationPage({
          ref: verdict.ref,
          facts,
          csrf: csrfToken(d.secret, id, exchanged.subject),
          postTo: `${d.publicBaseUrl}/consumer/approvals/action/${id}/confirm`,
        }),
      );
    })().catch(next);
  });

  /**
   * ── POST: the only thing that decides ─────────────────────────────────────
   */
  app.post(APPROVAL_ACTION_CONFIRM_ROUTE, form, json, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const id = req.params.actionReferenceId ?? "";
      const actor = openActor(d.secret, readCookie(req, ACTOR_COOKIE), id, now());
      if (!actor) {
        return refuse(res, 401, "ACTION_ACTOR_REQUIRED", "open the link again and sign in with Discord before deciding");
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!csrfOk(d.secret, id, actor.subject, body.csrf)) {
        return refuse(res, 403, "CSRF_REFUSED", "this form submission did not come from the confirmation page");
      }

      /**
       * The subject is verified AGAIN against the live binding, not trusted from the cookie's word that
       * it was verified once. A binding revoked between the confirmation page and the button press must
       * refuse, and this is the last moment that can be noticed.
       */
      const client = await d.pool.connect();
      try {
        await client.query("BEGIN");
        const verdict = await resolveActionRef(client as never, id, actor.subject, now());
        if (!verdict.ok) {
          await client.query("ROLLBACK");
          return refuse(res, REFUSAL_STATUS[verdict.refusal] ?? 409, `ACTION_${verdict.refusal}`, verdict.detail);
        }
        const outcome = await actOnReference(client as never, d, verdict.ref);
        if (outcome.status >= 400) {
          await client.query("ROLLBACK");
          res.status(outcome.status).json(outcome.body);
          return;
        }
        await client.query("COMMIT");
        res.setHeader("Cache-Control", "no-store");
        res.status(outcome.status).json(outcome.body);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    })().catch(next);
  });

  /**
   * ── The web actor, on the same implementation ─────────────────────────────
   *
   * A SIWE session, the account's own web ChannelBinding, and `actOnApproval`. There is deliberately no
   * shortcut here that Discord does not also take: the web binding is a real `untch_channel_bindings`
   * row with the same scopes and the same can-decide check, so the terminal path cannot tell them apart.
   */
  app.post(WEB_APPROVAL_ACTION_ROUTE, json, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const bearer = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1];
      const session = openAccountSession(d.secret, bearer, now());
      if (!session) {
        return refuse(res, 401, "ACCOUNT_SESSION_REQUIRED", "approvals are decided with the wallet that owns the account");
      }
      const approvalRequestId = req.params.approvalRequestId ?? "";
      const body = (req.body ?? {}) as Record<string, unknown>;
      const action = typeof body.action === "string" ? body.action.toUpperCase() : null;
      if (action !== "APPROVE" && action !== "DENY") {
        return refuse(res, 400, "ACTION_REQUIRED", 'action must be "APPROVE" or "DENY"');
      }
      if (!csrfOk(d.secret, approvalRequestId, session.accountId, body.csrf)) {
        return refuse(res, 403, "CSRF_REFUSED", "this submission did not carry the request-bound token");
      }

      /**
       * Scopes are re-read from the LIVE wallet binding rather than taken from the session token. A
       * session is a claim about a moment, and the wallet behind it can be revoked inside that moment.
       */
      const { rows: wallets } = await d.pool.query<{ scopes: string[] | null }>(
        `SELECT scopes FROM untch_wallet_bindings WHERE account_id = $1 AND status = 'ACTIVE'`,
        [session.accountId],
      );
      if (wallets.length === 0) {
        return refuse(res, 403, "WALLET_AUTHORITY_INACTIVE", "this account has no active wallet binding");
      }
      const scopes = wallets.flatMap((w) => w.scopes ?? []);
      if (!scopes.includes("policy-authority")) {
        return refuse(
          res,
          403,
          "AUTHORITY_NOT_DERIVABLE",
          "this session proves identity and does not carry authority to approve payments under a policy",
        );
      }

      const client = await d.pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: refs } = await client.query<{ action_reference_id: string }>(
          `SELECT r.action_reference_id
             FROM untch_approval_action_refs r
             JOIN untch_channel_bindings b ON b.binding_id = r.channel_binding_id
            WHERE r.approval_request_id = $1 AND r.account_id = $2 AND r.action = $3
              AND b.channel = 'web' AND r.consumed_at IS NULL AND r.invalidated_at IS NULL`,
          [approvalRequestId, session.accountId, action],
        );
        const refId = refs[0]?.action_reference_id;
        if (!refId) {
          await client.query("ROLLBACK");
          return refuse(res, 404, "ACTION_NOT_FOUND", "no live web action of that kind exists for this request");
        }
        const verdict = await resolveActionRef(client as never, refId, null, now());
        if (!verdict.ok) {
          await client.query("ROLLBACK");
          return refuse(res, REFUSAL_STATUS[verdict.refusal] ?? 409, `ACTION_${verdict.refusal}`, verdict.detail);
        }
        if (verdict.ref.accountId !== session.accountId) {
          await client.query("ROLLBACK");
          return refuse(res, 403, "ACTION_WRONG_ACCOUNT", "this action belongs to a different account");
        }
        const outcome = await actOnReference(client as never, d, verdict.ref);
        if (outcome.status >= 400) {
          await client.query("ROLLBACK");
          res.status(outcome.status).json(outcome.body);
          return;
        }
        await client.query("COMMIT");
        res.setHeader("Cache-Control", "no-store");
        res.status(outcome.status).json(outcome.body);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    })().catch(next);
  });
}

/**
 * Mint, consume, decide — one function, called by BOTH channels.
 *
 * There is no second decision implementation anywhere in this file. Discord and the browser differ in
 * how they prove who is asking and in nothing after that, which is what makes "one terminal
 * ApprovalDecision, one reservation at most" a property of the code rather than of two code paths
 * agreeing.
 */
async function actOnReference(
  tx: { query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> },
  deps: ApprovalActionDeps,
  ref: ResolvedActionRef,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const nowMs = deps.now?.() ?? Date.now();

  /**
   * The partition the reservation is accounted under, read from the request rather than derived from
   * the reference. Budget is a property of the POLICY, and a key built from anything else would let two
   * policies share one window.
   *
   * `FOR UPDATE`, AND IT IS THE FIRST LOCK THIS TRANSACTION TAKES.
   *
   * `actOnApproval` documents the order every caller must follow — request, then service call, then
   * binding — and takes the request lock itself. That is not sufficient here, because this function
   * BURNS A REFERENCE before calling it and then invalidates the siblings after, so the real sequence
   * without this lock is:
   *
   *   own action ref  →  request  →  every other action ref
   *
   * Two channels answering at once each hold their own reference and each want the other's, which is a
   * cycle: Discord holds the Discord ref and waits on the request; the web actor holds the web ref and
   * waits on the request; whichever wins the request then waits forever on the loser's ref. Postgres
   * detects it and kills one transaction with 40P01, and the person who pressed the button gets a 500
   * on a payment decision rather than "that is already handled".
   *
   * Taking the REQUEST first makes the order identical for both channels — request, own ref, sibling
   * refs — so they queue on one row instead of deadlocking on two. The loser then blocks here, reads
   * the committed terminal state when it is released, and refuses cleanly below.
   */
  const { rows: policyRows } = await tx.query(
    `SELECT policy_id, state FROM untch_approval_requests WHERE approval_request_id = $1 FOR UPDATE`,
    [ref.approvalRequestId],
  );
  const requestRow = policyRows[0] as { policy_id?: string; state?: string } | undefined;
  const policyId = requestRow?.policy_id;
  if (!policyId) {
    return { status: 404, body: { code: "ACTION_NOT_FOUND", message: "the request behind this action is gone", wroteNothing: true } };
  }

  const token = await mintTokenForRef(tx as never, deps.secret, ref, nowMs, TOKEN_TTL_MS);
  if (!token) {
    return { status: 404, body: { code: "ACTION_NOT_FOUND", message: "the request behind this action is gone", wroteNothing: true } };
  }

  /**
   * The reference is burned BEFORE the decision, in the same transaction. Two concurrent presses on one
   * link both reach here and exactly one wins the conditional UPDATE; the loser never gets as far as a
   * decision. `actOnApproval`'s nonce insert is the second, independent guard for two DIFFERENT links.
   */
  if (!(await consumeActionRef(tx as never, ref.actionReferenceId, token))) {
    /**
     * Two ways to arrive here, and they are different facts. The link itself having been used twice is
     * one; the OTHER channel having answered first — which invalidated this reference on its way out —
     * is the other, and it is the one a racing caller hits. Reporting the request's own terminal state
     * says what actually happened rather than blaming the link.
     */
    const resolved = TERMINAL_REQUEST_STATES.has(String(requestRow?.state ?? ""));
    return {
      status: 409,
      body: resolved
        ? {
            outcome: "ALREADY_RESOLVED",
            approvalRequestId: ref.approvalRequestId,
            message: `this request is already ${String(requestRow?.state)}`,
            wroteNothing: true,
          }
        : { code: "ACTION_ALREADY_CONSUMED", message: "this action has already been used", wroteNothing: true },
    };
  }

  const result = await actOnApproval(tx as never, {
    approvalRequestId: ref.approvalRequestId,
    action: ref.action,
    token,
    tokenSecret: deps.secret,
    channelBindingId: ref.channelBindingId,
    nowMs,
    partitionKey: ledgerPartitionKey(policyId),
    resolvePolicy: deps.resolvePolicy,
  });

  const terminal = result.outcome === "APPROVED" || result.outcome === "DENIED";
  return {
    status: terminal ? 200 : result.outcome === "ALREADY_RESOLVED" ? 409 : 422,
    body: {
      outcome: result.outcome,
      approvalRequestId: result.approvalRequestId,
      decisionId: result.decisionId,
      reservationId: result.reservationId,
      channel: ref.channel,
      tokenRefusal: result.tokenRefusal,
      detail: result.detail,
      budget: result.budget,
      /**
       * Stated in the response, not left to be inferred. An APPROVED decision on this route creates
       * RESERVED AUTHORITY and moves no money, and a surface that omitted this is how an authorisation
       * comes to be read as a completed payment.
       */
      paid: false,
      providerExecuted: false,
      economicClassification: result.outcome === "APPROVED" ? "RESERVED_AUTHORITY_NOT_SPEND" : "NO_AUTHORITY_GRANTED",
    },
  };
}

/** A CSRF token for the web surface, so the dashboard can render a form this route will accept. */
export function webActionCsrfToken(secret: string, approvalRequestId: string, accountId: string): string {
  return createHmac("sha256", secret)
    .update(`untch.approval.csrf.v1.${approvalRequestId}.${accountId}`)
    .digest("base64url");
}

/** Exported so a test can build a sealed actor without driving a real OAuth round trip. */
export function sealActorForTest(secret: string, actionReferenceId: string, subject: string, expiresAt: number): string {
  return sealActor(secret, actionReferenceId, subject, expiresAt);
}

export function csrfForTest(secret: string, actionReferenceId: string, subject: string): string {
  return csrfToken(secret, actionReferenceId, subject);
}

/** Used by the delivery gateway to build the two links a message carries. */
export function actionUrls(publicBaseUrl: string, refs: { APPROVE: string; DENY: string }): { approve: string; deny: string } {
  return {
    approve: `${publicBaseUrl}/consumer/approvals/action/${refs.APPROVE}`,
    deny: `${publicBaseUrl}/consumer/approvals/action/${refs.DENY}`,
  };
}
