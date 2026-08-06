/**
 * The refusal that happens BEFORE the money.
 *
 * WHAT WENT WRONG
 *
 * Twenty-six Consumer Pack routes and four history-dependent Bureau tools were mounted inside the
 * x402 route table. A stranger's agent hitting `POST /consumer/shop/search` got a fully compliant
 * 402 — correct network, correct token, correct payTo, correct price — paid two cents, and was then
 * refused, because every one of those routes resolves a tenant scope from a SIWE session bound to a
 * policy the caller must already own on chain. The refusal was correct. The charge was not.
 *
 * The same shape applies to `score_vendor`, `score_buyer`, `generate_dispute_packet` and
 * `reconcile_agent_spend`: each needs receipt, buyer, vendor or intent history held by THIS host. A
 * caller with no history here can pay and can never be served. The registry already recorded that as
 * `obtainableBy: null`, and the listing generator already refused to publish them — but a route
 * absent from a listing is still a route, and the payment middleware never read the listing.
 *
 * WHY THE GATE SITS ABOVE THE PAYMENT MIDDLEWARE AND NOT INSIDE THE HANDLER
 *
 * A handler-level check is too late by exactly one settlement. `paymentMiddleware` verifies and
 * settles on the way to the handler, so by the time a handler can say "you have no policy" the money
 * has moved. The only position from which a refusal costs nothing is upstream of the gate that
 * charges, which is where this is registered.
 *
 * It therefore has to decide WITHOUT the request body — `express.json()` is deliberately mounted
 * below the payment middleware so an unpaid request never gets parsed. That constraint is met
 * honestly: every question this gate asks is answerable from the method, the path and the
 * `Authorization` header.
 *
 * WHAT A REFUSAL FROM HERE PROMISES
 *
 * No 402, no payment authorisation requested, no facilitator call, no payment attempt, no
 * reservation, no provider claim. The response is a plain 503 with a named code, and because it is
 * emitted above `paymentMiddleware` there is no code path from here to a charge.
 */

import type { Express, NextFunction, Request, Response } from "express";
import { DISPUTE_ROUTE, RECONCILE_ROUTE, SCORE_BUYER_ROUTE, SCORE_VENDOR_ROUTE } from "../config";
import { resolveScope, type ConsumerAuthConfig } from "./auth";

/**
 * The Consumer Pack refusal.
 *
 * Named for the thing that is missing rather than for the caller's mistake, because the caller made
 * none: the route is real, the price was real, and the host simply cannot complete the purchase for
 * somebody who is not already an account holder.
 */
export const PROVIDER_EXECUTION_UNAVAILABLE = "PROVIDER_EXECUTION_UNAVAILABLE" as const;

/**
 * The Bureau refusal.
 *
 * Distinct from the one above because the missing thing is different, and a caller can act on the
 * difference. Provider execution is a capability this deployment may or may not have wired; required
 * history is something no deployment can conjure for a stranger.
 */
export const REQUIRED_HISTORY_UNAVAILABLE = "REQUIRED_HISTORY_UNAVAILABLE" as const;

export type CapabilityRefusalCode =
  | typeof PROVIDER_EXECUTION_UNAVAILABLE
  | typeof REQUIRED_HISTORY_UNAVAILABLE;

/** Why a path is gated, and therefore which refusal it gives and what a caller can do about it. */
export type GateReason = "account_bound_execution" | "host_held_history";

export interface GatedPath {
  readonly method: "POST";
  readonly path: string;
  readonly reason: GateReason;
}

/**
 * The four Bureau tools, gated unconditionally.
 *
 * Unconditional because no `Authorization` header changes the answer. These read receipt, buyer,
 * vendor and intent history recorded by this host, so the question is not "are you authenticated"
 * but "does this host hold facts about you", and a stranger cannot become the subject of somebody
 * else's receipt history by signing in.
 *
 * They remain mounted and reachable for an operator through the internal surface. What is removed is
 * the ability to be BILLED for a question this host cannot answer.
 */
export const HISTORY_DEPENDENT_PATHS: readonly string[] = Object.freeze([
  SCORE_VENDOR_ROUTE,
  SCORE_BUYER_ROUTE,
  DISPUTE_ROUTE,
  RECONCILE_ROUTE,
]);

function normalise(path: string): string {
  const trimmed = path.split("?")[0] ?? path;
  if (trimmed.length > 1 && trimmed.endsWith("/")) return trimmed.slice(0, -1);
  return trimmed;
}

/**
 * Whether a concrete request path is the Consumer Pack path `pattern`.
 *
 * Written rather than delegated to Express's router because this middleware is registered with
 * `app.use` and therefore sees raw paths: `req.params` does not exist yet. The patterns in play use
 * exactly one construct, a trailing `:param` segment, so the match is a segment-count comparison
 * with wildcards where the pattern names one. Anything richer would be a router, and a second router
 * with its own matching rules is how a gate comes to disagree with the thing it guards.
 */
export function pathMatches(pattern: string, actual: string): boolean {
  const p = normalise(pattern).split("/");
  const a = normalise(actual).split("/");
  if (p.length !== a.length) return false;
  for (let i = 0; i < p.length; i += 1) {
    const seg = p[i]!;
    if (seg.startsWith(":")) {
      // A named segment must be present and non-empty; `/consumer/fund/` is not `/consumer/fund/:id`.
      if (!a[i]) return false;
      continue;
    }
    if (seg !== a[i]) return false;
  }
  return true;
}

export interface CapabilityGateDeps {
  /**
   * Every Consumer Pack path that carries a price, taken from the SAME table the payment middleware
   * is configured with. Passed in rather than re-listed here: a second hand-maintained list of paid
   * paths is precisely the drift that let these routes charge in the first place.
   */
  readonly pricedConsumerPaths: readonly string[];
  /** Read per request so an operator flipping the flag does not need a redeploy to take effect. */
  readonly executionEnabled: () => boolean;
  readonly authConfig: () => ConsumerAuthConfig;
  readonly now?: () => number;
}

interface Refusal {
  readonly code: CapabilityRefusalCode;
  readonly message: string;
}

/**
 * The decision, separated from the transport so it can be tested without an HTTP server and asserted
 * on directly by the consistency gates.
 *
 * Returns null to mean "not gated — carry on to the payment middleware", which is the only path that
 * can reach a charge.
 */
export function capabilityRefusal(
  args: {
    readonly method: string;
    readonly path: string;
    readonly authorization: string | undefined;
  },
  deps: CapabilityGateDeps,
): Refusal | null {
  const method = args.method.toUpperCase();
  // GET and HEAD on these paths are not priced, so they cannot charge and must not be refused here.
  if (method !== "POST") return null;
  const path = normalise(args.path);

  if (HISTORY_DEPENDENT_PATHS.includes(path)) {
    return {
      code: REQUIRED_HISTORY_UNAVAILABLE,
      message:
        "this tool answers from receipt, buyer, vendor or intent history recorded by this host, and " +
        "this host holds none for you. It is an account-bound Untch capability, not a service a " +
        "stranger can purchase. No payment was requested and none was taken.",
    };
  }

  const gated = deps.pricedConsumerPaths.some((pattern) => pathMatches(pattern, path));
  if (!gated) return null;

  if (!deps.executionEnabled()) {
    return {
      code: PROVIDER_EXECUTION_UNAVAILABLE,
      message:
        "governed provider execution is not enabled on this deployment, so this route cannot deliver " +
        "what it would charge for. No payment was requested and none was taken.",
    };
  }

  const scope = resolveScope(
    { authorization: args.authorization, queryPolicyId: null },
    deps.authConfig(),
    (deps.now ?? Date.now)(),
  );
  /**
   * Only a PROVEN scope passes.
   *
   * `UNPROVEN` is a policyId lifted from a query parameter, which `resolveScope` offers as namespacing
   * while `CONSUMER_AUTH_REQUIRED` is off. It is not authorisation, and letting it open the paywall
   * would mean a stranger could restore the exact trap by appending `?policyId=` to the URL.
   */
  if (scope.kind !== "PROVEN") {
    return {
      code: PROVIDER_EXECUTION_UNAVAILABLE,
      message:
        "this is an account-bound Untch product API, not a marketplace service. It executes against a " +
        "spend policy you already own, so it cannot serve a caller without a proven session: POST " +
        "/consumer/auth/nonce, sign the SIWE message with the policy owner's wallet, then POST " +
        "/consumer/auth/verify. No payment was requested and none was taken.",
    };
  }

  return null;
}

/**
 * Mount the gate.
 *
 * MUST be registered before `paymentMiddleware`. A test asserts the ordering, because the whole
 * guarantee of this module is positional and a later refactor moving one `app.use` would silently
 * restore the behaviour it exists to remove.
 */
export function registerConsumerCapabilityGate(app: Express, deps: CapabilityGateDeps): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const refusal = capabilityRefusal(
      { method: req.method, path: req.path, authorization: req.header("authorization") },
      deps,
    );
    if (!refusal) return next();
    res.status(503).json({
      code: refusal.code,
      message: refusal.message,
      retryable: false,
      docsUrl: null,
    });
  });
}
