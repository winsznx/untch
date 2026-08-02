/**
 * The web approval centre — the one place a decision can be made with a wallet-backed session.
 *
 * WHY THE WEB IS THE PRIMARY CHANNEL AND NOT A FALLBACK
 *
 * Every other channel is a NOTIFICATION with a decision attached, and each one has a different, weaker
 * story about who is answering: a Telegram callback is as good as the Telegram account, a Discord
 * interaction as good as the Discord account, an email is as good as nothing at all because a sender
 * address is forged trivially. The web session is the only channel where the answer comes from the
 * thing that actually carries authority here — the wallet that owns the account.
 *
 * So the other channels are conveniences layered on top, each with its own binding proving the platform
 * identity belongs to this account, and email deliberately has no decision path at all. It carries a
 * link to here.
 *
 * WHAT AN APPROVE BUTTON SUBMITS
 *
 * The DIGEST it was shown, not a boolean. That is what makes "approve the exact quote" true rather than
 * aspirational: if the quote moved between the page rendering and the button being pressed, the digest
 * the browser holds no longer matches the request and the decision is refused with a reason the user
 * can act on. A button that posted `{approve: true}` would be approving whatever the server thought was
 * current at the moment it read the row.
 *
 * WHAT IT DOES NOT DO
 *
 * Execute anything. Approving moves the request to APPROVED, and on a deployment with providers
 * disabled the surface says APPROVED_AWAITING_EXECUTION and says why. It never reports a payment that
 * did not happen.
 */

import type { Express, Request, Response, NextFunction } from "express";
import {
  PgApprovalStore,
  describeApprovalState,
  type AccountStore,
  type ApprovalDecision,
  type ApprovalDelivery,
  type ApprovalRequest,
  type ApprovalState,
  type Pool,
} from "@untch/consumer-core";
import type { HandlerResult } from "../handlers";
import { openAccountSession } from "./account-auth";

export const APPROVALS_LIST_ROUTE = "/consumer/approvals" as const;
export const APPROVAL_DETAIL_ROUTE = "/consumer/approvals/:approvalRequestId" as const;
export const APPROVAL_DECIDE_ROUTE = "/consumer/approvals/:approvalRequestId/decide" as const;

export interface ApprovalRoutesDeps {
  readonly approvals: PgApprovalStore;
  readonly accounts: AccountStore;
  readonly secret: string;
  /** Whether a provider could actually run right now. Decides what an APPROVED request is CALLED. */
  readonly executionEnabled: boolean;
  readonly now?: () => number;
}

export function makeApprovalRoutesDeps(args: {
  readonly pool: Pool;
  readonly accounts: AccountStore;
  readonly secret: string;
  readonly executionEnabled: boolean;
}): ApprovalRoutesDeps {
  return {
    approvals: new PgApprovalStore(args.pool),
    accounts: args.accounts,
    secret: args.secret,
    executionEnabled: args.executionEnabled,
  };
}

const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): HandlerResult => ({
  status,
  body: { code, message, retryable: false, docsUrl: null, ...extra },
});

const KNOWN_STATES = new Set<ApprovalState>([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "SUPERSEDED",
  "EXECUTED",
]);

function summary(request: ApprovalRequest, executionEnabled: boolean): Record<string, unknown> {
  const described = describeApprovalState(request.state, executionEnabled);
  return {
    approvalRequestId: request.approvalRequestId,
    state: request.state,
    // The DISPLAY code and the stored state are both present and are not always the same word.
    // APPROVED with providers disabled displays as APPROVED_AWAITING_EXECUTION, and conflating the two
    // is how a demo comes to claim a payment occurred.
    displayState: described.code,
    displayLabel: described.label,
    amount: request.amount,
    asset: request.asset,
    provider: request.provider,
    capability: request.capability,
    policyId: request.policyId,
    intentId: request.intentId,
    reason: request.reason,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    resolvedAt: request.resolvedAt,
    supersededBy: request.supersededBy,
  };
}

function detail(
  request: ApprovalRequest,
  decisions: readonly ApprovalDecision[],
  deliveries: readonly ApprovalDelivery[],
  executionEnabled: boolean,
  nowMs: number,
): Record<string, unknown> {
  return {
    ...summary(request, executionEnabled),
    // The exact value an approve button must echo back. Rendering it is what lets a stale page be
    // caught at decision time rather than approving whatever is current.
    approvalDigest: request.approvalDigest,
    quote: {
      quoteId: request.quoteId,
      quoteHash: request.quoteHash,
      expiresAt: request.expiresAt,
      expired: Date.parse(request.expiresAt) <= nowMs,
    },
    recipient:
      request.recipient === null
        ? {
            value: null,
            // Named rather than shown blank. "No recipient" and "we could not work out the recipient"
            // are different facts and the second one is a reason to look harder before approving.
            note: "this capability has no deterministic recipient until execution",
          }
        : { value: request.recipient, note: null },
    policy: {
      policyId: request.policyId,
      version: request.policyVersion,
      triggeringRules: request.triggeringRules,
    },
    decisions: decisions.map((d) => ({
      decisionId: d.decisionId,
      decision: d.decision,
      channel: d.channel,
      // The actor is shown truncated. Enough to recognise your own answer; not a directory of the
      // platform identities attached to this account.
      actor: d.actor.length > 10 ? `${d.actor.slice(0, 6)}…${d.actor.slice(-4)}` : d.actor,
      decidedAt: d.decidedAt,
      // Proof the decision named this exact payment, checkable by anyone holding the request.
      digestMatchedRequest: d.approvalDigest === request.approvalDigest,
    })),
    /**
     * Whether anybody was actually TOLD, and through what.
     *
     * A SKIPPED entry with `credential-unrotated` is the difference between "the owner ignored this"
     * and "no message was ever sent". A timeline missing that distinction blames the wrong party.
     */
    deliveries: deliveries.map((d) => ({
      channel: d.channel,
      outcome: d.outcome,
      detail: d.detail,
      attemptedAt: d.attemptedAt,
    })),
    actions:
      request.state === "PENDING" && Date.parse(request.expiresAt) > nowMs
        ? {
            approve: {
              method: "POST",
              path: `/consumer/approvals/${request.approvalRequestId}/decide`,
              body: { decision: "APPROVE", approvalDigest: request.approvalDigest },
            },
            reject: {
              method: "POST",
              path: `/consumer/approvals/${request.approvalRequestId}/decide`,
              body: { decision: "REJECT", approvalDigest: request.approvalDigest },
            },
          }
        : null,
  };
}

export function registerApprovalRoutes(
  app: Express,
  send: (res: Response, r: HandlerResult) => void,
  deps: ApprovalRoutesDeps | null,
): void {
  if (!deps) {
    const why = "the approval centre is not wired on this instance (DATABASE_URL or CONSUMER_AUTH_SECRET unset)";
    app.get(APPROVALS_LIST_ROUTE, (_req, res) => send(res, refuse(503, "APPROVALS_UNAVAILABLE", why)));
    app.get(APPROVAL_DETAIL_ROUTE, (_req, res) => send(res, refuse(503, "APPROVALS_UNAVAILABLE", why)));
    app.post(APPROVAL_DECIDE_ROUTE, (_req, res) => send(res, refuse(503, "APPROVALS_UNAVAILABLE", why)));
    return;
  }

  const d = deps;
  const now = (): number => d.now?.() ?? Date.now();

  const withSession = (
    req: Request,
    fn: (accountId: string, address: string) => Promise<HandlerResult>,
  ): Promise<HandlerResult> => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1];
    const session = openAccountSession(d.secret, bearer, now());
    if (!session) {
      return Promise.resolve(
        refuse(
          401,
          "ACCOUNT_SESSION_REQUIRED",
          "approvals are decided with the wallet that owns the account: sign in at /consumer/account/link/start",
        ),
      );
    }
    return fn(session.accountId, session.address);
  };

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

  route("get", APPROVALS_LIST_ROUTE, (req) =>
    withSession(req, async (accountId) => {
      const raw = typeof req.query.state === "string" ? req.query.state.toUpperCase() : null;
      if (raw !== null && !KNOWN_STATES.has(raw as ApprovalState)) {
        return refuse(
          400,
          "UNKNOWN_STATE",
          `state must be one of ${[...KNOWN_STATES].join(", ")}`,
        );
      }
      // Sweep before reading. An approval whose expiry passed while nobody looked is EXPIRED, and a
      // list that showed it as PENDING would offer a button that cannot work.
      await d.approvals.expire(now());

      const requests = await d.approvals.listForAccount(accountId, {
        ...(raw ? { state: raw as ApprovalState } : {}),
        limit: 100,
      });
      const counts: Record<string, number> = {};
      for (const s of KNOWN_STATES) counts[s] = 0;
      for (const r of await d.approvals.listForAccount(accountId, { limit: 200 })) {
        counts[r.state] = (counts[r.state] ?? 0) + 1;
      }

      return {
        status: 200,
        body: {
          accountId,
          executionEnabled: d.executionEnabled,
          // Stated once, at the top, so no reader has to infer it from a per-item label.
          executionNote: d.executionEnabled
            ? "Provider execution is enabled; an approved action will run."
            : "Provider execution is DISABLED on this deployment. Approving records a decision and pays nothing.",
          counts,
          count: requests.length,
          approvals: requests.map((r) => summary(r, d.executionEnabled)),
        },
      };
    }),
  );

  route("get", APPROVAL_DETAIL_ROUTE, (req) =>
    withSession(req, async (accountId) => {
      const id = req.params.approvalRequestId ?? "";
      const request = await d.approvals.get(id);
      if (!request || request.accountId !== accountId) {
        // Same answer for "not yours" as for "does not exist". Telling them apart would confirm which
        // opaque ids are real.
        return refuse(404, "APPROVAL_NOT_FOUND", `no approval request ${id}`);
      }
      const [decisions, deliveries] = await Promise.all([
        d.approvals.decisionsFor(id),
        d.approvals.deliveriesFor(id),
      ]);
      return { status: 200, body: detail(request, decisions, deliveries, d.executionEnabled, now()) };
    }),
  );

  /**
   * The decision.
   *
   * `approvalDigest` is REQUIRED in the body and is not optional-with-a-fallback. A fallback to "use
   * whatever the server currently thinks" would silently reintroduce exactly the bug the digest exists
   * to close: a page rendered against a 6.00 quote, approved after the quote moved to 6.50, agreeing to
   * a number the user never saw.
   */
  route("post", APPROVAL_DECIDE_ROUTE, (req) =>
    withSession(req, async (accountId, address) => {
      const id = req.params.approvalRequestId ?? "";
      const b = (req.body ?? {}) as Record<string, unknown>;
      const decision = typeof b.decision === "string" ? b.decision.toUpperCase() : null;
      const digest = typeof b.approvalDigest === "string" ? b.approvalDigest : null;

      if (decision !== "APPROVE" && decision !== "REJECT") {
        return refuse(400, "DECISION_REQUIRED", 'decision must be "APPROVE" or "REJECT"');
      }
      if (!digest) {
        return refuse(
          400,
          "APPROVAL_DIGEST_REQUIRED",
          "approvalDigest is required: an approval names the exact payment it authorises, so a decision " +
            "must echo the digest it was shown rather than agreeing to whatever is current",
        );
      }

      const outcome = await d.approvals.decide({
        approvalRequestId: id,
        accountId,
        digest,
        decision,
        channel: "dashboard",
        channelBindingId: null,
        // The wallet address is the actor, because the wallet is what carries authority here. A
        // session id would identify the browser tab, which is not who agreed to anything.
        actor: address,
        correlationRef: req.header("x-request-id") ?? null,
        provenance: { userAgent: req.header("user-agent") ?? null, via: "web-approval-centre" },
        nowMs: now(),
        by: `account:${accountId}`,
      });

      if (!outcome.ok) {
        const status =
          outcome.reason === "NOT_FOUND"
            ? 404
            : outcome.reason === "DIGEST_MISMATCH"
              ? 409
              : outcome.reason === "EXPIRED"
                ? 410
                : 409;
        return refuse(status, `APPROVAL_${outcome.reason}`, outcome.detail ?? describeFailure(outcome.reason));
      }

      const described = describeApprovalState(outcome.request.state, d.executionEnabled);
      const [decisions, deliveries] = await Promise.all([
        d.approvals.decisionsFor(id),
        d.approvals.deliveriesFor(id),
      ]);
      return {
        status: 200,
        body: {
          ...detail(outcome.request, decisions, deliveries, d.executionEnabled, now()),
          decisionId: outcome.decision.decisionId,
          // A double-tap is not an error and says so, rather than looking like a second approval.
          repeat: outcome.repeat,
          outcome: described.code,
          // Said in the response body, not only in the list header. This is the field a client renders
          // after the button press, and it is where a false "paid" claim would appear.
          paid: false,
          paidNote:
            outcome.request.state === "APPROVED" && !d.executionEnabled
              ? "Approved. Nothing has been paid — provider execution is disabled on this deployment."
              : outcome.request.state === "REJECTED"
                ? "Rejected. Nothing was paid."
                : null,
        },
      };
    }),
  );
}

function describeFailure(reason: string): string {
  switch (reason) {
    case "NOT_PENDING":
      return "that approval has already been resolved";
    case "EXPIRED":
      return "that approval expired before it was answered; the quote it named has aged out with it";
    case "ALREADY_DECIDED":
      return "you have already answered this approval";
    case "DIGEST_MISMATCH":
      return "the approval you answered no longer describes this payment";
    default:
      return "that approval cannot be decided";
  }
}
