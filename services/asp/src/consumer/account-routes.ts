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

export const ACCOUNT_LINK_START_ROUTE = "/consumer/account/link/start" as const;
export const ACCOUNT_LINK_COMPLETE_ROUTE = "/consumer/account/link/complete" as const;
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
    allowedReturnOrigins: args.allowedReturnOrigins ?? [
      `https://${args.domain}`,
      "https://www.untch.xyz",
      "https://untch-web-production.up.railway.app",
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

  post(ACCOUNT_LINK_START_ROUTE, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;

    const requested = Array.isArray(b.requestedScopes) ? (b.requestedScopes as unknown[]) : ["identity"];
    const scopes: BindingScope[] = [];
    for (const s of requested) {
      if (typeof s !== "string" || !KNOWN_SCOPES.has(s as BindingScope)) {
        return refuse(
          400,
          "UNKNOWN_SCOPE",
          `requestedScopes may contain only ${[...KNOWN_SCOPES].join(", ")}; received ${JSON.stringify(s)}`,
        );
      }
      scopes.push(s as BindingScope);
    }
    if (scopes.length === 0) scopes.push("identity");

    const returnUrl = typeof b.returnUrl === "string" ? b.returnUrl : null;
    if (returnUrl !== null && !returnUrlAllowed(returnUrl, d.allowedReturnOrigins)) {
      // An attacker-chosen return URL turns this into an open redirect with a session at the end of it.
      return refuse(
        400,
        "RETURN_URL_NOT_ALLOWED",
        `returnUrl must be an exact origin match for one of: ${d.allowedReturnOrigins.join(", ")}`,
      );
    }

    /**
     * The message the server will verify, composed by the server.
     *
     * `buildLinkMessage` was exported and every caller was expected to reproduce it: the domain, the
     * scope Resources lines, the issued/expiry stamps, the exact wording. A client that formats one
     * line differently produces a signature over a message this server never authored, and the
     * failure surfaces as an opaque signature rejection rather than as the drift it is.
     *
     * So when the caller names the address it is about to sign with, the server returns the finished
     * message. `address` stays optional, because a caller may legitimately not know it yet (a
     * marketplace starting a link for a wallet that will open the page later), and that path still
     * gets the nonce and the domain to build one with.
     */
    const addressForMessage = typeof b.address === "string" && ADDRESS_RE.test(b.address) ? b.address : null;
    const chainForMessage =
      typeof b.chainId === "number" && SIGNABLE_CHAINS.includes(b.chainId) ? b.chainId : SIGNABLE_CHAINS[0];

    /**
     * An operational address is refused at START when it is named, so the user is told before their
     * wallet ever opens a prompt rather than after they have signed. The authoritative check is at
     * COMPLETE, against the address recovered from the signature, because that is the only address
     * this server did not take somebody's word for.
     *
     * It runs BEFORE the link request is created. The first version checked after `links.create`, so
     * every refused probe left a PENDING row that expired unused. Harmless — the one-time code is never
     * disclosed on the refusal path — but a refusal that still writes a row is a refusal that can be
     * used to fill a table.
     */
    if (addressForMessage !== null) {
      const collision = roleCollision(addressForMessage, scopes);
      if (collision) return collision;
    }


    const marketplace = typeof b.marketplace === "string" ? b.marketplace : b.marketplaceAgentId ? "okx" : null;
    const nonce = randomBytes(16).toString("hex");
    const { request, code } = await d.links.create({
      requestedScopes: scopes,
      context: {
        marketplace,
        marketplaceAgentId: typeof b.marketplaceAgentId === "string" ? b.marketplaceAgentId : null,
        marketplaceBuyerId: typeof b.marketplaceBuyerId === "string" ? b.marketplaceBuyerId : null,
        taskRef: typeof b.taskRef === "string" ? b.taskRef : null,
        serviceOrderRef: typeof b.serviceOrderRef === "string" ? b.serviceOrderRef : null,
      },
      returnUrl,
      siweNonce: nonce,
      sourceRequestId: req.header("x-request-id") ?? null,
      nowMs: now(),
      by: marketplace ? `marketplace:${marketplace}` : "web",
    });

    const siweMessage =
      addressForMessage === null
        ? null
        : buildLinkMessage({
            domain: d.domain,
            uri: d.publicBaseUrl,
            address: addressForMessage,
            chainId: chainForMessage as number,
            nonce: request.siweNonce,
            issuedAt: new Date(now()).toISOString(),
            expiresAt: request.expiresAt,
            scopes: request.requestedScopes,
          });

    return {
      status: 200,
      body: {
        linkRequestId: request.linkRequestId,
        // Returned exactly once. It is stored hashed, so no later read of any kind can produce it.
        oneTimeCode: code,
        expiresAt: request.expiresAt,
        proofMethod: "siwe-personal-sign",
        // Null when no address was named. Never a template with a placeholder in it: a message that
        // looks signable and is not is worse than an absent one.
        siweMessage,
        /** Exactly what this one signature will establish, for a UI to show before prompting. */
        authorityRequested: {
          signatures: 1,
          format: "SIWE (EIP-4361) over personal_sign (EIP-191)",
          address: addressForMessage,
          chainId: chainForMessage,
          domain: d.domain,
          scopes: request.requestedScopes,
          expiresAt: request.expiresAt,
          creates: [
            "an UntchAccount, or resolves the one this wallet already is",
            "an ACTIVE WalletBinding with proofKind=siwe and role=primary",
            ...(request.requestedScopes.includes("policy-authority" as BindingScope)
              ? ["permission for this wallet to own and register spend policies"]
              : []),
          ],
          doesNotCreate: [
            "any payment, approval or spending authority",
            "any on-chain transaction",
            "any marketplace binding that is proven rather than claimed",
          ],
        },
        // What the wallet is asked for, named precisely. `wallet sign-message --type personal` is the
        // documented Agentic Wallet capability this consumes; no transaction and no new contract.
        walletAction: {
          kind: "sign-message",
          signatureAlgorithm: "personal_sign (EIP-191)",
          chains: [196, 1952],
          nonce: request.siweNonce,
          domain: d.domain,
        },
        walletActionUrl: `${d.publicBaseUrl}/link/${request.linkRequestId}`,
        requestedScopes: request.requestedScopes,
        marketplaceContext: {
          ...request.context,
          // Said out loud on the way out, so nothing downstream can mistake the echo for a fact.
          note: "Recorded as context only. A marketplace identity authorises nothing until a wallet signs for it.",
        },
        instructions: [
          `1. Open ${d.publicBaseUrl}/link/${request.linkRequestId} with the wallet you want this account to be.`,
          "2. Sign the message shown there. It proves who you are and approves no payment.",
          "3. The page completes the link for you. If you are driving this by API, POST the message, the " +
            "signature and the one-time code to /consumer/account/link/complete.",
        ],
        note: "This code binds an identity. It cannot approve a payment: no route reachable from it takes an amount.",
      },
    };
  });

  // ── complete ───────────────────────────────────────────────────────────────

  post(ACCOUNT_LINK_COMPLETE_ROUTE, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const linkRequestId = typeof b.linkRequestId === "string" ? b.linkRequestId : null;
    const code = typeof b.code === "string" ? b.code : typeof b.oneTimeCode === "string" ? b.oneTimeCode : null;
    const message = typeof b.message === "string" ? b.message : null;
    const signature = typeof b.signature === "string" ? b.signature : null;

    if (!linkRequestId || !code || !message || !signature) {
      return refuse(
        400,
        "LINK_BAD_REQUEST",
        "linkRequestId, code, message (the SIWE message) and signature are all required",
      );
    }

    const request = await d.links.get(linkRequestId);
    if (!request) return refuse(404, "LINK_REQUEST_NOT_FOUND", `no link request ${linkRequestId}`);
    if (request.status !== "PENDING") {
      return refuse(409, "LINK_REQUEST_NOT_PENDING", `link request ${linkRequestId} is ${request.status}`);
    }

    /**
     * The signature is verified BEFORE the code is redeemed.
     *
     * Redemption is what consumes the request, and a wrong signature must not consume it — otherwise a
     * caller who intercepted the code could burn the honest user's request by submitting garbage, and
     * the user would be told their own valid signature came too late. The attempt counter is what
     * bounds guessing at the code; the signature check is what decides whether this is the right
     * person at all, and it costs nothing to be wrong about.
     */
    const proof = await verifyWalletProof(
      {
        message,
        signature: signature as Hex,
        expectedNonce: request.siweNonce,
        domain: d.domain,
        nowMs: now(),
      },
      d.verifier,
    );
    if (!proof.ok) return refuse(401, proof.code, proof.reason);

    /**
     * The authoritative refusal, on the address the SIGNATURE produced.
     *
     * A start-time check reads an address the caller typed. This one reads the address that actually
     * signed, which is the only address this server has not taken somebody's word for. It runs after
     * verification and before any account or binding is created, so a refused operational key leaves
     * nothing behind.
     */
    const collision = roleCollision(proof.proof.address, request.requestedScopes as readonly BindingScope[]);
    if (collision) return collision;

    // The account this wallet ALREADY is, if any. This is what makes the flow a restoration rather
    // than an account factory: signing in twice with the same wallet reaches the same account.
    const existing = await d.accounts.accountForWallet("evm", proof.proof.address);
    const account =
      existing ??
      (await d.accounts.createAccount({ by: `siwe:${request.context.marketplace ?? "web"}` }));

    if (account.status !== "ACTIVE") {
      return refuse(403, "ACCOUNT_NOT_ACTIVE", `account ${account.accountId} is ${account.status}`);
    }

    const redeemed = await d.links.redeem({
      linkRequestId,
      code,
      accountId: account.accountId,
      nowMs: now(),
      by: `siwe:${proof.proof.address}`,
    });
    if (!redeemed.ok) {
      const status = redeemed.reason === "NOT_FOUND" ? 404 : redeemed.reason === "CODE_MISMATCH" ? 401 : 409;
      return refuse(status, `LINK_${redeemed.reason}`, describeRedeemFailure(redeemed.reason));
    }

    const bindingId = existing?.primaryWalletBindingId ?? newWalletBindingId();
    const { bound } = await d.accounts.linkWallet({
      bindingId,
      accountId: account.accountId,
      chainKind: "evm",
      address: proof.proof.address,
      role: "primary",
      proofKind: "siwe",
      proofRef: request.siweNonce,
      proofChainId: proof.proof.chainId,
      walletProvider: typeof b.walletProvider === "string" ? b.walletProvider : "okx-agentic-wallet",
      scopes: request.requestedScopes as readonly BindingScope[],
      verifiedAt: new Date(now()).toISOString(),
      by: "siwe",
    });
    if (!bound) {
      // The address is bound to a DIFFERENT account. Moving it is a recovery operation with a human in
      // it, never a side effect of signing in.
      return refuse(
        409,
        "WALLET_BOUND_ELSEWHERE",
        `${proof.proof.address} is already the authority of another Untch account; moving a wallet ` +
          "between accounts is a recovery operation and is not performed by signing in",
      );
    }

    await d.accounts.setPrimaryWallet({ accountId: account.accountId, bindingId, by: "siwe" });
    await d.accounts.recordAuthentication({ accountId: account.accountId, by: "siwe" });

    // ── the marketplace binding, now that a wallet has actually signed ───────
    let marketplaceBinding: MarketplaceBinding | null = null;
    const ctx = request.context;
    if (ctx.marketplace && ctx.marketplaceAgentId) {
      const result = await d.accounts.linkMarketplace({
        accountId: account.accountId,
        marketplace: ctx.marketplace,
        agentId: ctx.marketplaceAgentId,
        buyerId: ctx.marketplaceBuyerId,
        taskRef: ctx.taskRef,
        serviceOrderRef: ctx.serviceOrderRef,
        bindingMethod: "wallet-signature",
        provenBy: "wallet-signature",
        verifiedAt: new Date(now()).toISOString(),
        by: "siwe",
      });
      if (!result.bound) {
        return refuse(
          409,
          "MARKETPLACE_IDENTITY_BOUND_ELSEWHERE",
          `${ctx.marketplace} agent ${ctx.marketplaceAgentId} is already bound to a different Untch ` +
            "account; one marketplace identity cannot silently belong to two",
        );
      }
      marketplaceBinding =
        (await d.accounts.marketplaceBindingsFor(account.accountId)).find(
          (m) => m.marketplace === ctx.marketplace && m.agentId === ctx.marketplaceAgentId,
        ) ?? null;

      if (ctx.taskRef) {
        await d.accounts.recordJob({
          marketplace: ctx.marketplace,
          jobId: ctx.taskRef,
          accountId: account.accountId,
          agentId: ctx.marketplaceAgentId,
          by: "siwe",
        });
      }
    }

    const binding = await d.accounts.walletBinding(bindingId);
    const { token } = mintAccountSession({
      secret,
      accountId: account.accountId,
      address: proof.proof.address as Address,
      bindingId,
      scopes: binding?.scopes ?? ["identity"],
      nowMs: now(),
    });

    const fresh = await d.accounts.getAccount(account.accountId);
    return {
      status: 200,
      body: {
        accountId: account.accountId,
        accountCreated: existing === null,
        wallet: binding ? publicWallet(binding) : null,
        marketplaceBinding: marketplaceBinding ? publicMarketplace(marketplaceBinding) : null,
        session: { token, expiresIn: 1800, tokenType: "Bearer" },
        defaultPolicy: {
          policyId: fresh?.defaultPolicyId ?? null,
          // The honest next step, computed rather than assumed. An account with no policy cannot
          // preflight anything, and saying so here is cheaper than a refusal three calls later.
          status: fresh?.defaultPolicyId ? "SET" : "NOT_SET",
        },
        nextAction: fresh?.defaultPolicyId
          ? { code: "READY", message: "This account can preflight actions against its default policy." }
          : {
              code: "POLICY_REQUIRED",
              message:
                "This account holds no policy yet. POST /consumer/policies/draft to build one, then " +
                "register it from your own wallet — the owner of a policy must be the person it governs.",
            },
        returnUrl: request.returnUrl,
      },
    };
  });

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
