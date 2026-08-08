/**
 * The public receipt read, `/consumer/receipt/:intentId`.
 *
 * WHAT WAS WRONG
 *
 * The README hands anyone a public receipt URL, both an API call and a page at
 * `untch.xyz/receipt/:intentId`. After the cutover the API answered 503 "being migrated to Cloudflare
 * Workers, not callable yet", so the page loaded but never populated and the receipt looked lost. The
 * data was not lost. The ROUTE was one of the reads left at the Stage 1 fallback.
 *
 * It is a pure, unscoped read over the consumer store, the same shape as the account reads and
 * `receipt_status` already ported. No auth: a receipt nobody can see is not a receipt. No writes, no
 * signing, no orchestrator. So it is served here directly.
 *
 * If the intent exists in Postgres it returns; if it does not, the honest answer is 404. Porting this
 * is also how we find out whether the referenced receipt survived the Supabase migration.
 */

import { PgConsumerStore, type Pool } from "@untch/consumer-core";
import { getReceiptStatus, isReceiptId, PgReceiptsRepo } from "@untch/receipt-writer";
import type { Hex } from "viem";
import { handlePublicConsumerReceipt } from "../consumer/handlers";
import { PUBLIC_RECEIPT_ROUTE } from "../consumer/routes";
import type { HandlerResult } from "../handlers";
import type { Route, RouteRequest } from "./router";

const send = (r: HandlerResult, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(r.body, null, 2), {
    status: r.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extraHeaders,
      ...(r.headers ?? {}),
    },
  });

export interface ConsumerReceiptDeps {
  readonly pool: Pool;
  readonly publicBaseUrl: string;
}

export function consumerReceiptRoute(deps: ConsumerReceiptDeps): Route {
  return {
    method: "GET",
    pattern: PUBLIC_RECEIPT_ROUTE,
    bodyMode: "none",
    handler: async (req: RouteRequest) => {
      const intentId = req.params.intentId ?? "";

      const store = new PgConsumerStore(deps.pool as never);
      const repo = new PgReceiptsRepo(deps.pool as never);

      /**
       * The receipt's anchor status, looked up per receipt id. A malformed id is `invalid` rather
       * than a miss, so a bad id and an unanchored receipt do not read the same.
       */
      const receiptStatus = async (receiptId: string) => {
        if (!isReceiptId(receiptId)) return "invalid" as const;
        return getReceiptStatus(repo, receiptId as Hex);
      };

      /**
       * `orchestrator` is required by the deps type but never touched on this read path, so a thrower
       * stands in for it. If a future change makes this route reach for it, that throw is a louder and
       * more findable failure than a half-real object.
       */
      const conDeps = {
        store,
        publicBaseUrl: deps.publicBaseUrl,
        orchestrator: new Proxy(
          {},
          { get() { throw new Error("the public receipt read must not use the orchestrator"); } },
        ),
      } as never;

      const result = await handlePublicConsumerReceipt(intentId, conDeps, receiptStatus);
      // Immutable once anchored; the pending states move on a batch interval, not per request.
      return send(result, { "cache-control": "public, max-age=15" });
    },
  };
}

/** The path this module serves, so the route classifier reads truth rather than a guess. */
export const CONSUMER_RECEIPT_PATHS = [PUBLIC_RECEIPT_ROUTE] as const;
