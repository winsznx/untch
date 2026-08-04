import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import express from "express";
import type { Server } from "node:http";
import {
  PgServiceCallStore,
  createPool,
  requestFingerprint,
  type Pool,
} from "@untch/consumer-core";
import { registerSettledReplayResolver } from "../src/consumer/settled-replay-resolver";

/**
 * The replay resolver, against a real database and a real Express stack.
 *
 * The property under test is not "does it return the old result". It is "does it decline to answer in
 * every case where answering would hand out unpaid work, and does it stay silent to a caller who
 * cannot authenticate". A resolver that is generous is a way to get free service calls, and one that
 * answers before authenticating is an oracle for whether an idempotency key exists on someone else's
 * account.
 *
 * The stand-in for `paymentMiddleware` is a terminal handler that records whether it was reached. If
 * the resolver ever calls `next()` for a FINALIZED call, or fails to for anything else, that handler
 * is what notices.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_replay_resolver";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ROUTE = "/preflight_payment";
const ACCOUNT = "acct_replayresolvertestacct01ab";
const OTHER_ACCOUNT = "acct_replayresolverotheracc01ab";

const TERMS = {
  provider: "untch",
  capability: "owned_work.demo",
  amount: "6.00",
  currency: "USDT0",
  policyId: "778001",
  deadline: "2026-08-04T12:00:00.000Z",
} as const;

const body = (idempotencyKey: string, over: Record<string, unknown> = {}) => ({
  provider: TERMS.provider,
  capability: TERMS.capability,
  maxSpend: TERMS.amount,
  currency: TERMS.currency,
  policyId: TERMS.policyId,
  deadline: TERMS.deadline,
  idempotencyKey,
  ...over,
});

describe("the already-settled replay resolver", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let store: PgServiceCallStore;
  let server: Server;
  let url: string;
  /** Set when the request got past the resolver, which in production is where payment would happen. */
  let reachedPaidPath = false;

  before(async () => {
    const admin = createPool(TEST_DB!);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DATABASE}`);
      await admin.query(`CREATE DATABASE ${OWN_DATABASE}`);
    } finally {
      await admin.end();
    }
    const u = new URL(TEST_DB!);
    u.pathname = `/${OWN_DATABASE}`;
    pool = createPool(u.toString());
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, file), "utf8"));
    }
    for (const id of [ACCOUNT, OTHER_ACCOUNT]) {
      await pool.query(
        `INSERT INTO untch_accounts (account_id, status, created_at, created_by, updated_at, updated_by)
         VALUES ($1,'ACTIVE', now(),'test', now(),'test') ON CONFLICT DO NOTHING`,
        [id],
      );
    }
    store = new PgServiceCallStore(pool);

    const app = express();
    registerSettledReplayResolver(app, ROUTE, () => ({
      pool,
      /** A bearer of `session:<accountId>` stands in for a real sealed session. */
      accountForSession: async (authorization) => {
        const bearer = /^Bearer\s+session:(.+)$/i.exec(authorization ?? "")?.[1];
        return bearer ? { accountId: bearer } : null;
      },
    }));
    app.post(ROUTE, express.json(), (_req, res) => {
      reachedPaidPath = true;
      res.status(200).json({ outcome: "REACHED_PAID_PATH" });
    });
    url = await new Promise<string>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        resolve(`http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`);
      });
    });
  });

  after(async () => {
    server?.close();
    await pool?.end();
  });

  const post = async (payload: unknown, auth: string | null) => {
    reachedPaidPath = false;
    const res = await fetch(`${url}${ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(payload),
    });
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
  };

  /** A service call in a chosen state, with the identity a replay would match on. */
  const callInState = async (idempotencyKey: string, state: string, accountId = ACCOUNT): Promise<string> => {
    const call = await store.upsertServiceCall({
      accountId,
      route: ROUTE,
      idempotencyKey,
      requestFingerprint: requestFingerprint({ ...TERMS }),
    });
    const settled = ["SETTLED", "FINALIZATION_PENDING", "FINALIZED"].includes(state);
    await pool.query(
      `UPDATE untch_x402_service_calls
          SET state = $2,
              settled_at = CASE WHEN $3::boolean THEN now() ELSE settled_at END,
              finalized_at = CASE WHEN $2 = 'FINALIZED' THEN now() ELSE finalized_at END
        WHERE service_call_id = $1`,
      [call.serviceCallId, state, settled],
    );
    return call.serviceCallId;
  };

  test("a FINALIZED call is replayed without reaching the paid path", async () => {
    const serviceCallId = await callInState("k-finalized", "FINALIZED");
    const res = await post(body("k-finalized"), `Bearer session:${ACCOUNT}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "ALREADY_SETTLED_REPLAY");
    assert.equal(res.body.serviceCallId, serviceCallId);
    assert.equal(reachedPaidPath, false, "no payment middleware, so nothing could settle");
    assert.equal(res.headers.get("idempotency-replayed"), "true");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("the replay carries no settlement header, because nothing settled here", async () => {
    await callInState("k-no-header", "FINALIZED");
    const res = await post(body("k-no-header"), `Bearer session:${ACCOUNT}`);
    for (const name of ["payment-response", "x-payment-response", "payment-receipt"]) {
      assert.equal(res.headers.get(name), null, `${name} would describe a transfer that did not happen`);
    }
    assert.equal(res.body.servicePaymentSettledOnThisRequest, false);
  });

  /**
   * The states that must NOT be replayed. Each one is a call whose fee nobody has proven, and
   * answering it would be handing out work for free.
   */
  for (const state of [
    "EVALUATED",
    "PAYMENT_AUTH_VERIFIED",
    "SETTLEMENT_PENDING",
    "SETTLED",
    "FINALIZATION_PENDING",
    "SETTLEMENT_FAILED",
    "CANCELLED",
  ]) {
    test(`a ${state} call falls through to the paid path`, async () => {
      await callInState(`k-${state}`, state);
      const res = await post(body(`k-${state}`), `Bearer session:${ACCOUNT}`);
      assert.equal(reachedPaidPath, true, `${state} is not proof of payment for this result`);
      assert.equal(res.body.outcome, "REACHED_PAID_PATH");
    });
  }

  test("an unauthenticated caller learns nothing and falls through", async () => {
    await callInState("k-unauth", "FINALIZED");
    const res = await post(body("k-unauth"), null);
    assert.equal(reachedPaidPath, true, "no session, no answer");
    assert.equal(res.body.outcome, "REACHED_PAID_PATH");
  });

  test("another account cannot replay a call it does not own", async () => {
    await callInState("k-owned", "FINALIZED", ACCOUNT);
    const res = await post(body("k-owned"), `Bearer session:${OTHER_ACCOUNT}`);
    assert.equal(reachedPaidPath, true, "the identity includes the account, so this matches nothing");
    assert.equal(res.body.outcome, "REACHED_PAID_PATH");
  });

  test("the same key with different terms is not a replay", async () => {
    await callInState("k-reused", "FINALIZED");
    const res = await post(body("k-reused", { maxSpend: "6.50" }), `Bearer session:${ACCOUNT}`);
    assert.equal(reachedPaidPath, true, "a client key cannot make one obligation stand for another");
  });

  test("a request with no idempotency key is never replayed", async () => {
    await callInState("k-none", "FINALIZED");
    const payload = body("k-none");
    delete (payload as Record<string, unknown>).idempotencyKey;
    await post(payload, `Bearer session:${ACCOUNT}`);
    assert.equal(reachedPaidPath, true);
  });

  test("an unknown key falls through rather than answering", async () => {
    await post(body("k-never-existed"), `Bearer session:${ACCOUNT}`);
    assert.equal(reachedPaidPath, true);
  });
});
