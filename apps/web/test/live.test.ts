import assert from "node:assert/strict";
import { test } from "node:test";
import {
  livePolicies,
  liveIntentStream,
  liveLedger,
  liveEscalations,
  liveVendors,
  liveBuyerScores,
  liveSavings,
  liveReconcile,
  liveDispute,
} from "../lib/dashboard/live";

/**
 * The scoping/safety contract of the live read layer: with no shared DB configured (DATABASE_URL unset — as
 * in CI / local dev), every read is an honest EMPTY result — never a throw, and never a global unscoped read.
 * A signed-out (null) address is empty for the same reason. In production DATABASE_URL is set and these same
 * functions read the operator's real rows; that path needs the shared Postgres and is covered by the live
 * integration proof, not this unit test.
 */

const OWNER = "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b";

test("no DATABASE_URL ⇒ every scoped read is empty and never throws", async () => {
  delete process.env.DATABASE_URL;
  assert.deepEqual(await livePolicies(OWNER), []);
  assert.deepEqual(await liveIntentStream(OWNER), []);
  assert.deepEqual(await liveLedger(OWNER), []);
  assert.deepEqual(await liveEscalations(OWNER), []);
  assert.deepEqual(await liveVendors(OWNER), []);
  assert.deepEqual(await liveBuyerScores(OWNER), []);
  assert.equal(await liveReconcile(OWNER), null);
  assert.equal(await liveDispute(OWNER), null);
  const s = await liveSavings(OWNER);
  assert.equal(s.reservedAuthority, 0);
  assert.equal(s.dailyBudget, 0);
});

test("a null (signed-out) address is empty too", async () => {
  assert.deepEqual(await livePolicies(null), []);
  assert.deepEqual(await liveIntentStream(null), []);
  assert.deepEqual(await liveEscalations(null), []);
});
