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

import {
  AGENTIC_LINK_CHALLENGE_ROUTE,
  AGENTIC_LINK_COMPLETE_ROUTE,
  AGENTIC_LINK_START_ROUTE,
  AGENTIC_LINK_STATUS_ROUTE,
  handleAgenticChallenge,
  handleAgenticComplete,
  handleAgenticStart,
  handleAgenticStatus,
  type AgenticLinkDeps as SharedAgenticLinkDeps,
} from "./agentic-link";
export {
  AGENTIC_LINK_CHALLENGE_ROUTE,
  AGENTIC_LINK_COMPLETE_ROUTE,
  AGENTIC_LINK_START_ROUTE,
  AGENTIC_LINK_STATUS_ROUTE,
};

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

  /** This instance's view, handed to the shared handlers. `now` stays injectable for tests. */
  const agenticDeps = (): SharedAgenticLinkDeps => ({
    accounts: d.accounts,
    links: d.links,
    verifier: d.verifier,
    domain: d.domain,
    publicBaseUrl: d.publicBaseUrl,
    webBaseUrl: d.webBaseUrl,
    secret: d.secret,
    now,
  });

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

  /**
   * All four handlers now live in `agentic-link.ts`, with no transport in them.
   *
   * The Cloudflare Worker needs the same four — this is the PRIMARY wallet path, and it shipped
   * refusing while the browser fallback was the only one served. It cannot import this file, because
   * Express drags `iconv-lite` into a bundle where its module-scope `require_streams(...)` is not a
   * function under workerd. One shared implementation is what keeps a TEE signature meaning the same
   * thing on both transports.
   */
  route("post", AGENTIC_LINK_START_ROUTE, (req) =>
    handleAgenticStart(req.body, agenticDeps(), req.header("x-request-id") ?? null),
  );
  route("get", AGENTIC_LINK_CHALLENGE_ROUTE, (req) =>
    handleAgenticChallenge(
      req.params.linkRequestId ?? "",
      typeof req.query.address === "string" ? req.query.address : null,
      agenticDeps(),
    ),
  );
  route("post", AGENTIC_LINK_COMPLETE_ROUTE, (req) =>
    handleAgenticComplete(req.params.linkRequestId ?? "", req.body, agenticDeps()),
  );
  route("get", AGENTIC_LINK_STATUS_ROUTE, (req) =>
    handleAgenticStatus(req.params.linkRequestId ?? "", agenticDeps()),
  );

}
