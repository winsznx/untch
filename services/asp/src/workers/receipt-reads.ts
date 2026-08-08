/**
 * The public receipt read, carrying none of the machinery that writes one.
 *
 * WHY NOT `initReceiptWiring`
 *
 * The seller's receipt wiring builds three things at once: a Postgres repo, a Redis connection, and a
 * BullMQ tick queue — and it runs migrations on the way. Only the first is needed to answer "what
 * happened to receipt 0x…". The other three are how a receipt gets ENQUEUED, and this deployment must
 * not be able to enqueue one: Railway still owns production writes.
 *
 * Reaching for the wiring would have imported ioredis and bullmq into a Worker that cannot open a TCP
 * connection to Redis anyway, and would have run a migration from a request path that is explicitly
 * forbidden from mutating the schema. So the read is assembled from the two pieces it actually needs.
 * The structural consequence is the point: there is no enqueuer in this module to call by mistake.
 *
 * WHY THE 404 IS A REAL ANSWER
 *
 * `statusOf` deliberately reads the base table rather than the business view. A receipt looked up by
 * its own id is an explicit reference — someone holds that id because this service gave it to them —
 * and answering "no such receipt" about a row that exists would be a lie told to the one caller
 * entitled to the truth.
 */

import type { Pool } from "@untch/consumer-core";
import { PgReceiptsRepo } from "@untch/receipt-writer/src/repo-pg";
import { isReceiptId } from "@untch/receipt-writer/src/status";
import { LOG_RECEIPT_ROUTE, RECEIPT_STATUS_ROUTE } from "../config";
import type { Route } from "./router";

/** The same envelope every other refusal on this host uses. */
const errorBody = (code: string, message: string): Record<string, unknown> => ({
  code,
  message,
  retryable: false,
  docsUrl: null,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });

/** Narrowed to the one method this route needs, so a writer cannot be passed in by accident. */
export interface ReceiptStatusReader {
  statusOf(receiptId: `0x${string}`): Promise<unknown | null>;
}

export function receiptStatusRoute(reader: ReceiptStatusReader): Route {
  return {
    method: "GET",
    pattern: RECEIPT_STATUS_ROUTE,
    bodyMode: "none",
    handler: async (req) => {
      const receiptId = req.params.receiptId ?? "";
      /**
       * Shape-checked before the query, not after. An unvalidated id reaches Postgres as a parameter
       * and comes back as an ordinary miss, which would report a malformed request as a missing
       * receipt — two different problems with two different fixes.
       */
      if (!isReceiptId(receiptId)) {
        return json(errorBody("BAD_RECEIPT_ID", "receiptId must be a 0x-prefixed 32-byte hex string"), 400);
      }

      const view = await reader.statusOf(receiptId);
      if (view === null) {
        return json(errorBody("RECEIPT_NOT_FOUND", `no receipt with id ${receiptId}`), 404);
      }
      return json(view);
    },
  };
}

/** The production reader: a Postgres repo over Hyperdrive, and nothing that can write. */
export const receiptReader = (pool: Pool): ReceiptStatusReader =>
  new PgReceiptsRepo(pool as never) as unknown as ReceiptStatusReader;

/**
 * `log_receipt`, which despite the name only READS.
 *
 * It was left on the 503 because the Express wiring it asks for — `ReceiptWiring` — builds a Postgres
 * repo AND a Redis connection AND a tick queue together, and a Worker has no Redis. But Redis is how a
 * receipt gets ENQUEUED; status comes from Postgres alone. The route was blocked by a dependency it
 * never used.
 *
 * So it is the POST-bodied twin of `receipt_status`, over the same reader, and this deployment still
 * cannot write a receipt. The registry calls it ACCOUNT_CONTROL rather than listable for that reason:
 * it answers about a receipt some earlier paid call produced, and creates nothing.
 */
export function logReceiptRoute(reader: ReceiptStatusReader): Route {
  return {
    method: "POST",
    pattern: LOG_RECEIPT_ROUTE,
    bodyMode: "json",
    handler: async (req) => {
      const receiptId = (req.body as { receiptId?: unknown } | undefined)?.receiptId;
      if (typeof receiptId !== "string" || receiptId.length === 0) {
        return json(
          errorBody("RECEIPT_ID_REQUIRED", "provide receiptId from a prior preflight/verify"),
          400,
        );
      }
      // Same ordering as the GET: a malformed id is a bad request, not a missing receipt.
      if (!isReceiptId(receiptId)) {
        return json(errorBody("RECEIPT_ID_INVALID", "receiptId is not a valid hex id"), 400);
      }
      const view = await reader.statusOf(receiptId as `0x${string}`);
      if (view === null) {
        return json(errorBody("RECEIPT_NOT_FOUND", `no receipt with id ${receiptId}`), 404);
      }
      return json({ receiptId, status: view });
    },
  };
}
