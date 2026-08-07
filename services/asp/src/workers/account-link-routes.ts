/**
 * Sign in with a wallet, on Workers. The head of the account chain.
 *
 * WHAT WAS ACTUALLY BROKEN
 *
 * The Worker served the account READS and the policy routes, and neither was reachable. Both demand a
 * session, the only thing that mints one is a completed wallet signature, and `link/start` was never
 * ported — so `/consumer/account`, `/consumer/policies/draft` and `/consumer/policies/sync` all
 * answered 401 to a caller who had no way to stop being anonymous. An independent buyer caught the
 * same shape one level down: the middle of a chain migrated before its head.
 *
 * WHAT THIS DEPLOYMENT SIGNS
 *
 * Nothing. `verifyWalletProof` CHECKS a signature the user's own wallet produced; no key is held here
 * and none is reachable. The session it mints is an HMAC over an account id, and no route reachable
 * with one takes an amount — spending needs a policy, a quote, and above the threshold an approval
 * whose digest names the exact figure.
 *
 * WHY IT IS SAFE ON A RUNTIME WITH NO NODE
 *
 * `makeSiweVerifier` is viem over `http`, which is `fetch`. That covers the path that actually
 * matters: an OKX Agentic Wallet is a smart account, so a real user is verified through EIP-1271
 * against X Layer rather than by plain ecrecover.
 */

import { PgAccountStore, PgLinkRequestStore, type Pool } from "@untch/consumer-core";
import {
  ACCOUNT_LINK_COMPLETE_ROUTE,
  ACCOUNT_LINK_START_ROUTE,
  handleLinkComplete,
  handleLinkMessage,
  handleLinkStart,
  type AccountLinkDeps,
} from "../consumer/account-link";
import { linkPageRoute, LINK_PAGE_ROUTE } from "./link-page";
import {
  AGENTIC_LINK_CHALLENGE_ROUTE,
  AGENTIC_LINK_COMPLETE_ROUTE,
  AGENTIC_LINK_START_ROUTE,
  AGENTIC_LINK_STATUS_ROUTE,
  handleAgenticChallenge,
  handleAgenticComplete,
  handleAgenticStart,
  handleAgenticStatus,
  type AgenticLinkDeps,
} from "../consumer/agentic-link";
import { makeSiweVerifier } from "../consumer/siwe-verifier";
import type { HandlerResult } from "../handlers";
import type { Route, RouteRequest } from "./router";
import { assertOwnsWrites, type WriterGate } from "./writer-gate";

const send = (r: HandlerResult): Response =>
  new Response(JSON.stringify(r.body, null, 2), {
    status: r.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...(r.headers ?? {}),
    },
  });

export interface AccountLinkRouteDeps {
  readonly pool: Pool;
  readonly secret: string;
  readonly baseUrl: string;
  readonly rpcUrl: string;
  readonly gate: WriterGate;
}

/** The server-authored message for a wallet that has just connected. */
export const LINK_MESSAGE_ROUTE = "/consumer/account/link/:linkRequestId/message" as const;

export function accountLinkRoutes(deps: AccountLinkRouteDeps): readonly Route[] {
  /**
   * The audience a signature is accepted for, derived from this deployment's own base URL.
   *
   * Never widened on a parse failure. A signature is scoped to a domain, and a deployment that could
   * not work out its own host has no business accepting one issued for somebody else's.
   */
  let domain: string;
  try {
    domain = new URL(deps.baseUrl).host;
  } catch {
    domain = "asp.untch.xyz";
  }

  /**
   * `webBaseUrl` is where a human is sent to watch a link complete. It is the marketing site rather
   * than this API host, which serves no such page.
   */
  const agenticDeps = (): AgenticLinkDeps => ({
    accounts: new PgAccountStore(deps.pool as never),
    links: new PgLinkRequestStore(deps.pool as never),
    verifier: makeSiweVerifier(deps.rpcUrl),
    domain,
    publicBaseUrl: deps.baseUrl.replace(/\/+$/, ""),
    webBaseUrl: "https://untch.xyz",
    secret: deps.secret,
    now: () => Date.now(),
  });

  const linkDeps = (): AccountLinkDeps => ({
    accounts: new PgAccountStore(deps.pool as never),
    links: new PgLinkRequestStore(deps.pool as never),
    verifier: makeSiweVerifier(deps.rpcUrl),
    domain,
    publicBaseUrl: deps.baseUrl.replace(/\/+$/, ""),
    /**
     * Where a browser may be returned to after linking, exact-origin matched.
     *
     * The Railway host that used to be on this list is gone, and leaving it would name a domain this
     * project no longer controls as a place to send a user holding a fresh session.
     */
    allowedReturnOrigins: [`https://${domain}`, "https://www.untch.xyz", "https://untch.xyz"],
    secret: deps.secret,
    now: () => Date.now(),
  });

  return [
    {
      /**
       * Creates a link request and returns the exact message to sign.
       *
       * A write, so it asks the gate: this records a PENDING row and hands back a one-time code, and a
       * deployment that does not own writes would be issuing a code against a row it could not later
       * redeem — the user would sign for nothing.
       */
      method: "POST",
      pattern: ACCOUNT_LINK_START_ROUTE,
      bodyMode: "json",
      handler: async (req: RouteRequest) => {
        assertOwnsWrites(deps.gate, "approval-expiry-mutation");
        return send(
          await handleLinkStart(req.body, linkDeps(), req.request.headers.get("x-request-id")),
        );
      },
    },
    {
      /**
       * The message the connecting wallet should sign, authored here rather than in the browser.
       *
       * A read, so it does not ask the writer gate: it records nothing. It is also unauthenticated,
       * because the nonce it reveals authorises nothing without the one-time code.
       */
      method: "POST",
      pattern: LINK_MESSAGE_ROUTE,
      bodyMode: "json",
      handler: async (req: RouteRequest) =>
        send(await handleLinkMessage(req.params.linkRequestId ?? "", req.body, linkDeps())),
    },
    {
      /** Verifies the signature, resolves or creates the account, and mints the session. */
      method: "POST",
      pattern: ACCOUNT_LINK_COMPLETE_ROUTE,
      bodyMode: "json",
      handler: async (req: RouteRequest) => {
        assertOwnsWrites(deps.gate, "approval-expiry-mutation");
        return send(await handleLinkComplete(req.body, linkDeps()));
      },
    },
    /**
     * The page `link/start` has always told callers to open. Served from this host so the page and the
     * API it calls share an origin — no CORS, and nothing to keep in sync across two deployments.
     */
    linkPageRoute(),

    /**
     * The Agentic Wallet path — the PRIMARY one, and the reason this port was inverted until now.
     *
     * The browser routes above assume an injected EIP-1193 provider, which reaches the OKX browser
     * EXTENSION: a different wallet product with different keys. The Agentic Wallet is TEE-held and
     * restored by email, Google or Apple login, so a page cannot call it — an agent fetches the
     * challenge, signs inside the TEE, and posts the signature back while the browser polls.
     *
     * Shipping only the browser half meant the wallet Untch is actually for could not be linked here
     * at all.
     */
    {
      method: "POST",
      pattern: AGENTIC_LINK_START_ROUTE,
      bodyMode: "json",
      handler: async (req: RouteRequest) => {
        assertOwnsWrites(deps.gate, "approval-expiry-mutation");
        return send(
          await handleAgenticStart(req.body, agenticDeps(), req.request.headers.get("x-request-id")),
        );
      },
    },
    {
      /** A read the agent may legitimately repeat, so the address arrives as a query parameter. */
      method: "GET",
      pattern: AGENTIC_LINK_CHALLENGE_ROUTE,
      bodyMode: "none",
      handler: async (req: RouteRequest) =>
        send(
          await handleAgenticChallenge(
            req.params.linkRequestId ?? "",
            req.url.searchParams.get("address"),
            agenticDeps(),
          ),
        ),
    },
    {
      method: "POST",
      pattern: AGENTIC_LINK_COMPLETE_ROUTE,
      bodyMode: "json",
      handler: async (req: RouteRequest) => {
        assertOwnsWrites(deps.gate, "approval-expiry-mutation");
        return send(await handleAgenticComplete(req.params.linkRequestId ?? "", req.body, agenticDeps()));
      },
    },
    {
      /** What the waiting browser polls. A read, so it does not ask the writer gate. */
      method: "GET",
      pattern: AGENTIC_LINK_STATUS_ROUTE,
      bodyMode: "none",
      handler: async (req: RouteRequest) =>
        send(await handleAgenticStatus(req.params.linkRequestId ?? "", agenticDeps())),
    },
  ];
}

/** The paths this module serves, so the route classifier reads truth rather than a guess. */
export const ACCOUNT_LINK_PATHS = [
  ACCOUNT_LINK_START_ROUTE,
  ACCOUNT_LINK_COMPLETE_ROUTE,
  LINK_MESSAGE_ROUTE,
  LINK_PAGE_ROUTE,
  AGENTIC_LINK_START_ROUTE,
  AGENTIC_LINK_CHALLENGE_ROUTE,
  AGENTIC_LINK_COMPLETE_ROUTE,
  AGENTIC_LINK_STATUS_ROUTE,
] as const;
