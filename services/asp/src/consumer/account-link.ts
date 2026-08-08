/**
 * Link start and link complete, with no transport in them.
 *
 * WHY THEY MOVED OUT OF `account-routes.ts`
 *
 * These two are the HEAD of the account chain: `/consumer/policies/draft` and `/consumer/policies/sync`
 * both require a session, and the only thing that mints one is a wallet signature completed here. The
 * Cloudflare Worker had the policy routes and the account reads but not these, so every account-scoped
 * route answered 401 to a caller who had no way to stop being anonymous. Migrating the middle of a
 * chain before its head moves the blocker rather than closing it — the same mistake, one level up,
 * that an independent buyer had already caught once.
 *
 * The Worker cannot import `account-routes.ts`: Express drags in `raw-body` and `iconv-lite`, and
 * `iconv-lite` calls `require_streams(...)` at module scope, which is not a function under workerd.
 * So the logic lives here, reads a plain body, and returns a `HandlerResult`. Express and the Worker
 * both call it, which is the only way the two transports cannot drift on what a signature establishes.
 *
 * Nothing here is a rewrite. The bodies are the ones that were serving on Express, with `req.body` and
 * one header turned into parameters.
 */

import { randomBytes } from "node:crypto";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  newWalletBindingId,
  returnUrlAllowed,
  type AccountStore,
  type BindingScope,
  type LinkRequestStore,
  type MarketplaceBinding,
} from "@untch/consumer-core";
import { rolesOf, SIGNIN_CHAIN_IDS } from "@untch/shared";
import type { HandlerResult } from "../handlers";
import { buildLinkMessage, mintAccountSession, verifyWalletProof } from "./account-auth";
import { publicMarketplace, publicWallet } from "./account-view";
import type { SiweVerifier } from "./siwe-verifier";

export const ACCOUNT_LINK_START_ROUTE = "/consumer/account/link/start" as const;
export const ACCOUNT_LINK_COMPLETE_ROUTE = "/consumer/account/link/complete" as const;

/** Scopes a caller may ask for. An unknown scope is refused rather than silently dropped — a request
 *  that asked for something and got a session without it should be told, not quietly downgraded. */
const KNOWN_SCOPES = new Set<BindingScope>(["identity", "policy-authority"]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The canonical form of an address, or null if it should not be accepted.
 *
 * A hex-shape test alone is not enough. viem parses the SIWE message at COMPLETE and rejects an
 * address whose mixed case is not a valid EIP-55 checksum, so one that passes `start` gets baked into
 * a message the user is told to sign and then throws inside verification — surfacing as an opaque 500
 * at the last step of a flow they had already committed a signature to.
 *
 * The rule follows what the case actually means:
 *
 *   • all-lowercase or all-uppercase carries NO checksum, so there is nothing to be wrong. Normalised,
 *     because a caller pasting a lowercase address has made no mistake.
 *   • mixed case IS a checksum, and one that fails is the signal EIP-55 exists to give: some digit is
 *     probably mistyped. Refused rather than normalised — case-correcting it would produce a
 *     valid-looking address while silently discarding the only evidence that it was wrong.
 *
 * `getAddress` cannot do this alone: it never throws for well-formed hex, it just recases. Reading it
 * as a validator is the mistake that made the first version of this function accept everything.
 */
function checksummed(value: string): Address | null {
  if (!ADDRESS_RE.test(value)) return null;
  const body = value.slice(2);
  const carriesChecksum = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (carriesChecksum && !isAddress(value, { strict: true })) return null;
  return getAddress(value);
}
/** The chains this deployment will verify a sign-in against, in preference order. */
const SIGNABLE_CHAINS: readonly number[] = SIGNIN_CHAIN_IDS;

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

export interface AccountLinkDeps {
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
  readonly now: () => number;
}

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

export async function handleLinkStart(
  body: unknown,
  deps: AccountLinkDeps,
  sourceRequestId?: string | null,
): Promise<HandlerResult> {
  const now = deps.now;

    const b = (body ?? {}) as Record<string, unknown>;

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
    if (returnUrl !== null && !returnUrlAllowed(returnUrl, deps.allowedReturnOrigins)) {
      // An attacker-chosen return URL turns this into an open redirect with a session at the end of it.
      return refuse(
        400,
        "RETURN_URL_NOT_ALLOWED",
        `returnUrl must be an exact origin match for one of: ${deps.allowedReturnOrigins.join(", ")}`,
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
    const addressForMessage = typeof b.address === "string" ? checksummed(b.address) : null;
    if (typeof b.address === "string" && addressForMessage === null) {
      return refuse(
        400,
        "ADDRESS_INVALID",
        `${b.address} is not a valid address. It must be 20 hex bytes, and if it carries mixed case ` +
          "that case must be a correct EIP-55 checksum.",
      );
    }
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
    const { request, code } = await deps.links.create({
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
      sourceRequestId: sourceRequestId ?? null,
      nowMs: now(),
      by: marketplace ? `marketplace:${marketplace}` : "web",
    });

    const siweMessage =
      addressForMessage === null
        ? null
        : buildLinkMessage({
            domain: deps.domain,
            uri: deps.publicBaseUrl,
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
          domain: deps.domain,
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
          domain: deps.domain,
        },
        /**
         * The code rides in the FRAGMENT, which browsers never send to a server.
         *
         * The page needs it to complete the link, and cannot look it up — the code is returned exactly
         * once and stored hashed. Putting it in the path or query would place a single-use credential
         * into our access logs and into `Referer` on every subsequent navigation. In the fragment it
         * reaches the page's JavaScript and nothing else.
         */
        walletActionUrl: `${deps.publicBaseUrl}/link/${request.linkRequestId}#${code}`,
        requestedScopes: request.requestedScopes,
        marketplaceContext: {
          ...request.context,
          // Said out loud on the way out, so nothing downstream can mistake the echo for a fact.
          note: "Recorded as context only. A marketplace identity authorises nothing until a wallet signs for it.",
        },
        instructions: [
          `1. Open ${deps.publicBaseUrl}/link/${request.linkRequestId} with the wallet you want this account to be.`,
          "2. Sign the message shown there. It proves who you are and approves no payment.",
          "3. The page completes the link for you. If you are driving this by API, POST the message, the " +
            "signature and the one-time code to /consumer/account/link/complete.",
        ],
        note: "This code binds an identity. It cannot approve a payment: no route reachable from it takes an amount.",
      },
    };
}

export async function handleLinkComplete(body: unknown, deps: AccountLinkDeps): Promise<HandlerResult> {
  const now = deps.now;

  /**
   * Refused up front when this instance cannot mint a session.
   *
   * On Express the narrowing was implicit: `registerAccountRoutes` answers 503 for every account route
   * when the secret is absent, so the handler below could never run without one. Moving the body out
   * of that function moved it out of that guarantee too, and completing a link only to discover at the
   * last line that no token can be issued would consume the user's one-time code and their signature
   * for nothing.
   */
  const secret = deps.secret;
  if (secret === null) {
    return refuse(
      503,
      "ACCOUNT_LINK_UNAVAILABLE",
      "this deployment holds no session secret and cannot complete a link; your one-time code is unused",
    );
  }

    const b = (body ?? {}) as Record<string, unknown>;
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

    const request = await deps.links.get(linkRequestId);
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
    /**
     * A message that cannot even be parsed is a refusal, not a crash.
     *
     * `verifyWalletProof` reaches viem, which throws on a malformed address or an unparseable SIWE
     * body rather than returning a verdict. Letting that escape turned "your message is wrong" into an
     * INTERNAL_ERROR with a request id, which tells the one person who could fix it nothing. The link
     * request is left PENDING either way — nothing is consumed until a signature actually verifies.
     */
    let proof: Awaited<ReturnType<typeof verifyWalletProof>>;
    try {
      proof = await verifyWalletProof(
        {
          message,
          signature: signature as Hex,
          expectedNonce: request.siweNonce,
          domain: deps.domain,
          nowMs: now(),
        },
        deps.verifier,
      );
    } catch (err) {
      return refuse(
        400,
        "SIWE_MESSAGE_UNPARSEABLE",
        `that message could not be read as a SIWE message: ${(err as Error).message.split("\n")[0]}`,
      );
    }
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
    const existing = await deps.accounts.accountForWallet("evm", proof.proof.address);
    const account =
      existing ??
      (await deps.accounts.createAccount({ by: `siwe:${request.context.marketplace ?? "web"}` }));

    if (account.status !== "ACTIVE") {
      return refuse(403, "ACCOUNT_NOT_ACTIVE", `account ${account.accountId} is ${account.status}`);
    }

    const redeemed = await deps.links.redeem({
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
    const { bound } = await deps.accounts.linkWallet({
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

    await deps.accounts.setPrimaryWallet({ accountId: account.accountId, bindingId, by: "siwe" });
    await deps.accounts.recordAuthentication({ accountId: account.accountId, by: "siwe" });

    // ── the marketplace binding, now that a wallet has actually signed ───────
    let marketplaceBinding: MarketplaceBinding | null = null;
    const ctx = request.context;
    if (ctx.marketplace && ctx.marketplaceAgentId) {
      const result = await deps.accounts.linkMarketplace({
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
        (await deps.accounts.marketplaceBindingsFor(account.accountId)).find(
          (m) => m.marketplace === ctx.marketplace && m.agentId === ctx.marketplaceAgentId,
        ) ?? null;

      if (ctx.taskRef) {
        await deps.accounts.recordJob({
          marketplace: ctx.marketplace,
          jobId: ctx.taskRef,
          accountId: account.accountId,
          agentId: ctx.marketplaceAgentId,
          by: "siwe",
        });
      }
    }

    const binding = await deps.accounts.walletBinding(bindingId);
    const { token } = mintAccountSession({
      secret,
      accountId: account.accountId,
      address: proof.proof.address as Address,
      bindingId,
      scopes: binding?.scopes ?? ["identity"],
      nowMs: now(),
    });

    const fresh = await deps.accounts.getAccount(account.accountId);
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
}

/**
 * The message this wallet should sign, authored by the server.
 *
 * WHY THIS ENDPOINT HAS TO EXIST
 *
 * `link/start` returns a finished message only when the caller already knows the address. A browser
 * does not: the wallet is chosen after the page loads. The page cannot build the message itself
 * either — `buildLinkMessage` composes the exact wording, the Resources lines and the stamps, and a
 * client that formats one line differently produces a signature over a message this server never
 * authored, surfacing as an opaque signature rejection rather than as the drift it is.
 *
 * WHY IT NEEDS NO SECRET
 *
 * It reveals the nonce, which authorises nothing on its own. Completing a link additionally requires
 * the one-time code, which is returned exactly once and stored hashed. So the worst an anonymous
 * caller gets is the text of a message they cannot use, for a request they cannot redeem.
 *
 * It does refuse a request that is not PENDING, so a spent or cancelled link cannot be re-presented
 * to a user as though it were still live.
 */
export async function handleLinkMessage(
  linkRequestId: string,
  body: unknown,
  deps: AccountLinkDeps,
): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const address = typeof b.address === "string" ? checksummed(b.address) : null;
  if (address === null) {
    return refuse(
      400,
      "ADDRESS_INVALID",
      "address must be 20 hex bytes, and if it carries mixed case that case must be a correct EIP-55 checksum",
    );
  }

  const request = await deps.links.get(linkRequestId);
  if (!request) return refuse(404, "LINK_REQUEST_NOT_FOUND", `no link request ${linkRequestId}`);
  if (request.status !== "PENDING") {
    return refuse(409, "LINK_REQUEST_NOT_PENDING", `link request ${linkRequestId} is ${request.status}`);
  }
  if (Date.parse(request.expiresAt) <= deps.now()) {
    return refuse(410, "LINK_REQUEST_EXPIRED", "that link request has expired; start a new one");
  }

  const collision = roleCollision(address, request.requestedScopes as readonly BindingScope[]);
  if (collision) return collision;

  const chainId =
    typeof b.chainId === "number" && SIGNABLE_CHAINS.includes(b.chainId) ? b.chainId : SIGNABLE_CHAINS[0];

  return {
    status: 200,
    body: {
      siweMessage: buildLinkMessage({
        domain: deps.domain,
        uri: deps.publicBaseUrl,
        address,
        chainId: chainId as number,
        nonce: request.siweNonce,
        issuedAt: new Date(deps.now()).toISOString(),
        expiresAt: request.expiresAt,
        scopes: request.requestedScopes,
      }),
      address,
      chainId,
      expiresAt: request.expiresAt,
      requestedScopes: request.requestedScopes,
    },
  };
}
