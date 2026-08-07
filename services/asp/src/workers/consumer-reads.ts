/**
 * The account and approval surface the product UI calls.
 *
 * WHY THE APPROVALS LIST IS NOT A READ
 *
 * `GET /consumer/approvals` sweeps expiries before it reads. That is not incidental: an approval whose
 * expiry passed while nobody looked is EXPIRED, and a list that showed it as PENDING would render an
 * approve button that cannot work. The sweep is what makes the list actionable rather than merely
 * informative.
 *
 * Which is why this route could not be ported before the writer transfer, and why the sweep is not
 * quietly dropped to make it look like a read. It runs the canonical `PgApprovalStore.expire`, the same
 * call Express makes and the same call the scheduled job makes, and it uses the DATABASE clock rather
 * than the isolate's — a Worker's `Date.now()` is not the clock the rows were written against.
 *
 * WHAT AUTHORISES A READ HERE
 *
 * A session token signed with `CONSUMER_AUTH_SECRET`, opened by the canonical `openAccountSession`.
 * The session names the account; every query is scoped to it. There is no path that takes an account
 * id from the request, because "unguessable" is not an authorisation model.
 */

import { PgApprovalStore, type Pool } from "@untch/consumer-core";
import { openAccountSession } from "../consumer/account-auth";
import type { HandlerResult } from "../handlers";
import type { Route, RouteRequest } from "./router";
import { assertOwnsWrites, type WriterGate } from "./writer-gate";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });

const refuse = (status: number, code: string, message: string): Response =>
  json({ code, message, retryable: false, docsUrl: null }, status);

const fromResult = (r: HandlerResult): Response => json(r.body, r.status);

export interface ConsumerReadDeps {
  readonly pool: Pool;
  readonly secret: string;
  readonly gate: WriterGate;
  readonly executionEnabled: boolean;
}

/** The account named by the bearer token, or null. Never a partial answer. */
function sessionOf(req: RouteRequest, secret: string): { accountId: string; address: string } | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.request.headers.get("authorization") ?? "")?.[1];
  const s = openAccountSession(secret, bearer, Date.now());
  return s ? { accountId: s.accountId, address: s.address } : null;
}

const SESSION_REQUIRED = [
  "this read is account-scoped: POST /consumer/account/link/start, sign the message with your wallet,",
  "then POST /consumer/account/link/complete to obtain a session",
].join(" ");

export function consumerReadRoutes(deps: ConsumerReadDeps): readonly Route[] {
  const approvals = new PgApprovalStore(deps.pool as never);

  const authed = (
    handler: (accountId: string, req: RouteRequest) => Promise<Response>,
  ) => async (req: RouteRequest): Promise<Response> => {
    const session = sessionOf(req, deps.secret);
    if (!session) return refuse(401, "ACCOUNT_SESSION_REQUIRED", SESSION_REQUIRED);
    return handler(session.accountId, req);
  };

  return [
    {
      method: "GET",
      pattern: "/consumer/approvals",
      bodyMode: "none",
      handler: authed(async (accountId, req) => {
        const state = req.url.searchParams.get("state")?.toUpperCase() ?? null;

        /**
         * The sweep, gated on write ownership rather than assumed.
         *
         * `assertOwnsWrites` throws when another deployment owns writes, and the entry module turns
         * that into a 503 naming the reason. That is the correct answer: a list that could not sweep
         * cannot promise its PENDING rows are actionable, so it must not serve them as if it could.
         */
        assertOwnsWrites(deps.gate, "approval-expiry");
        await approvals.expire(Date.now());

        const requests = await approvals.listForAccount(accountId, {
          ...(state ? { state: state as never } : {}),
          limit: 100,
        });
        const all = await approvals.listForAccount(accountId, { limit: 200 });
        const counts: Record<string, number> = {};
        for (const r of all) counts[r.state] = (counts[r.state] ?? 0) + 1;

        return json({
          accountId,
          executionEnabled: deps.executionEnabled,
          executionNote: deps.executionEnabled
            ? "Provider execution is enabled; an approved action will run."
            : "Provider execution is DISABLED on this deployment. Approving records a decision and pays nothing.",
          counts,
          count: requests.length,
          approvals: requests,
        });
      }),
    },

    {
      method: "GET",
      pattern: "/consumer/approvals/:approvalRequestId",
      bodyMode: "none",
      /**
       * Detail is a genuine read — no sweep. The row carries its own `expires_at`, so a caller reading
       * one request can see for itself whether it has lapsed without the list's cross-row sweep.
       */
      handler: authed(async (accountId, req) => {
        const id = req.params.approvalRequestId ?? "";
        const request = await approvals.get(id);
        if (!request || (request as { accountId?: string }).accountId !== accountId) {
          return refuse(404, "APPROVAL_NOT_FOUND", `no approval request ${id} on this account`);
        }
        return json(request);
      }),
    },
  ];
}

export { fromResult };
