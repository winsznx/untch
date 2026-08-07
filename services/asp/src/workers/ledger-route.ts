/**
 * `get_ledger`, which this deployment refuses BY NAME rather than by omission.
 *
 * WHY IT IS NOT PORTED, AND WHY THAT IS THE RIGHT ANSWER
 *
 * The route reports reserved authority for a policy partition, and it reads that from the process-local
 * ledger that `preflight_payment` commits approved decisions to. A Worker has no process: the second
 * request lands in a different isolate with an empty map, so the honest reading of a ported version is
 * "approximately zero, most of the time, for reasons the caller cannot see". A number that is
 * confidently wrong is worse than a refusal, because only one of the two can be retried.
 *
 * WHY IT IS NOT SERVED FROM POSTGRES INSTEAD
 *
 * The tables this deployment does hold answer different questions. `untch_marketplace_sales` is what
 * buyers paid US for tool calls; a policy's reserved authority is what a buyer is permitted to spend
 * ELSEWHERE. Publishing the first under the name of the second is exactly the confusion migration 027
 * exists to record — an approved 4.00 authorisation became a 4,000,000-base-unit SPEND row and was
 * rendered under a tile reading "Spent" at four layers of the product. The durable reservation tables
 * are the correct source, and the Worker's preflight does not write to them.
 *
 * So the refusal names the missing state and points at the two routes that DO answer from durable
 * storage. A 503 that says which deployment can serve it is a different thing from a 503 that says
 * nothing.
 */

import { APPROVAL_DECIDE_ROUTE, ESCALATION_STATUS_ROUTE, GET_LEDGER_ROUTE } from "../config";
import type { Route } from "./router";

export function getLedgerRoute(): Route {
  return {
    method: "POST",
    pattern: GET_LEDGER_ROUTE,
    bodyMode: "json",
    handler: async () =>
      new Response(
        JSON.stringify(
          {
            code: "LEDGER_WINDOW_NOT_DURABLE",
            message:
              "this deployment cannot answer get_ledger. The reserved-authority window it reports from " +
              "is process-local, and a Worker serves each request from a different isolate — a ported " +
              "version would return near-zero without being able to say so. It is not served from the " +
              "sales table instead, because what buyers paid Untch is not what a policy permits them to " +
              "spend elsewhere.",
            // Retryable: nothing about the request is wrong, and another deployment can serve it.
            retryable: true,
            docsUrl: null,
            insteadTry: {
              "the policy itself, and its rules": "GET /consumer/policies/{policyId} with an account session",
              "what a specific paid decision recorded": "GET /receipt_status/{receiptId}",
            },
          },
          null,
          2,
        ),
        {
          status: 503,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
          },
        },
      ),
  };
}

/** The same envelope, so every named refusal on this host reads the same way. */
const refusal = (code: string, message: string, insteadTry: Record<string, string>): Response =>
  new Response(JSON.stringify({ code, message, retryable: true, docsUrl: null, insteadTry }, null, 2), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });

/**
 * Escalation status, refused because there is nothing on this deployment to poll.
 *
 * A status read is servable from Postgres alone — `getState` reaches the repo and nothing else, the
 * same shape that made `log_receipt` portable once it turned out Redis was only in the enqueue path.
 * But CREATING an escalation is not: the fan-out needs the channel registry and the timeout worker
 * needs Redis, and neither is wired here. A poll endpoint whose subject can never be created answers
 * PENDING forever, which reads as "your approval is on its way" to a caller who will never receive one.
 *
 * So it refuses as a whole rather than serving the half that happens to be reachable.
 */
export function escalationStatusRoute(): Route {
  return {
    method: "GET",
    pattern: ESCALATION_STATUS_ROUTE,
    bodyMode: "none",
    handler: async () =>
      refusal(
        "ESCALATION_NOT_CONFIGURED",
        "this deployment does not run escalations. The status read alone would be servable, but nothing " +
          "here can CREATE one — the fan-out needs the channel registry and the timeout worker needs " +
          "Redis — so a poll would answer PENDING forever about an approval that is not coming.",
        { "an approval raised through the account surface": "GET /consumer/approvals" },
      ),
  };
}

/**
 * The legacy approval decision, refused by name.
 *
 * This route predates the paid approval model and already refuses every service-call-backed request
 * with a 409, because deciding one here would write a terminal row with no action token, no consumed
 * nonce, no FINALIZED check and no budget recheck — a second, weaker path to the same tables. What is
 * left is pre-paid-model requests, and this deployment has none: those rows predate it.
 *
 * Named rather than left to the generic fallback so a caller is told the modern path exists rather
 * than that the endpoint is temporarily down.
 */
export function approvalDecideRoute(): Route {
  return {
    method: "POST",
    pattern: APPROVAL_DECIDE_ROUTE,
    bodyMode: "json",
    handler: async () =>
      refusal(
        "APPROVAL_DECIDE_LEGACY_ONLY",
        "this endpoint only ever served approval requests raised before the paid model, and this " +
          "deployment holds none. A paid request carries an action token that binds the answer to the " +
          "exact amount and recipient, and deciding one without that token is refused by design.",
        { "the approvals this account holds": "GET /consumer/approvals" },
      ),
  };
}
