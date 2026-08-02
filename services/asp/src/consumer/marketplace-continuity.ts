/**
 * Resolving a marketplace caller to an Untch account — or telling them, precisely, how to become one.
 *
 * THE SITUATION
 *
 * Untch is hired through OKX.AI. The call carries an agent id, maybe a task ref, maybe a buyer id.
 * None of that is authority: an agent id is a string in a request, and anyone can send one. Two
 * responses are available and both are wrong.
 *
 * Trusting it makes an unauthenticated string into an account, which means anyone who reads an agent
 * id off the marketplace can spend against the policy it belongs to. Refusing outright means a
 * marketplace user can never reach the policy they already hold in the web dashboard, which is the
 * continuity gap PASS 1 recorded.
 *
 * THE THIRD RESPONSE
 *
 * `ACCOUNT_LINK_REQUIRED`, with everything needed to fix it in the same body: a link request id, a
 * URL, an expiry, and the scope being asked for. The caller — or the person behind it — opens the
 * link, signs with the wallet that actually carries authority, and comes back resolved. The claim
 * never becomes authority; it becomes a label on one that was proven separately.
 *
 * WHY THIS IS A REFUSAL AND NOT A DEGRADED MODE
 *
 * There is no partial answer. An unlinked marketplace call does not get a smaller budget or a
 * read-only view — it gets nothing, plus instructions. A degraded mode would be a second code path
 * where spending decisions are made with weaker identity, and the weaker path is the one an attacker
 * would aim for.
 */

import type { Express, Request, Response, NextFunction } from "express";
import {
  returnUrlAllowed,
  type AccountStore,
  type LinkRequestStore,
  type MarketplaceBinding,
  type UntchAccount,
} from "@untch/consumer-core";
import { randomBytes } from "node:crypto";
import type { HandlerResult } from "../handlers";

export const MARKETPLACE_RESOLVE_ROUTE = "/consumer/marketplace/resolve" as const;

export interface MarketplaceIdentityClaim {
  readonly marketplace: string;
  readonly agentId: string;
  readonly buyerId: string | null;
  readonly taskRef: string | null;
  readonly serviceOrderRef: string | null;
  /**
   * Whether the HOST verified this claim, as opposed to reading it out of a body.
   *
   * False everywhere today, and that is the honest value: OKX exposes no request-signing scheme this
   * host can check, so an agent id arriving in a payload is a claim. The field exists so the day one
   * does exist, the difference is expressible — and so nothing downstream can read `agentId` without
   * also seeing that nobody verified it.
   */
  readonly verifiedByHost: boolean;
}

export type MarketplaceResolution =
  | {
      readonly kind: "RESOLVED";
      readonly account: UntchAccount;
      readonly binding: MarketplaceBinding;
    }
  | {
      readonly kind: "ACCOUNT_LINK_REQUIRED";
      readonly linkRequestId: string;
      readonly linkUrl: string;
      readonly expiresAt: string;
      readonly requestedScope: string;
      readonly oneTimeCode: string;
    };

export interface MarketplaceContinuityDeps {
  readonly accounts: AccountStore;
  readonly links: LinkRequestStore;
  readonly publicBaseUrl: string;
  readonly allowedReturnOrigins: readonly string[];
  readonly now?: () => number;
}

/**
 * Resolve a claim, creating a link request when it does not resolve.
 *
 * The unproven binding is recorded on the way past. It authorises nothing — `provenBy: 'unproven'` is
 * what `accountForMarketplaceIdentity` refuses to resolve — but it means the agent id that called has
 * somewhere to live for audit, instead of existing only in a log line that rotates away.
 */
export async function resolveMarketplaceCaller(
  claim: MarketplaceIdentityClaim,
  deps: MarketplaceContinuityDeps,
  options: { readonly requestedScope?: string; readonly returnUrl?: string | null; readonly sourceRequestId?: string | null } = {},
): Promise<MarketplaceResolution> {
  const now = deps.now?.() ?? Date.now();

  const resolved = await deps.accounts.accountForMarketplaceIdentity(claim.marketplace, claim.agentId);
  if (resolved) {
    // Record the task against the account it belongs to, so a job created on the marketplace and an
    // intent created here can be reconciled — which is the whole reason the binding exists.
    if (claim.taskRef) {
      await deps.accounts.recordJob({
        marketplace: claim.marketplace,
        jobId: claim.taskRef,
        accountId: resolved.account.accountId,
        agentId: claim.agentId,
        by: "marketplace-call",
      });
    }
    return { kind: "RESOLVED", account: resolved.account, binding: resolved.binding };
  }

  const returnUrl =
    options.returnUrl && returnUrlAllowed(options.returnUrl, deps.allowedReturnOrigins) ? options.returnUrl : null;

  const { request, code } = await deps.links.create({
    requestedScopes: ["identity"],
    context: {
      marketplace: claim.marketplace,
      marketplaceAgentId: claim.agentId,
      marketplaceBuyerId: claim.buyerId,
      taskRef: claim.taskRef,
      serviceOrderRef: claim.serviceOrderRef,
    },
    returnUrl,
    siweNonce: randomBytes(16).toString("hex"),
    sourceRequestId: options.sourceRequestId ?? null,
    nowMs: now,
    by: `marketplace:${claim.marketplace}`,
  });

  return {
    kind: "ACCOUNT_LINK_REQUIRED",
    linkRequestId: request.linkRequestId,
    linkUrl: `${deps.publicBaseUrl.replace(/\/+$/, "")}/link/${request.linkRequestId}`,
    expiresAt: request.expiresAt,
    requestedScope: options.requestedScope ?? "identity",
    oneTimeCode: code,
  };
}

/** The structured refusal, in the shape every other refusal on this host takes. */
export function accountLinkRequiredBody(
  resolution: Extract<MarketplaceResolution, { kind: "ACCOUNT_LINK_REQUIRED" }>,
  claim: MarketplaceIdentityClaim,
): Record<string, unknown> {
  return {
    code: "ACCOUNT_LINK_REQUIRED",
    message:
      `${claim.marketplace} agent ${claim.agentId} is not yet linked to an Untch account. An agent id is ` +
      "a claim in a request and authorises nothing on its own. Open the link below and sign with the " +
      "wallet that holds your policy; the same account will then answer for this agent id.",
    retryable: true,
    docsUrl: null,
    linkRequestId: resolution.linkRequestId,
    linkUrl: resolution.linkUrl,
    oneTimeCode: resolution.oneTimeCode,
    expiresAt: resolution.expiresAt,
    requestedScope: resolution.requestedScope,
    nextStep:
      "Open linkUrl, sign the message with your wallet, then retry this call. Nothing about this link " +
      "approves a payment.",
    // Carried through so a client can show which task it is being asked to link, rather than an
    // unexplained interruption in the middle of a job.
    marketplaceContext: {
      marketplace: claim.marketplace,
      agentId: claim.agentId,
      taskRef: claim.taskRef,
      serviceOrderRef: claim.serviceOrderRef,
      verifiedByHost: claim.verifiedByHost,
    },
  };
}

/**
 * Read a claim from a request body, and label it honestly.
 *
 * `verifiedByHost` is hard-coded false, and it is a statement rather than a placeholder: OKX exposes
 * no request-signing scheme this host can verify today, so every agent id arriving here is unverified
 * by definition. Wiring it to a header that merely EXISTS would be the exact mistake — a field that
 * says "verified" because something was present.
 */
export function readClaim(body: unknown): MarketplaceIdentityClaim | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const agentId = typeof b.agentId === "string" ? b.agentId : null;
  if (!agentId) return null;
  return {
    marketplace: typeof b.marketplace === "string" ? b.marketplace : "okx",
    agentId,
    buyerId: typeof b.buyerId === "string" ? b.buyerId : null,
    taskRef: typeof b.taskRef === "string" ? b.taskRef : null,
    serviceOrderRef: typeof b.serviceOrderRef === "string" ? b.serviceOrderRef : null,
    verifiedByHost: false,
  };
}

export function registerMarketplaceRoutes(
  app: Express,
  send: (res: Response, r: HandlerResult) => void,
  deps: MarketplaceContinuityDeps | null,
): void {
  if (!deps) {
    app.post(MARKETPLACE_RESOLVE_ROUTE, (_req, res) =>
      send(res, {
        status: 503,
        body: {
          code: "ACCOUNT_LINK_UNAVAILABLE",
          message: "the Consumer Pack is not wired on this instance (DATABASE_URL unset)",
          retryable: false,
          docsUrl: null,
        },
      }),
    );
    return;
  }

  const d = deps;
  app.post(MARKETPLACE_RESOLVE_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    (async (): Promise<HandlerResult> => {
      const claim = readClaim(req.body);
      if (!claim) {
        return {
          status: 400,
          body: {
            code: "AGENT_ID_REQUIRED",
            message: "agentId is required to resolve a marketplace caller",
            retryable: false,
            docsUrl: null,
          },
        };
      }

      const resolution = await resolveMarketplaceCaller(claim, d, {
        returnUrl: typeof (req.body as { returnUrl?: unknown })?.returnUrl === "string"
          ? ((req.body as { returnUrl: string }).returnUrl)
          : null,
        sourceRequestId: req.header("x-request-id") ?? null,
      });

      if (resolution.kind === "ACCOUNT_LINK_REQUIRED") {
        // 409, not 401. There is nothing wrong with the caller's credentials — there are none, and
        // that is a state to be moved out of rather than an authentication failure to retry.
        return { status: 409, body: accountLinkRequiredBody(resolution, claim) };
      }

      return {
        status: 200,
        body: {
          code: "RESOLVED",
          accountId: resolution.account.accountId,
          marketplace: resolution.binding.marketplace,
          agentId: resolution.binding.agentId,
          taskRef: claim.taskRef,
          // The account's own default, so the caller learns in one round trip whether a preflight
          // that names no policy would succeed.
          defaultPolicyId: resolution.account.defaultPolicyId,
          policySelected: resolution.account.defaultPolicyId !== null,
          nextStep:
            resolution.account.defaultPolicyId === null
              ? "This account holds no default policy. Set one with PUT /consumer/account/default-policy."
              : "This account is ready. A request that names no policyId resolves to its default.",
        },
      };
    })()
      .then((r) => send(res, r))
      .catch(next);
  });
}
