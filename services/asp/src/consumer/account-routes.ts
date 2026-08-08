/**
 * The public account surface: link start, link complete, read, revoke.
 *
 * THE JOURNEY THESE FOUR ROUTES EXIST TO CLOSE
 *
 *   OKX social login → Agentic Wallet → verified wallet proof → UntchAccount → policies, tasks,
 *   approvals, intents and receipts.
 *
 * Untch never creates a second wallet, never receives a private key, and never treats an email as
 * spending authority. What it does is turn ONE signature into a durable account, and then hang every
 * other identity a person accumulates off that account as a binding with its own proof.
 *
 * THE MARKETPLACE CASE, WHICH IS THE HARD ONE
 *
 * Untch is hired on OKX by a caller it has never met. The call carries an agent id, which is a claim in
 * a header. `link/start` accepts that claim as CONTEXT — it is stored on the request, unproven, and it
 * authorises nothing — and answers with a URL. The same person opens it, signs with the wallet that
 * actually carries authority, and `link/complete` binds the marketplace identity to the account that
 * signature resolved to. The claim never becomes authority; it becomes a label on one proven
 * separately.
 *
 * WHAT A LINK CODE CANNOT DO
 *
 * Approve money. Nothing on this surface takes an amount, an intent or a policy. Spending needs a
 * policy, a quote, and above the threshold an approval whose digest names the exact amount — none of
 * which are reachable from any route in this file.
 */

import type { Express, Request, Response, NextFunction } from "express";
import type { Address, Hex } from "viem";
import {
  PgAccountStore,
  PgLinkRequestStore,
  newWalletBindingId,
  returnUrlAllowed,
  type AccountStore,
  type BindingScope,
  type ChannelBinding,
  type LinkRequestStore,
  type MarketplaceBinding,
  type Pool,
  type UntchAccount,
  type WalletBinding,
} from "@untch/consumer-core";
import { randomBytes } from "node:crypto";
import type { HandlerResult } from "../handlers";
import { openAccountSession, mintAccountSession, verifyWalletProof, buildLinkMessage } from "./account-auth";
import { rolesOf, SIGNIN_CHAIN_IDS } from "@untch/shared";
import type { SiweVerifier } from "./auth";

import {
  ACCOUNT_LINK_COMPLETE_ROUTE,
  ACCOUNT_LINK_START_ROUTE,
  handleLinkComplete,
  handleLinkStart,
  type AccountLinkDeps,
} from "./account-link";
export { ACCOUNT_LINK_COMPLETE_ROUTE, ACCOUNT_LINK_START_ROUTE };
export const ACCOUNT_ROUTE = "/consumer/account" as const;
export const ACCOUNT_WALLET_REVOKE_ROUTE = "/consumer/account/wallets/:bindingId/revoke" as const;
export const ACCOUNT_MARKETPLACE_REVOKE_ROUTE = "/consumer/account/marketplace/:bindingId/revoke" as const;
export const ACCOUNT_CHANNEL_REVOKE_ROUTE = "/consumer/account/channels/:bindingId/revoke" as const;

/** Scopes a caller may ask for. An unknown scope is refused rather than silently dropped — a request
 *  that asked for something and got a session without it should be told, not quietly downgraded. */
const KNOWN_SCOPES = new Set<BindingScope>(["identity", "policy-authority"]);

export interface AccountRoutesDeps {
  readonly accounts: AccountStore;
  readonly links: LinkRequestStore;
  readonly verifier: SiweVerifier;
  /** The domain a SIWE message must name. A signature for another site must not work here. */
  readonly domain: string;
  readonly publicBaseUrl: string;
  /** Where a browser may be returned to after linking. Exact-origin matched, never prefix matched. */
  readonly allowedReturnOrigins: readonly string[];
  /** HMAC key for account session tokens. Absent ⇒ this instance cannot mint sessions. */
  readonly secret: string | null;
  readonly now?: () => number;
}

export function makeAccountRoutesDeps(args: {
  readonly pool: Pool;
  readonly verifier: SiweVerifier;
  readonly domain: string;
  readonly publicBaseUrl: string;
  readonly secret: string | null;
  readonly allowedReturnOrigins?: readonly string[];
}): AccountRoutesDeps {
  return {
    accounts: new PgAccountStore(args.pool),
    links: new PgLinkRequestStore(args.pool),
    verifier: args.verifier,
    domain: args.domain,
    publicBaseUrl: args.publicBaseUrl.replace(/\/+$/, ""),
    secret: args.secret,
    /**
     * A returnUrl is where a browser is sent holding a fresh session, so this list is an open-redirect
     * surface. The Railway host that used to be here has been released; a domain this project no
     * longer controls is one whoever registers it next would inherit.
     */
    allowedReturnOrigins: args.allowedReturnOrigins ?? [
      `https://${args.domain}`,
      "https://www.untch.xyz",
      "https://untch.xyz",
    ],
  };
}

const refuse = (
  status: number,
  code: string,
  message: string,
  /** Structured detail a caller can branch on. Never carries key material or an environment name. */
  extra: Record<string, unknown> = {},
): HandlerResult => ({
  status,
  body: { code, message, retryable: false, docsUrl: null, ...extra },
});

// ── redaction ────────────────────────────────────────────────────────────────

/**
 * What a binding looks like to its owner.
 *
 * The proof reference is deliberately absent. It is the consumed nonce — not secret exactly, but it is
 * the handle on a specific signature event, and a read surface that hands it back invites a client to
 * treat it as something to present. `verifiedAt` and `proofKind` say everything a user needs to answer
 * "is this really proven, and when".
 */
/**
 * The projections moved to `account-view.ts`, which imports no transport.
 *
 * The Cloudflare Worker serves the same account read and cannot import this module: Express drags
 * `raw-body` and `iconv-lite` into the bundle, and `iconv-lite` calls `require_streams(...)` at
 * module scope, which is not a function under workerd. Re-exported so this file's callers are
 * unchanged and there is still exactly one definition.
 */
import { publicAccount, publicChannel, publicMarketplace, publicWallet } from "./account-view";
export { publicAccount, publicChannel, publicMarketplace, publicWallet };

// ── the routes ───────────────────────────────────────────────────────────────

export function registerAccountRoutes(
  app: Express,
  send: (res: Response, r: HandlerResult) => void,
  deps: AccountRoutesDeps | null,
): void {
  if (!deps || !deps.secret) {
    const why = !deps
      ? "the Consumer Pack is not wired on this instance (DATABASE_URL unset)"
      : "this instance cannot mint account sessions (CONSUMER_AUTH_SECRET unset)";
    for (const p of [ACCOUNT_LINK_START_ROUTE, ACCOUNT_LINK_COMPLETE_ROUTE]) {
      app.post(p, (_req, res) => send(res, refuse(503, "ACCOUNT_LINK_UNAVAILABLE", why)));
    }
    app.get(ACCOUNT_ROUTE, (_req, res) => send(res, refuse(503, "ACCOUNT_LINK_UNAVAILABLE", why)));
    for (const p of [
      ACCOUNT_WALLET_REVOKE_ROUTE,
      ACCOUNT_MARKETPLACE_REVOKE_ROUTE,
      ACCOUNT_CHANNEL_REVOKE_ROUTE,
    ]) {
      app.post(p, (_req, res) => send(res, refuse(503, "ACCOUNT_LINK_UNAVAILABLE", why)));
    }
    return;
  }

  const d = deps;
  const secret = deps.secret;
  const now = (): number => d.now?.() ?? Date.now();

  /** The authenticated account, or the reason there is not one. Never a partial answer. */
  const sessionOf = (req: Request) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1];
    return openAccountSession(secret, bearer, now());
  };

  const authed = (
    req: Request,
    fn: (accountId: string, bindingId: string) => Promise<HandlerResult>,
  ): Promise<HandlerResult> => {
    const session = sessionOf(req);
    if (!session) {
      return Promise.resolve(
        refuse(
          401,
          "ACCOUNT_SESSION_REQUIRED",
          "this read is account-scoped: POST /consumer/account/link/start, sign the message with your " +
            "wallet, then POST /consumer/account/link/complete to obtain a session",
        ),
      );
    }
    return fn(session.accountId, session.bindingId);
  };

  /** The shared handlers' view of this instance. `now` is resolved here so tests can still inject one. */
  const linkDeps = (): AccountLinkDeps => ({
    accounts: d.accounts,
    links: d.links,
    verifier: d.verifier,
    domain: d.domain,
    publicBaseUrl: d.publicBaseUrl,
    allowedReturnOrigins: d.allowedReturnOrigins,
    secret,
    now,
  });

  const post = (path: string, handler: (req: Request) => Promise<HandlerResult>): void => {
    app.post(path, (req: Request, res: Response, next: NextFunction) => {
      handler(req)
        .then((r) => send(res, r))
        .catch(next);
    });
  };


const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** The chains this deployment will verify a sign-in against, in preference order. */
const SIGNABLE_CHAINS: readonly number[] = SIGNIN_CHAIN_IDS;

/**
 * Refuse an Untch operational address from becoming a user's wallet binding.
 *
 * `policy-authority` is refused outright: a policy owned by a deployer, treasury, oracle, writer or
 * operator key is owned by Untch forever, because `registerPolicy` makes `msg.sender` the owner with
 * no relayer and no transfer. Binding one with that scope is the step immediately before the mistake.
 *
 * `identity` alone is refused too, and the reason is narrower than it looks. Any identity binding can
 * later be granted policy authority, and an operational address sitting in the account table as a
 * legitimate wallet is exactly the state in which somebody grants it. If an operator ever genuinely
 * needs one bound, that is a deliberate act with a human in it, not something a sign-in does.
 *
 * The roles come from `@untch/shared`, which is the same registry the policy draft and the deploy
 * scripts read. A second hardcoded copy here would be a list that drifts, and a drifted guard is one
 * that stops firing on precisely the address someone added last.
 */
function roleCollision(address: string, scopes: readonly BindingScope[]): HandlerResult | null {
  const roles = rolesOf(address);
  if (roles.length === 0) return null;
  return refuse(
    409,
    "ROLE_COLLISION",
    `${address} is an Untch operational address (${roles.map((r) => r.role).join(" and ")}) and cannot be ` +
      `bound as a user wallet. ${roles[0]?.what ?? ""}`,
    {
      // Named, never described vaguely: an operator debugging this needs to know WHICH role. No key
      // material, no environment variable name and no secret is involved — these addresses are public.
      conflictingRoles: roles.map((r) => ({ role: r.role, what: r.what })),
      requestedScopes: scopes,
      resolution:
        "Sign in with a wallet that has no operational role here. Binding an operational key is a " +
        "deliberate administrative act, not something a sign-in performs.",
    },
  );
}

  // ── start ──────────────────────────────────────────────────────────────────

  /**
   * Both link handlers now live in `account-link.ts`, with no transport in them.
   *
   * They are the head of the account chain and the Cloudflare Worker needs the same ones — it cannot
   * import this file, because Express drags `iconv-lite` into a bundle where its module-scope
   * `require_streams(...)` is not a function. Calling one shared implementation is what keeps the two
   * transports from disagreeing about what a single signature establishes.
   */
  post(ACCOUNT_LINK_START_ROUTE, (req) =>
    handleLinkStart(req.body, linkDeps(), req.header("x-request-id") ?? null),
  );
  post(ACCOUNT_LINK_COMPLETE_ROUTE, (req) => handleLinkComplete(req.body, linkDeps()));

  // ── read ───────────────────────────────────────────────────────────────────

  app.get(ACCOUNT_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    authed(req, async (accountId) => {
      const account = await d.accounts.getAccount(accountId);
      if (!account) return refuse(404, "ACCOUNT_NOT_FOUND", `no account ${accountId}`);
      const [wallets, marketplace, channels] = await Promise.all([
        d.accounts.walletsFor(accountId),
        d.accounts.marketplaceBindingsFor(accountId),
        d.accounts.channelsFor(accountId),
      ]);
      return { status: 200, body: publicAccount(account, wallets, marketplace, channels) };
    })
      .then((r) => send(res, r))
      .catch(next);
  });

  // ── revoke ─────────────────────────────────────────────────────────────────

  /**
   * Revocation is authorised by OWNERSHIP of the binding, re-read at the moment it is used.
   *
   * The session says which account is asking; the binding row says which account it belongs to. A
   * binding id is opaque and unguessable, but "unguessable" is not an authorisation model — the
   * comparison is what stops one account revoking another's wallet by presenting an id it happened to
   * see in a log.
   */
  post(ACCOUNT_WALLET_REVOKE_ROUTE, (req) =>
    authed(req, async (accountId) => {
      const bindingId = req.params.bindingId ?? "";
      const binding = await d.accounts.walletBinding(bindingId);
      if (!binding || binding.accountId !== accountId) {
        return refuse(404, "BINDING_NOT_FOUND", `no wallet binding ${bindingId} on this account`);
      }
      const revoked = await d.accounts.revokeWallet({ bindingId, by: `account:${accountId}` });
      return {
        status: 200,
        body: {
          bindingId,
          revoked,
          status: "REVOKED",
          note: revoked
            ? "The binding is kept as evidence. It no longer authenticates, and it no longer counts " +
              "against the one-active-primary rule, so a replacement wallet can be bound."
            : "It was already revoked. Nothing changed.",
        },
      };
    }),
  );

  post(ACCOUNT_MARKETPLACE_REVOKE_ROUTE, (req) =>
    authed(req, async (accountId) => {
      const bindingId = req.params.bindingId ?? "";
      const owned = (await d.accounts.marketplaceBindingsFor(accountId)).some((m) => m.bindingId === bindingId);
      if (!owned) return refuse(404, "BINDING_NOT_FOUND", `no marketplace binding ${bindingId} on this account`);
      const revoked = await d.accounts.revokeMarketplace({ bindingId, by: `account:${accountId}` });
      return { status: 200, body: { bindingId, revoked, status: "REVOKED" } };
    }),
  );

  post(ACCOUNT_CHANNEL_REVOKE_ROUTE, (req) =>
    authed(req, async (accountId) => {
      const bindingId = req.params.bindingId ?? "";
      const owned = (await d.accounts.channelsFor(accountId)).some((c) => c.bindingId === bindingId);
      if (!owned) return refuse(404, "BINDING_NOT_FOUND", `no channel binding ${bindingId} on this account`);
      const revoked = await d.accounts.revokeChannel({ bindingId, by: `account:${accountId}` });
      return { status: 200, body: { bindingId, revoked, status: "REVOKED" } };
    }),
  );
}

function describeRedeemFailure(reason: string): string {
  switch (reason) {
    case "EXPIRED":
      return "that link request has expired; start a new one";
    case "ALREADY_COMPLETED":
      return "that link request was already completed; a one-time code is one-time";
    case "CANCELLED":
      return "that link request was cancelled";
    case "CODE_MISMATCH":
      return "the one-time code does not match this link request";
    case "TOO_MANY_ATTEMPTS":
      return "too many attempts on this link request; it has been cancelled — start a new one";
    default:
      return "that link request cannot be redeemed";
  }
}

export { buildLinkMessage };
