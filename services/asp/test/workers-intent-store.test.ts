import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PgIntentStore } from "../src/workers/intent-store";

/**
 * The bigint round trip, which is the whole reason this store needed care.
 *
 * A canonical spend intent carries five uint256 fields — `buyerAgentId`, `workerAgentId`, `maxAmount`,
 * `deadline`, `nonce` — and `JSON.stringify` throws outright on a BigInt rather than coercing it. The
 * first cut of this store hit that as a 500 on every `create_spend_intent`.
 *
 * The fix that looks obvious is to write them as strings. That is worse than the crash: the intent
 * would come back with strings where bigints were, hash to a different value, and become unspendable —
 * failing later, quietly, and against money. So the tags are asserted to round-trip as bigints, not
 * merely to survive.
 */

/** A pool stub that records the SQL and replays whatever was written, as jsonb would. */
function fakePool() {
  const stored = new Map<string, unknown>();
  const pool = {
    async query(sql: string, params: readonly unknown[] = []) {
      if (sql.includes("INSERT INTO untch_spend_intents")) {
        stored.set(String(params[0]), JSON.parse(String(params[1])));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT intent FROM untch_spend_intents")) {
        const row = stored.get(String(params[0]));
        return { rows: row === undefined ? [] : [{ intent: row }], rowCount: row === undefined ? 0 : 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as never, stored };
}

const INTENT = {
  owner: "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64",
  buyerAgentId: 6047n,
  workerAgentId: 6086n,
  token: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  maxAmount: 2_000_000n,
  deadline: 1_790_000_000n,
  nonce: 1n,
  taskHash: `0x${"11".repeat(32)}`,
  nested: { inner: 42n, list: [1n, 2n, "three"] },
};

describe("a spend intent survives storage unchanged", () => {
  test("bigints come back as bigints, not strings", async () => {
    const { pool } = fakePool();
    const store = new PgIntentStore(pool);
    await store.put(`0x${"ab".repeat(32)}`, INTENT);
    const back = (await store.get(`0x${"ab".repeat(32)}`)) as typeof INTENT;

    assert.equal(typeof back.buyerAgentId, "bigint", "a uint256 that returns as a string changes the hash");
    assert.equal(back.buyerAgentId, 6047n);
    assert.equal(back.maxAmount, 2_000_000n);
    assert.equal(back.deadline, 1_790_000_000n);
    assert.equal(back.nonce, 1n);
  });

  test("the whole structure is identical, nesting and arrays included", async () => {
    const { pool } = fakePool();
    const store = new PgIntentStore(pool);
    await store.put(`0x${"cd".repeat(32)}`, INTENT);
    assert.deepEqual(await store.get(`0x${"cd".repeat(32)}`), INTENT);
  });

  test("strings that merely look numeric are left alone", async () => {
    const { pool } = fakePool();
    const store = new PgIntentStore(pool);
    const body = { amount: "2000000", count: 5, flag: true, missing: null };
    await store.put(`0x${"ef".repeat(32)}`, body);
    const back = (await store.get(`0x${"ef".repeat(32)}`)) as typeof body;
    assert.equal(typeof back.amount, "string", "a string the caller sent must not become a bigint");
    assert.deepEqual(back, body);
  });

  /**
   * The hash is derived from the content, so an identical hash means an identical intent. Refusing the
   * second write would make a harmless retry look like a conflict.
   */
  test("re-putting the same hash is not an error", async () => {
    const { pool } = fakePool();
    const store = new PgIntentStore(pool);
    await store.put(`0x${"11".repeat(32)}`, INTENT);
    await store.put(`0x${"11".repeat(32)}`, INTENT);
    assert.deepEqual(await store.get(`0x${"11".repeat(32)}`), INTENT);
  });

  test("an unknown hash is undefined rather than an empty object", async () => {
    const { pool } = fakePool();
    const store = new PgIntentStore(pool);
    assert.equal(await store.get(`0x${"99".repeat(32)}`), undefined);
  });

  test("lookup is case-insensitive, because a hash is not two different keys", async () => {
    const { pool } = fakePool();
    const store = new PgIntentStore(pool);
    await store.put(`0x${"AB".repeat(32)}`, INTENT);
    assert.deepEqual(await store.get(`0x${"ab".repeat(32)}`), INTENT);
  });
});
