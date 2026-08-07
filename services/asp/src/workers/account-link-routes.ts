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
  handleLinkStart,
  type AccountLinkDeps,
} from "../consumer/account-link";
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
      /** Verifies the signature, resolves or creates the account, and mints the session. */
      method: "POST",
      pattern: ACCOUNT_LINK_COMPLETE_ROUTE,
      bodyMode: "json",
      handler: async (req: RouteRequest) => {
        assertOwnsWrites(deps.gate, "approval-expiry-mutation");
        return send(await handleLinkComplete(req.body, linkDeps()));
      },
    },
  ];
}

/** The paths this module serves, so the route classifier reads truth rather than a guess. */
export const ACCOUNT_LINK_PATHS = [ACCOUNT_LINK_START_ROUTE, ACCOUNT_LINK_COMPLETE_ROUTE] as const;
