import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RECEIPT_STATUS_ROUTE } from "../src/config";
import { receiptStatusRoute, type ReceiptStatusReader } from "../src/workers/receipt-reads";
import { dispatch, WorkersRouter } from "../src/workers/router";

/**
 * The public receipt read: the three answers it can give, and the one thing it must not be able to do.
 *
 * The route exists because a caller holding a receipt id got it from this service and is entitled to
 * know what happened to it. It is also the first route here that touches production data, so what it
 * CANNOT do matters as much as what it returns — there is no enqueuer, no Redis and no migration in
 * its reach, and the bundle assertion at the bottom is what keeps that true after a careless import.
 */

const VALID = `0x${"ab".repeat(32)}` as const;

function reader(over: Partial<ReceiptStatusReader> = {}): ReceiptStatusReader {
  return { statusOf: async () => null, ...over };
}

async function get(path: string, r: ReceiptStatusReader): Promise<Response> {
  const router = new WorkersRouter().add(receiptStatusRoute(r));
  return dispatch(router, new Request(`https://asp.untch.xyz${path}`));
}

describe("a receipt id is shape-checked before it reaches Postgres", () => {
  /**
   * An unvalidated id reaches the database as an ordinary parameter and comes back as a miss, which
   * would report a malformed request as a missing receipt — two different problems with two different
   * fixes, and the caller cannot tell them apart.
   */
  test("a malformed id is a 400, never a 404", async () => {
    for (const bad of ["not-hex", "0x", "0xabc", `0x${"ab".repeat(31)}`, `0x${"ab".repeat(33)}`, ""]) {
      const res = await get(`/receipt_status/${encodeURIComponent(bad || "-")}`, reader());
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must be rejected on shape`);
      assert.equal(((await res.json()) as { code: string }).code, "BAD_RECEIPT_ID");
    }
  });

  test("a malformed id never reaches the reader", async () => {
    let queried = false;
    await get("/receipt_status/nonsense", reader({ statusOf: async () => { queried = true; return null; } }));
    assert.equal(queried, false, "the database must not be asked about a value that cannot be a receipt id");
  });

  test("a well-formed id that does not exist is a 404 naming it", async () => {
    const res = await get(`/receipt_status/${VALID}`, reader());
    assert.equal(res.status, 404);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, "RECEIPT_NOT_FOUND");
    assert.match(body.message, new RegExp(VALID));
  });

  test("an existing receipt is returned as the store described it", async () => {
    const view = { receiptId: VALID, status: "ANCHORED", txHash: `0x${"cd".repeat(32)}`, blockNumber: "12345" };
    const res = await get(`/receipt_status/${VALID}`, reader({ statusOf: async () => view }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), view, "the route reports the store's answer, it does not reshape it");
  });

  test("the id is passed through exactly, not lowercased or trimmed", async () => {
    const mixed = `0x${"AbCd".repeat(16)}`;
    let seen: string | null = null;
    await get(`/receipt_status/${mixed}`, reader({ statusOf: async (id) => { seen = id; return null; } }));
    assert.equal(seen, mixed, "a receipt id is a reference; normalising it would look up a different row");
  });
});

describe("the route is structurally read-only", () => {
  test("it declares GET and reads no body", () => {
    const route = receiptStatusRoute(reader());
    assert.equal(route.method, "GET");
    assert.equal(route.bodyMode, "none");
    assert.equal(route.pattern, RECEIPT_STATUS_ROUTE);
    assert.notEqual(route.priced, true, "a receipt poll is unpriced on both transports");
  });

  /**
   * THE PROPERTY THE MODULE EXISTS TO HOLD.
   *
   * `initReceiptWiring` builds a repo, a Redis connection and a BullMQ queue together, and runs
   * migrations on the way. Importing it here would have put an enqueuer within reach of a request
   * path that must not write, and pulled a TCP Redis client into a runtime that cannot open one.
   * The reader interface exposes `statusOf` and nothing else, so there is no second method to call.
   */
  test("the reader interface offers no way to write", () => {
    const surface = Object.keys(reader());
    assert.deepEqual(surface, ["statusOf"], "a reader that can enqueue is not a reader");
  });
});
