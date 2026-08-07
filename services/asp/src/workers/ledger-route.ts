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

import { GET_LEDGER_ROUTE } from "../config";
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
