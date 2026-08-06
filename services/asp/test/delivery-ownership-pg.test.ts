import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPool, projectDeliveries, type Pool } from "@untch/consumer-core";
import {
  createOwnedAccount,
  createOwnedBinding,
  deliveriesForRequest,
  deliveryFor,
  deliveryOwnership,
  dropOwnedFixtures,
} from "./fixtures/delivery-ownership";

/**
 * The regression suite for a flaky test, and for the property the flakiness was hiding.
 *
 * WHAT WENT WRONG
 *
 * `projectDeliveries` creates one delivery per eligible ACTIVE binding — correct behaviour. Several
 * tests in the delivery suites shared one account, so a binding created by an earlier test was still
 * ACTIVE when a later test projected its own request, and the later test silently got two rows. Its
 * assertion read `rows[0]` from an unordered SELECT, so whether it passed came down to which row
 * PostgreSQL returned first. It passed on CI's build and failed on another, and in neither case was
 * it asserting what it claimed.
 *
 * These tests fail if that ever comes back, and they assert the product behaviour that was previously
 * being asserted only by accident: one delivery per eligible binding, never two for the same pair.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_delivery_ownership";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

describe("delivery projection is decided by ownership, never by row order", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;

  before(async () => {
    const admin = createPool(TEST_DB!);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DATABASE}`);
      await admin.query(`CREATE DATABASE ${OWN_DATABASE}`);
    } finally {
      await admin.end();
    }
    const url = new URL(TEST_DB!);
    url.pathname = `/${OWN_DATABASE}`;
    pool = createPool(url.toString());
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, f), "utf8"));
    }
  });

  after(async () => {
    await pool?.end();
  });

  /** A PENDING request plus the outbox event that makes it projectable. */
  async function raiseRequest(own: ReturnType<typeof deliveryOwnership>, suffix = ""): Promise<string> {
    const id = suffix ? `${own.approvalRequestId}${suffix}`.slice(0, 40) : own.approvalRequestId;
    await pool.query(
      `INSERT INTO untch_approval_requests
         (approval_request_id, account_id, state, reason, provider, capability, amount, asset, recipient,
          policy_id, policy_version, nonce, expires_at, approval_digest, intent_id, quote_hash,
          created_at, created_by, updated_at, updated_by)
       VALUES ($1,$2,'PENDING','ESCALATED_THRESHOLD','untch','owned_work.demo',6.00,'USDT0','0xr',
               '991002',1,$3, now() + interval '1 hour',$4,$5,$6, now(),'test', now(),'test')`,
      [id, own.accountId, own.extra(`n${suffix}`), own.extra(`apd${suffix}`), own.extra(`int${suffix}`), own.extra(`qh${suffix}`)],
    );
    await pool.query(
      `INSERT INTO untch_approval_outbox (event_id, approval_request_id, name)
       VALUES ($1,$2,'approval.request.ready.v1')`,
      [`${own.outboxEventId}${suffix}`.slice(0, 40), id],
    );
    return id;
  }

  /**
   * THE ORIGINAL FAILURE, REPRODUCED.
   *
   * One account holds a binding another test created, plus its own. Before the fix a later test read
   * `rows[0]` and got whichever the database returned first. Here both are asserted by name.
   */
  test("an account with two active bindings gets exactly one delivery per binding, each identifiable", async () => {
    const own = deliveryOwnership("two active bindings");
    try {
      await createOwnedAccount(pool, own);
      const first = await createOwnedBinding(pool, own);
      const second = await createOwnedBinding(pool, own, {
        bindingId: `cbnd_${own.extra("second")}`,
        channelUserId: own.extraChannelUserId("second"),
        channelChatId: "998877665544332211",
        verificationMethod: "discord_guild_member",
      });

      const id = await raiseRequest(own);
      await projectDeliveries(pool, { limit: 20 });

      const all = await deliveriesForRequest(pool, id);
      assert.equal(all.length, 2, "one delivery per eligible active binding");

      const a = await deliveryFor(pool, id, first);
      const b = await deliveryFor(pool, id, second);
      assert.ok(a, "the first binding has its own delivery");
      assert.ok(b, "the second binding has its own delivery");
      assert.notEqual(a!.delivery_id, b!.delivery_id, "two bindings must not share one delivery row");
    } finally {
      await dropOwnedFixtures(pool, own);
    }
  });

  /**
   * The isolation claim itself: another test's ACTIVE binding must never become eligible for this
   * account's request. Before the fix this is exactly what leaked.
   */
  test("a neighbouring account's active binding is never eligible for this account's request", async () => {
    const neighbour = deliveryOwnership("noisy neighbour");
    const mine = deliveryOwnership("isolated account");
    try {
      await createOwnedAccount(pool, neighbour);
      await createOwnedBinding(pool, neighbour);

      await createOwnedAccount(pool, mine);
      const myBinding = await createOwnedBinding(pool, mine);

      const id = await raiseRequest(mine);
      await projectDeliveries(pool, { limit: 20 });

      const all = await deliveriesForRequest(pool, id);
      assert.equal(all.length, 1, "exactly its own delivery, whatever else is active in the database");
      assert.equal(all[0]!.channel_binding_id, myBinding);
    } finally {
      await dropOwnedFixtures(pool, mine);
      await dropOwnedFixtures(pool, neighbour);
    }
  });

  test("a revoked binding produces no delivery", async () => {
    const own = deliveryOwnership("revoked binding");
    try {
      await createOwnedAccount(pool, own);
      await createOwnedBinding(pool, own, { status: "REVOKED" });
      const id = await raiseRequest(own);
      await projectDeliveries(pool, { limit: 20 });
      assert.equal((await deliveriesForRequest(pool, id)).length, 0);
    } finally {
      await dropOwnedFixtures(pool, own);
    }
  });

  test("repeated projection is idempotent — no second row for the same request and binding", async () => {
    const own = deliveryOwnership("idempotent projection");
    try {
      await createOwnedAccount(pool, own);
      const binding = await createOwnedBinding(pool, own);
      const id = await raiseRequest(own);

      await projectDeliveries(pool, { limit: 20 });
      await projectDeliveries(pool, { limit: 20 });
      await projectDeliveries(pool, { limit: 20 });

      assert.equal((await deliveriesForRequest(pool, id)).length, 1);
      // deliveryFor throws when it finds more than one, which is the duplicate this asserts against.
      assert.ok(await deliveryFor(pool, id, binding));
    } finally {
      await dropOwnedFixtures(pool, own);
    }
  });

  test("concurrent projection produces no duplicate request/binding pair", async () => {
    const own = deliveryOwnership("concurrent projection");
    try {
      await createOwnedAccount(pool, own);
      const binding = await createOwnedBinding(pool, own);
      const id = await raiseRequest(own);

      await Promise.all([
        projectDeliveries(pool, { limit: 20 }),
        projectDeliveries(pool, { limit: 20 }),
        projectDeliveries(pool, { limit: 20 }),
        projectDeliveries(pool, { limit: 20 }),
      ]);

      assert.equal((await deliveriesForRequest(pool, id)).length, 1, "four concurrent projections, one row");
      assert.ok(await deliveryFor(pool, id, binding));
    } finally {
      await dropOwnedFixtures(pool, own);
    }
  });

  /**
   * The property the old assertion could not have proven. Running the same scenario repeatedly with
   * two bindings would, under the old shape, have returned a different `rows[0]` sooner or later.
   * Selecting by binding makes the answer identical every time.
   */
  test("the same scenario repeated many times gives an identical answer every time", async () => {
    for (let i = 0; i < 12; i += 1) {
      const own = deliveryOwnership(`repeatable run ${i}`);
      try {
        await createOwnedAccount(pool, own);
        const primary = await createOwnedBinding(pool, own);
        await createOwnedBinding(pool, own, {
          bindingId: `cbnd_${own.extra("alt")}`,
          channelUserId: own.extraChannelUserId("alt"),
          channelChatId: "112233445566778899",
          verificationMethod: "discord_guild_member",
        });

        const id = await raiseRequest(own);
        await projectDeliveries(pool, { limit: 20 });

        const row = await deliveryFor(pool, id, primary);
        assert.ok(row, `run ${i}: the primary binding's delivery must always be findable`);
        assert.equal(row!.channel_binding_id, primary, `run ${i}: and must always be the right one`);
        assert.equal((await deliveriesForRequest(pool, id)).length, 2, `run ${i}: two bindings, two deliveries`);
      } finally {
        await dropOwnedFixtures(pool, own);
      }
    }
  });

  test("independently owned accounts projecting at the same time do not affect each other", async () => {
    const owners = Array.from({ length: 6 }, (_, i) => deliveryOwnership(`parallel owner ${i}`));
    try {
      const ids = await Promise.all(
        owners.map(async (own) => {
          await createOwnedAccount(pool, own);
          const binding = await createOwnedBinding(pool, own);
          const id = await raiseRequest(own);
          return { own, binding, id };
        }),
      );

      await Promise.all(owners.map(() => projectDeliveries(pool, { limit: 50 })));

      for (const { binding, id } of ids) {
        const all = await deliveriesForRequest(pool, id);
        assert.equal(all.length, 1, "each owner gets exactly its own delivery");
        assert.equal(all[0]!.channel_binding_id, binding);
      }
    } finally {
      for (const own of owners) await dropOwnedFixtures(pool, own);
    }
  });

  test("cleanup runs even when an assertion fails, so one red test does not create others", async () => {
    const own = deliveryOwnership("cleanup on failure");
    await assert.rejects(async () => {
      try {
        await createOwnedAccount(pool, own);
        await createOwnedBinding(pool, own);
        await raiseRequest(own);
        throw new Error("simulated assertion failure");
      } finally {
        await dropOwnedFixtures(pool, own);
      }
    }, /simulated assertion failure/);

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM untch_channel_bindings WHERE account_id = $1`,
      [own.accountId],
    );
    assert.equal(rows[0]!.n, "0", "a failed test must leave no ACTIVE binding behind");
  });
});
