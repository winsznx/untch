/**
 * Linking the wallet Untch is actually for: the OKX Onchain OS Agentic Wallet.
 *
 * WHY THE EXISTING LINK ROUTES COULD NOT DO THIS
 *
 * `/consumer/account/link/*` assumes one browser: it starts a request, and the same browser returns
 * with a signature moments later. That is how an injected EIP-1193 provider works, and it is not how
 * the Agentic Wallet works at all. The Agentic Wallet is held in OKX's TEE, restored through email,
 * Google or Apple login, and reached through the `onchainos` CLI or skill. It is not injected into a
 * page. There is no provider to call. A browser flow built on `window.ethereum` reaches the OKX
 * browser EXTENSION, which is a different wallet product with different keys.
 *
 * So the shape here is different by necessity. A browser starts the request and then WAITS. An agent
 * — running wherever the user's Onchain OS session lives, which may be another machine entirely —
 * fetches the challenge, shows it to the user, signs inside the TEE, and posts the signature back.
 * The browser learns it worked by polling.
 *
 * WHAT IS UNCHANGED, AND DELIBERATELY SO
 *
 * All of the cryptography. Server-authored message, server-minted single-use nonce, ten-minute
 * expiry, domain binding, chain binding, scope Resources, signature recovery, replay refusal, and the
 * operational-address collision check. Only the TRANSPORT changed: how the challenge reaches a wallet
 * and how the signature comes back. Rebuilding the proof for a new transport would have been the
 * mistake, because the proof was never the part that was wrong.
 *
 * WHAT IS NEVER STORED
 *
 * No email, OTP, login session, API secret, mnemonic, key or reusable credential of any kind. Email
 * authenticates access to the wallet AT OKX. It is not spending authority here, and there is nowhere
 * in this schema to put it.
 */

import type { Express, Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import {
  newWalletBindingId,
  type AccountStore,
  type AgenticWalletFacts,
  type BindingScope,
  type LinkRequestStore,
} from "@untch/consumer-core";
import { rolesOf, SIGNIN_CHAIN_IDS } from "@untch/shared";
import type { HandlerResult } from "../handlers";
import { buildLinkMessage, mintAccountSession, verifyWalletProof } from "./account-auth";
import type { SiweVerifier } from "./auth";

export const AGENTIC_LINK_START_ROUTE = "/consumer/account/agentic-link/start" as const;
export const AGENTIC_LINK_CHALLENGE_ROUTE = "/consumer/account/agentic-link/:linkRequestId/challenge" as const;
export const AGENTIC_LINK_COMPLETE_ROUTE = "/consumer/account/agentic-link/:linkRequestId/complete" as const;
export const AGENTIC_LINK_STATUS_ROUTE = "/consumer/account/agentic-link/:linkRequestId/status" as const;

export interface AgenticLinkDeps {
  readonly accounts: AccountStore;
  readonly links: LinkRequestStore;
  readonly verifier: SiweVerifier;
  readonly domain: string;
  readonly publicBaseUrl: string;
  readonly webBaseUrl: string;
  readonly secret: string;
  readonly now?: () => number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const KNOWN_SCOPES = new Set<BindingScope>(["identity", "policy-authority"]);

const refuse = (
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HandlerResult => ({ status, body: { code, message, retryable: false, docsUrl: null, ...extra } });

/**
 * The operational-address guard, shared by both points it must fire at.
 *
 * Named at the challenge step so the user is told before their wallet ever prompts, and enforced at
 * completion against the address the SIGNATURE produced, which is the only one this server has not
 * taken somebody's word for.
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
      conflictingRoles: roles.map((r) => ({ role: r.role, what: r.what })),
      requestedScopes: scopes,
      resolution:
        "Use an Agentic Wallet with no operational role here. Binding an operational key is a deliberate " +
        "administrative act, not something a link performs.",
    },
  );
}

/** Every status a polling browser may see, and nothing that is not one of them. */
export type AgenticLinkStatus =
  | "WAITING_FOR_AGENT"
  | "WAITING_FOR_SIGNATURE"
  | "LINKED"
  | "EXPIRED"
  | "REFUSED";

export function registerAgenticLinkRoutes(
  app: Express,
  send: (res: Response, r: HandlerResult) => void,
  deps: AgenticLinkDeps | null,
): void {
  if (!deps) {
    const why = "agentic wallet linking is not wired on this instance (DATABASE_URL or CONSUMER_AUTH_SECRET unset)";
    for (const p of [AGENTIC_LINK_START_ROUTE, AGENTIC_LINK_COMPLETE_ROUTE]) {
      app.post(p, (_req, res) => send(res, refuse(503, "AGENTIC_LINK_UNAVAILABLE", why)));
    }
    for (const p of [AGENTIC_LINK_CHALLENGE_ROUTE, AGENTIC_LINK_STATUS_ROUTE]) {
      app.get(p, (_req, res) => send(res, refuse(503, "AGENTIC_LINK_UNAVAILABLE", why)));
    }
    return;
  }

  const d = deps;
  const now = (): number => d.now?.() ?? Date.now();

  const route = (
    method: "get" | "post",
    path: string,
    handler: (req: Request) => Promise<HandlerResult>,
  ): void => {
    app[method](path, (req: Request, res: Response, next: NextFunction) => {
      handler(req)
        .then((r) => send(res, r))
        .catch(next);
    });
  };

  // ── start ──────────────────────────────────────────────────────────────────

  route("post", AGENTIC_LINK_START_ROUTE, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const requested = Array.isArray(b.requestedScopes) ? (b.requestedScopes as unknown[]) : ["identity"];
    const scopes: BindingScope[] = [];
    for (const s of requested) {
      if (typeof s !== "string" || !KNOWN_SCOPES.has(s as BindingScope)) {
        return refuse(400, "UNKNOWN_SCOPE", `requestedScopes may contain only ${[...KNOWN_SCOPES].join(", ")}`);
      }
      scopes.push(s as BindingScope);
    }
    if (scopes.length === 0) scopes.push("identity");

    const { request } = await d.links.create({
      requestedScopes: scopes,
      context: {
        marketplace: typeof b.marketplace === "string" ? b.marketplace : null,
        marketplaceAgentId: typeof b.marketplaceAgentId === "string" ? b.marketplaceAgentId : null,
        marketplaceBuyerId: null,
        taskRef: null,
        serviceOrderRef: null,
      },
      returnUrl: null,
      siweNonce: randomBytes(16).toString("hex"),
      sourceRequestId: req.header("x-request-id") ?? null,
      nowMs: now(),
      by: "agentic-link",
      linkKind: "agentic",
    });

    const linkUrl = `${d.webBaseUrl}/link/${request.linkRequestId}`;

    return {
      status: 200,
      body: {
        linkRequestId: request.linkRequestId,
        /**
         * NO one-time code here.
         *
         * The browser flow returns one because the browser is what completes it. An agentic request is
         * completed by an agent that fetches the challenge from a URL, and a code travelling through a
         * copy-pasted prompt would be a bearer secret in a chat log. The request id is the handle; the
         * SIGNATURE is the authority, and there is nothing else to steal.
         */
        linkUrl,
        expiresAt: request.expiresAt,
        requestedScopes: request.requestedScopes,
        pollUrl: `${d.publicBaseUrl}/consumer/account/agentic-link/${request.linkRequestId}/status`,
        challengeUrl: `${d.publicBaseUrl}/consumer/account/agentic-link/${request.linkRequestId}/challenge`,
        purpose:
          "Link your OKX Onchain OS Agentic Wallet to an Untch account. One signature. It proves which " +
          "wallet you are and approves no payment.",
        // What a user pastes into whatever agent holds their Onchain OS session. Written as an
        // instruction to an agent rather than a command, because the agent knows its own CLI and the
        // exact invocation belongs to the skill, not to this response.
        agentPrompt:
          `Link my OKX Agentic Wallet to Untch. Use the Untch link request ${request.linkRequestId} at ` +
          `${d.publicBaseUrl}. Fetch the challenge, show me the exact message and the address it will be ` +
          `signed with, wait for me to confirm, sign it with my Agentic Wallet, then submit the signature.`,
        walletProduct: {
          expected: "OKX Onchain OS Agentic Wallet (TEE-held, restored by email, Google or Apple login)",
          notExpected:
            "A browser extension wallet. This flow does not use window.ethereum and cannot be completed by one.",
        },
      },
    };
  });

  // ── challenge ──────────────────────────────────────────────────────────────

  /**
   * The exact message, fetched by the agent.
   *
   * `address` is a query parameter rather than a body field because this is a GET the agent may
   * legitimately repeat: a user who switches sub-wallet re-fetches with a different address and gets a
   * message naming the new one. The nonce does not change, so the request is still one request.
   */
  route("get", AGENTIC_LINK_CHALLENGE_ROUTE, async (req) => {
    const linkRequestId = req.params.linkRequestId ?? "";
    const request = await d.links.get(linkRequestId);
    if (!request) return refuse(404, "LINK_REQUEST_NOT_FOUND", `no link request ${linkRequestId}`);
    if (request.linkKind !== "agentic") {
      return refuse(
        409,
        "LINK_KIND_MISMATCH",
        "that link request was started for a browser wallet. An agentic challenge cannot be issued for it, " +
          "because completing it through this path would let a different wallet product satisfy the flow the " +
          "user started.",
      );
    }
    if (request.status !== "PENDING") {
      return refuse(409, "LINK_REQUEST_NOT_PENDING", `link request ${linkRequestId} is ${request.status}`);
    }
    if (Date.parse(request.expiresAt) <= now()) {
      return refuse(410, "LINK_REQUEST_EXPIRED", `link request ${linkRequestId} expired at ${request.expiresAt}`);
    }

    const raw = typeof req.query.address === "string" ? req.query.address : null;
    if (raw !== null && !ADDRESS_RE.test(raw)) {
      return refuse(400, "ADDRESS_INVALID", "address must be a 20-byte hex address");
    }
    if (raw !== null) {
      const collision = roleCollision(raw, request.requestedScopes as readonly BindingScope[]);
      if (collision) return collision;
    }

    const chainId = SIGNIN_CHAIN_IDS[0] as number;
    const message =
      raw === null
        ? null
        : buildLinkMessage({
            domain: d.domain,
            uri: d.publicBaseUrl,
            address: raw,
            chainId,
            nonce: request.siweNonce,
            issuedAt: new Date(now()).toISOString(),
            expiresAt: request.expiresAt,
            scopes: request.requestedScopes,
          });

    if (raw !== null) await d.links.markChallengeFetched({ linkRequestId, expectedAddress: raw, nowMs: now() });

    return {
      status: 200,
      body: {
        linkRequestId,
        // Null until the agent names the address. A message with a placeholder in it would look
        // signable and would not be, which is worse than no message at all.
        message,
        expectedAddress: raw,
        chainId,
        domain: d.domain,
        nonce: request.siweNonce,
        expiresAt: request.expiresAt,
        requestedScopes: request.requestedScopes,
        signWith: {
          product: "OKX Onchain OS Agentic Wallet",
          capability: "wallet sign-message",
          type: "personal",
          note: "personalSign (EIP-191) over the exact message above. Do not reformat it, and do not compose one.",
        },
        creates: [
          "an UntchAccount, or resolves the one this wallet already is",
          "an ACTIVE AgenticWalletBinding recording the wallet product, the chain and the challenge",
          ...(request.requestedScopes.includes("policy-authority")
            ? ["permission for this wallet to own and register spend policies"]
            : []),
        ],
        doesNotAuthorize: [
          "any payment, transfer or spending approval",
          "any on-chain transaction",
          "any marketplace identity that is proven rather than claimed",
          "any reuse: the nonce is single-use and the message expires",
        ],
        ifAddressMissing:
          raw === null
            ? "Call again with ?address=<the Agentic Wallet EVM address> to receive the exact message to sign."
            : null,
      },
    };
  });

  // ── complete ───────────────────────────────────────────────────────────────

  route("post", AGENTIC_LINK_COMPLETE_ROUTE, async (req) => {
    const linkRequestId = req.params.linkRequestId ?? "";
    const b = (req.body ?? {}) as Record<string, unknown>;
    const address = typeof b.address === "string" ? b.address : null;
    const signature = typeof b.signature === "string" ? b.signature : null;
    const message = typeof b.message === "string" ? b.message : null;

    if (!address || !signature || !message) {
      return refuse(400, "AGENTIC_LINK_BAD_REQUEST", "address, message and signature are all required");
    }
    if (!ADDRESS_RE.test(address)) return refuse(400, "ADDRESS_INVALID", "address must be a 20-byte hex address");

    const request = await d.links.get(linkRequestId);
    if (!request) return refuse(404, "LINK_REQUEST_NOT_FOUND", `no link request ${linkRequestId}`);
    if (request.linkKind !== "agentic") {
      return refuse(409, "LINK_KIND_MISMATCH", "that link request was not started for an Agentic Wallet");
    }
    if (request.status !== "PENDING") {
      return refuse(409, "LINK_REQUEST_NOT_PENDING", `link request ${linkRequestId} is ${request.status}`);
    }

    /**
     * The signature is verified before anything is consumed.
     *
     * A wrong signature must not burn the request, or an interceptor could destroy an honest user's
     * link by submitting garbage and the user would be told their own valid signature came too late.
     */
    const proof = await verifyWalletProof(
      { message, signature: signature as Hex, expectedNonce: request.siweNonce, domain: d.domain, nowMs: now() },
      d.verifier,
    );
    if (!proof.ok) return refuse(401, proof.code, proof.reason);

    /**
     * The recovered address must be the one the BROWSER was shown.
     *
     * Without this, an agent could display one wallet to the user during confirmation and submit a
     * signature from another. The comparison is against `expectedAddress`, which was recorded when the
     * challenge was fetched — that is what the user saw.
     */
    if (proof.proof.address.toLowerCase() !== address.toLowerCase()) {
      return refuse(
        401,
        "SIGNER_MISMATCH",
        `the signature recovers to ${proof.proof.address}, not the ${address} it was submitted for`,
      );
    }
    if (request.expectedAddress && request.expectedAddress.toLowerCase() !== proof.proof.address.toLowerCase()) {
      return refuse(
        409,
        "SIGNER_NOT_THE_ONE_SHOWN",
        `this link was presented for ${request.expectedAddress} and the signature is from ${proof.proof.address}. ` +
          "The wallet that signs must be the wallet the user was shown.",
      );
    }

    const collision = roleCollision(proof.proof.address, request.requestedScopes as readonly BindingScope[]);
    if (collision) return collision;

    const existing = await d.accounts.accountForWallet("evm", proof.proof.address);
    const account = existing ?? (await d.accounts.createAccount({ by: "agentic-wallet" }));
    if (account.status !== "ACTIVE") {
      return refuse(403, "ACCOUNT_NOT_ACTIVE", `account ${account.accountId} is ${account.status}`);
    }

    /**
     * Consumed on the signature, not on a code.
     *
     * A code proves you saw a screen. A signature over this request's own single-use nonce, from the
     * address the browser was shown, proves you hold the key. The agentic flow has the second and
     * deliberately does not mint the first, because a code copied into an agent prompt is a bearer
     * secret in a chat log.
     */
    const redeemed = await d.links.redeemVerified({
      linkRequestId,
      accountId: account.accountId,
      nowMs: now(),
      by: `agentic:${proof.proof.address}`,
    });
    if (!redeemed.ok) {
      const status = redeemed.reason === "NOT_FOUND" ? 404 : redeemed.reason === "EXPIRED" ? 410 : 409;
      return refuse(status, `LINK_${redeemed.reason}`, `link request ${linkRequestId} could not be consumed`);
    }

    const meta = (typeof b.agentic === "object" && b.agentic !== null ? b.agentic : {}) as Record<string, unknown>;
    const authMethod = typeof meta.authMethod === "string" ? meta.authMethod : null;
    const agentic: AgenticWalletFacts = {
      accountRef: typeof meta.accountRef === "string" ? meta.accountRef : null,
      selectedWallet: typeof meta.selectedWallet === "string" ? meta.selectedWallet : null,
      authMethod: authMethod === "email" || authMethod === "google" || authMethod === "apple" ? authMethod : null,
      solanaAddress: typeof meta.solanaAddress === "string" ? meta.solanaAddress : null,
      toolVersion: typeof meta.toolVersion === "string" ? meta.toolVersion : null,
    };

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
      walletProvider: "okx-agentic-wallet",
      scopes: request.requestedScopes as readonly BindingScope[],
      verifiedAt: new Date(now()).toISOString(),
      bindingKind: "agentic",
      agentic,
      challengeRef: linkRequestId,
      challengeTransport: "agent-cli",
      by: "agentic-wallet",
    });
    if (!bound) {
      return refuse(
        409,
        "WALLET_BOUND_ELSEWHERE",
        `${proof.proof.address} is already the authority of another Untch account. Moving a wallet between ` +
          "accounts is a recovery operation and is not performed by linking.",
      );
    }

    await d.accounts.setPrimaryWallet({ accountId: account.accountId, bindingId, by: "agentic-wallet" });
    await d.accounts.recordAuthentication({ accountId: account.accountId, by: "agentic-wallet" });

    const { token } = mintAccountSession({
      secret: d.secret,
      accountId: account.accountId,
      address: proof.proof.address,
      bindingId,
      scopes: request.requestedScopes as readonly BindingScope[],
      nowMs: now(),
    });

    return {
      status: 200,
      body: {
        status: "LINKED",
        accountId: account.accountId,
        bindingId,
        address: proof.proof.address,
        bindingKind: "agentic",
        walletProduct: "OKX Onchain OS Agentic Wallet",
        scopes: request.requestedScopes,
        restored: existing !== null,
        // The session goes to the AGENT that completed the link. The browser polls status and does its
        // own thing with the result; it never receives this token through the poll.
        token,
        paid: false,
        note: "Nothing was paid and no transaction was made. This binding proves which wallet owns the account.",
      },
    };
  });

  // ── status ─────────────────────────────────────────────────────────────────

  /**
   * What the browser polls.
   *
   * Deliberately unauthenticated and deliberately thin: a link request id is an opaque 130-bit value
   * and the only thing this reveals about it is how far along it is. It never returns the session
   * token, the nonce, or the account id — a poller that could read those would be a poller that could
   * steal a link by guessing an id.
   */
  route("get", AGENTIC_LINK_STATUS_ROUTE, async (req) => {
    const linkRequestId = req.params.linkRequestId ?? "";
    const request = await d.links.get(linkRequestId);
    if (!request) return refuse(404, "LINK_REQUEST_NOT_FOUND", `no link request ${linkRequestId}`);

    let status: AgenticLinkStatus;
    if (request.status === "COMPLETED") status = "LINKED";
    else if (request.status === "CANCELLED") status = "REFUSED";
    else if (request.status === "EXPIRED" || Date.parse(request.expiresAt) <= now()) status = "EXPIRED";
    else status = request.agentStage === "WAITING_FOR_SIGNATURE" ? "WAITING_FOR_SIGNATURE" : "WAITING_FOR_AGENT";

    return {
      status: 200,
      body: {
        linkRequestId,
        status,
        // Shown so the browser can display the wallet the agent resolved BEFORE a signature exists.
        // It is a public address, and the user is the one who chose it.
        expectedAddress: request.expectedAddress,
        requestedScopes: request.requestedScopes,
        expiresAt: request.expiresAt,
        challengeFetchedAt: request.challengeFetchedAt,
        hint:
          status === "WAITING_FOR_AGENT"
            ? "No agent has fetched the challenge yet. Paste the prompt into the agent holding your Onchain OS session."
            : status === "WAITING_FOR_SIGNATURE"
              ? "The agent has the challenge. Review the message it shows you, then confirm the signature."
              : null,
      },
    };
  });
}
