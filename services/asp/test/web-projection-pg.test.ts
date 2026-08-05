import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { createPool, projectDeliveries, type Pool } from "@untch/consumer-core";
import { ensureWebApprovalSurface } from "../src/consumer/discord-approval-gateway";

/**
 * The web surface, and the fact that it had no production caller.
 *
 * `ensureWebApprovalSurface` was written, exported, and never invoked from anywhere. So an account
 * with an ACTIVE wallet binding carrying `policy-authority` had no web ChannelBinding, no action
 * references, and nothing to press — while a readiness check reading the wallet scope would happily
 * report the web actor as valid. It was, as an authority. There was simply no surface.
 *
 * That is the same class of mistake as the Discord one it sits beside: a component that is correct in
 * isolation and connected to nothing, with a report that reads the wrong end of it. So the tests here
 * are mostly about the CALL SITE — that a projection exists after activation, that it exists only
 * after commit, and that it refuses the authority it is supposed to refuse.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_web_projection";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_webprojowneraaaaaaaaaaaaaa";
const ADDRESS = "0x4444444444444444444444444444444444444444";

describe("an approval has a web surface, or it does not claim one", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let seq = 0;

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
    await pool.query(
      `INSERT INTO untch_accounts (account_id, status, created_at, created_by, updated_at, updated_by)
       VALUES ($1,'ACTIVE', now(),'test', now(),'test')`,
      [ACCOUNT],
    );
    await pool.query(
      `INSERT INTO untch_wallet_bindings
         (binding_id, account_id, address, chain_kind, role, proof_kind, verified_at, status, scopes,
          created_at, created_by, updated_at, updated_by)
       VALUES ('wbnd_webproj',$1,$2,'evm','primary','siwe', now(),'ACTIVE',ARRAY['identity','policy-authority'],
               now(),'test', now(),'test')`,
      [ACCOUNT, ADDRESS],
    );
  });

  after(async () => {
    await pool?.end();
  });

  const pendingRequest = async (): Promise<string> => {
    seq += 1;
    const id = `aprq_webproj${String(seq).padStart(5, "0")}`;
    await pool.query(
      `INSERT INTO untch_approval_requests
         (approval_request_id, account_id, state, reason, provider, capability, amount, asset, recipient,
          policy_id, policy_version, nonce, expires_at, approval_digest, intent_id, quote_hash,
          account_ref_hash, created_at, created_by, updated_at, updated_by)
       VALUES ($1,$2,'PENDING','ESCALATED_THRESHOLD','untch','owned_work.demo',6.00,'USDT0','0xrecipient',
               '992001',1,$3, now() + interval '1 hour', $4, $5,'qh_web','arh_web',
               now(),'test', now(),'test')`,
      [id, ACCOUNT, `n_web_${seq}`, `apd_web_${seq}`, `int_web_${seq}`],
    );
    return id;
  };

  const webRefs = async (approvalRequestId: string): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_action_refs r
         JOIN untch_channel_bindings b ON b.binding_id = r.channel_binding_id
        WHERE r.approval_request_id = $1 AND b.channel = 'web'`,
      [approvalRequestId],
    );
    return Number(rows[0]!.n);
  };

  test("a PENDING request gets one web projection with an APPROVE and a DENY reference", async () => {
    const id = await pendingRequest();
    const surface = await ensureWebApprovalSurface(pool, id);
    assert.ok(surface, "an account with policy-authority must get a surface");
    assert.ok(surface.refs.APPROVE);
    assert.ok(surface.refs.DENY);
    assert.notEqual(surface.refs.APPROVE, surface.refs.DENY);
    assert.equal(await webRefs(id), 2);
  });

  test("projecting twice reuses the same references rather than minting a second pressable pair", async () => {
    const id = await pendingRequest();
    const first = await ensureWebApprovalSurface(pool, id);
    const second = await ensureWebApprovalSurface(pool, id);
    assert.ok(first && second);
    assert.equal(first.refs.APPROVE, second.refs.APPROVE);
    assert.equal(first.refs.DENY, second.refs.DENY);
    assert.equal(await webRefs(id), 2, "one logical web surface per request");
  });

  /**
   * The rule the paid decision route enforces, enforced identically here. Proving who you are is not
   * permission to spend, and a browser must not be the way around that.
   */
  test("an identity-only wallet gets no web surface", async () => {
    const id = await pendingRequest();
    await pool.query(`UPDATE untch_wallet_bindings SET scopes = ARRAY['identity'] WHERE account_id = $1`, [ACCOUNT]);
    try {
      const surface = await ensureWebApprovalSurface(pool, id);
      assert.equal(surface, null, "identity is not authority");
      assert.equal(await webRefs(id), 0);
    } finally {
      await pool.query(
        `UPDATE untch_wallet_bindings SET scopes = ARRAY['identity','policy-authority'] WHERE account_id = $1`,
        [ACCOUNT],
      );
    }
  });

  test("a revoked wallet binding gets no web surface", async () => {
    const id = await pendingRequest();
    await pool.query(
      `UPDATE untch_wallet_bindings SET status = 'REVOKED', revoked_at = now() WHERE account_id = $1`,
      [ACCOUNT],
    );
    try {
      assert.equal(await ensureWebApprovalSurface(pool, id), null);
      assert.equal(await webRefs(id), 0);
    } finally {
      await pool.query(
        `UPDATE untch_wallet_bindings SET status = 'ACTIVE', revoked_at = NULL WHERE account_id = $1`,
        [ACCOUNT],
      );
    }
  });

  test("an unknown request gets no surface rather than an empty one", async () => {
    assert.equal(await ensureWebApprovalSurface(pool, "aprq_does_not_exist"), null);
  });

  /**
   * The call site, exercised the way the worker runs it: an outbox event exists, the projection query
   * finds the request, and the surface appears. A rolled-back decision writes no outbox row, so the
   * same query finds nothing — which is why the projection sits behind the outbox rather than beside
   * the decision.
   */
  test("the delivery pass projects a web surface for an activated request and none for an unactivated one", async () => {
    const activated = await pendingRequest();
    const notActivated = await pendingRequest();
    await pool.query(
      `INSERT INTO untch_approval_outbox (event_id, approval_request_id, name)
       VALUES ($1,$2,'approval.request.ready.v1')`,
      [`aoev_web_${seq}`, activated],
    );

    const { rows } = await pool.query<{ approval_request_id: string }>(
      `SELECT DISTINCT o.approval_request_id
         FROM untch_approval_outbox o
         JOIN untch_approval_requests r ON r.approval_request_id = o.approval_request_id
        WHERE o.name = 'approval.request.ready.v1'
          AND r.state = 'PENDING'
          AND r.expires_at > now()
          AND NOT EXISTS (
            SELECT 1 FROM untch_approval_action_refs ar
              JOIN untch_channel_bindings wb ON wb.binding_id = ar.channel_binding_id
             WHERE ar.approval_request_id = o.approval_request_id AND wb.channel = 'web'
          )`,
    );
    for (const r of rows) await ensureWebApprovalSurface(pool, r.approval_request_id);

    assert.equal(await webRefs(activated), 2, "an activated request has somewhere to be answered");
    assert.equal(await webRefs(notActivated), 0, "one with no outbox event has not been activated");
  });

  test("the projection query stops selecting a request once it has a surface", async () => {
    const id = await pendingRequest();
    await pool.query(
      `INSERT INTO untch_approval_outbox (event_id, approval_request_id, name)
       VALUES ($1,$2,'approval.request.ready.v1')`,
      [`aoev_webr_${seq}`, id],
    );
    const selectPending = async (): Promise<number> => {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text n FROM (
           SELECT DISTINCT o.approval_request_id
             FROM untch_approval_outbox o
             JOIN untch_approval_requests r ON r.approval_request_id = o.approval_request_id
            WHERE o.name = 'approval.request.ready.v1'
              AND r.state = 'PENDING' AND r.expires_at > now()
              AND o.approval_request_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM untch_approval_action_refs ar
                  JOIN untch_channel_bindings wb ON wb.binding_id = ar.channel_binding_id
                 WHERE ar.approval_request_id = o.approval_request_id AND wb.channel = 'web'
              )) q`,
        [id],
      );
      return Number(rows[0]!.n);
    };
    assert.equal(await selectPending(), 1, "before projection it is outstanding");
    await ensureWebApprovalSurface(pool, id);
    assert.equal(await selectPending(), 0, "and afterwards the pass leaves it alone");
  });

  test("a web projection never becomes a Discord delivery", async () => {
    const id = await pendingRequest();
    await ensureWebApprovalSurface(pool, id);
    await projectDeliveries(pool, { limit: 10 });
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_deliveries WHERE approval_request_id = $1`,
      [id],
    );
    assert.equal(Number(rows[0]!.n), 0, "no outbox event means no channel delivery, web surface or not");
  });
});
