import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { recordSale, type SettledSale } from "../src/workers/sales";

/**
 * The sales recorder, which exists because four real settlements left no trace.
 *
 * The end-to-end proof needs a buyer to actually pay, so these pin the properties that can be checked
 * without one: that a sale is written at all, that the buyer is one buyer rather than two spellings of
 * the same address, that a replayed authorization cannot become a second sale, and — most importantly —
 * that a bookkeeping failure never costs the buyer the work they already paid for.
 */

function fakePool() {
  const inserts: { sql: string; params: readonly unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: readonly unknown[] = []) {
      inserts.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  return { pool: pool as never, inserts };
}

const SALE: SettledSale = {
  route: "/builder/suggest_names",
  payer: "0x57A3660E8D10A89DFAEE9C130A73C9BCC76E8950",
  payTo: "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba",
  token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  network: "eip155:196",
  amountBaseUnits: "10000",
  transactionHash: `0x${"f6".repeat(32)}`,
  facilitatorStatus: "success",
  responseStatus: 200,
  responseBytes: 512,
  authorizationNonce: `0x${"ab".repeat(32)}`,
};

describe("a settled sale is written down", () => {
  test("the row carries everything needed to reconcile it", async () => {
    const { pool, inserts } = fakePool();
    await recordSale(pool, SALE);

    assert.equal(inserts.length, 1);
    const { sql, params } = inserts[0]!;
    assert.match(sql, /INSERT INTO untch_marketplace_sales/);
    assert.ok(params.includes("10000"), "the amount must be stored exactly, in base units");
    assert.ok(params.includes(SALE.transactionHash), "a sale with no transaction cannot be verified on chain");
    assert.ok(params.includes(200), "the HTTP outcome distinguishes a delivered sale from an empty one");
  });

  /**
   * The registry's stable id, not the path. A route rename would otherwise orphan every historical sale
   * of that tool.
   */
  test("the tool is identified by its registry id, resolved from the route", async () => {
    const { pool, inserts } = fakePool();
    await recordSale(pool, SALE);
    assert.ok(inserts[0]!.params.includes("suggest_names"), "the sale must name the tool, not just the path");
  });

  test("an unknown route still records, with a null tool id", async () => {
    const { pool, inserts } = fakePool();
    await recordSale(pool, { ...SALE, route: "/not/a/registered/tool" });
    assert.equal(inserts.length, 1, "an unrecognised route is still money received");
    assert.ok(inserts[0]!.params.includes(null));
  });

  /**
   * One buyer, not two. A checksummed address from one client and a lowercase one from another are the
   * same wallet, and a seller answering "what did this buyer purchase" must not miss half of it.
   */
  test("addresses are normalised so one buyer reads as one buyer", async () => {
    const { pool, inserts } = fakePool();
    await recordSale(pool, SALE);
    const params = inserts[0]!.params as string[];
    assert.ok(params.includes(SALE.payer.toLowerCase()));
    assert.ok(params.includes(SALE.payTo.toLowerCase()));
    assert.ok(params.includes(SALE.token.toLowerCase()));
    assert.ok(!params.includes(SALE.payer), "the checksummed form must not also be stored");
  });

  test("a replayed authorization cannot become a second sale", async () => {
    const { pool, inserts } = fakePool();
    await recordSale(pool, SALE);
    assert.match(
      inserts[0]!.sql,
      /ON CONFLICT \(authorization_nonce\).*DO NOTHING/s,
      "the nonce is what makes a replay visible; without this the same payment records twice",
    );
  });

  /**
   * THE ASYMMETRY THAT IS DELIBERATE.
   *
   * The buyer has paid and the handler has produced their result. Throwing here would deny them work
   * they already paid for in order to protect a bookkeeping row. Money moving without a record is bad;
   * money moving without the buyer receiving anything is worse.
   */
  test("a write failure is loud but never denies the buyer their result", async () => {
    const lines: string[] = [];
    const brokenPool = {
      async query() {
        throw new Error("relation does not exist");
      },
    } as never;

    await assert.doesNotReject(() => recordSale(brokenPool, SALE, (l) => lines.push(l)));

    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /FAILED TO RECORD A SETTLED SALE/);
    for (const needed of [SALE.payer, SALE.amountBaseUnits, SALE.transactionHash!, SALE.authorizationNonce!]) {
      assert.ok(
        lines[0]!.includes(needed),
        "the log must carry enough to rebuild the row by hand from the chain",
      );
    }
  });
});
