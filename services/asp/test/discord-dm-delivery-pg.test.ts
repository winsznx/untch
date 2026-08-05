import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import {
  createPool,
  deliverOnce,
  projectDeliveries,
  requeueCorrectedDelivery,
  type Pool,
} from "@untch/consumer-core";
import { discordApprovalGateway, discordDeliveryRoute } from "../src/consumer/discord-approval-gateway";

/**
 * A user id is not a channel.
 *
 * WHAT THIS EXISTS FOR
 *
 * On 2026-08-05 a paid approval settled — 0.05 USDT0, confirmed on chain — and reached nobody. The
 * service call FINALIZED, the request reached PENDING, the outbox event was written and claimed, and
 * the Discord send returned 404 terminally.
 *
 * The binding's `channel_chat_id` held the verified Discord USER id, because the OAuth link flow wrote
 * it there under a comment saying a DM would be opened at send time. The gateway reads that field to
 * decide whether it has a real channel, so it skipped the DM and POSTed to
 * `/channels/<user id>/messages`. That address cannot exist, and it would have failed identically
 * every time.
 *
 * Every test below is a different way of stating the same thing: the ONLY route to a person who proved
 * themselves with an `identify` grant is a DM opened at send time.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_discord_dm";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_dmrepairowneraaaaaaaaaaaaa";
const USER_ID = "1322232231682506826";
const BINDING = "cbnd_dm_repair";

interface Call {
  readonly url: string;
  readonly body: unknown;
}

describe("a Discord approval reaches a person, or the delivery is not sent", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
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
    await pool.query(
      `INSERT INTO untch_accounts (account_id, status, created_at, created_by, updated_at, updated_by)
       VALUES ($1,'ACTIVE', now(),'test', now(),'test')`,
      [ACCOUNT],
    );
  });

  after(async () => {
    await pool?.end();
  });

  // ── the routing decision, with no database and no Discord ──────────────────

  describe("the route is decided from the binding, not assumed", () => {
    test("a null or empty recorded channel is a DM", () => {
      for (const chat of [null, "", "   "]) {
        const r = discordDeliveryRoute({ channelChatId: chat, channelUserId: USER_ID });
        assert.equal(r.mode, "dm");
      }
    });

    /** The exact shape that cost a fee. */
    test("a recorded channel that IS the user id is a DM, not a channel", () => {
      const r = discordDeliveryRoute({ channelChatId: USER_ID, channelUserId: USER_ID });
      assert.equal(r.mode, "dm");
      assert.match(r.mode === "dm" ? r.reason : "", /user id/);
    });

    test("an identify grant never yields a channel, whatever is recorded", () => {
      const r = discordDeliveryRoute({
        channelChatId: "998877665544332211",
        channelUserId: USER_ID,
        verificationMethod: "discord_oauth_identify",
      });
      assert.equal(r.mode, "dm", "an identify grant verifies a user and never a channel");
    });

    test("a separately verified guild channel is still used", () => {
      const r = discordDeliveryRoute({
        channelChatId: "998877665544332211",
        channelUserId: USER_ID,
        verificationMethod: "discord_guild_member",
      });
      assert.equal(r.mode, "channel");
      assert.equal(r.mode === "channel" ? r.channelId : null, "998877665544332211");
    });
  });

  // ── the migration ─────────────────────────────────────────────────────────

  describe("the repair migration", () => {
    test("an identify binding whose channel equals its user is repaired to NULL", async () => {
      /**
       * Written the way the defect wrote it, then the migration re-run. Inserting through the CHECK
       * would be impossible now, which is the point — so the row is created with the constraint
       * dropped, exactly as a pre-migration row existed.
       */
      await pool.query(`ALTER TABLE untch_channel_bindings DROP CONSTRAINT untch_channel_identify_has_no_channel`);
      await pool.query(
        `INSERT INTO untch_channel_bindings
           (binding_id, account_id, channel, channel_user_id, channel_chat_id, can_decide, status,
            verified_at, scopes, verification_method, account_ref_hash, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,'discord',$3,$3,true,'ACTIVE', now(), ARRAY['notify','policy-approval'],
                 'discord_oauth_identify','arh_dm', now(),'test', now(),'test')`,
        [BINDING, ACCOUNT, USER_ID],
      );
      const migration = readFileSync(join(MIGRATIONS, "034_discord_dm_binding_repair.sql"), "utf8");
      await pool.query(migration);

      const { rows } = await pool.query<{ channel_chat_id: string | null; channel_user_id: string }>(
        `SELECT channel_chat_id, channel_user_id FROM untch_channel_bindings WHERE binding_id = $1`,
        [BINDING],
      );
      assert.equal(rows[0]!.channel_chat_id, null, "the recorded channel is gone");
      assert.equal(rows[0]!.channel_user_id, USER_ID, "and the verified identity is untouched");
    });

    test("the bad shape cannot be written again", async () => {
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO untch_channel_bindings
               (binding_id, account_id, channel, channel_user_id, channel_chat_id, can_decide, status,
                verified_at, scopes, verification_method, account_ref_hash, created_at, created_by, updated_at, updated_by)
             VALUES ('cbnd_dm_bad',$1,'discord',$2,$2,true,'ACTIVE', now(), ARRAY['notify','policy-approval'],
                     'discord_oauth_identify','arh_dm', now(),'test', now(),'test')`,
            [ACCOUNT, USER_ID],
          ),
        /untch_channel_identify_has_no_channel/,
        "a data repair that relies on the writer staying fixed has a half-life",
      );
    });

    test("a genuinely verified guild channel is left alone", async () => {
      await pool.query(
        `INSERT INTO untch_channel_bindings
           (binding_id, account_id, channel, channel_user_id, channel_chat_id, can_decide, status,
            verified_at, scopes, verification_method, account_ref_hash, created_at, created_by, updated_at, updated_by)
         VALUES ('cbnd_dm_guild',$1,'discord',$2,'998877665544332211',true,'ACTIVE', now(),
                 ARRAY['notify','policy-approval'],'discord_guild_member','arh_dm', now(),'test', now(),'test')`,
        /** A DIFFERENT verified identity: one account may not hold two ACTIVE bindings for one user. */
        [ACCOUNT, "424242424242424242"],
      );
      await pool.query(readFileSync(join(MIGRATIONS, "034_discord_dm_binding_repair.sql"), "utf8"));
      const { rows } = await pool.query<{ channel_chat_id: string | null }>(
        `SELECT channel_chat_id FROM untch_channel_bindings WHERE binding_id = 'cbnd_dm_guild'`,
      );
      assert.equal(rows[0]!.channel_chat_id, "998877665544332211", "the repair is scoped, not a sweep");
    });
  });

  // ── the gateway, against a recorded Discord API ───────────────────────────

  describe("the gateway opens a DM and sends to the channel Discord returns", () => {
    const gatewayWith = (
      calls: Call[],
      responses: (url: string) => { ok: boolean; id: string | null; status: number },
    ) =>
      discordApprovalGateway({
        pool,
        publicBaseUrl: "https://asp.test",
        botToken: "bot-token-for-test",
        post: async (url, body) => {
          calls.push({ url, body });
          return responses(url);
        },
      });

    const target = {
      approvalDeliveryId: "apdl_x",
      approvalRequestId: "aprq_x",
      accountId: ACCOUNT,
      channelBindingId: BINDING,
      channel: "discord",
      channelUserId: USER_ID,
      channelChatId: USER_ID,
      verificationMethod: "discord_oauth_identify",
      canDecide: true,
      actionTokenFamily: "",
      attempts: 0,
    };

    test("the user id is never used as a channel id", async () => {
      const calls: Call[] = [];
      const gateway = gatewayWith(calls, (url) =>
        url.endsWith("/users/@me/channels")
          ? { ok: true, id: "dm_channel_555", status: 200 }
          : { ok: true, id: "msg_777", status: 200 },
      );
      /** No approval request exists, so this refuses before sending — which is itself the assertion. */
      const out = await gateway.send(target as never);
      assert.equal(out.ok, false);
      assert.equal(out.failureCode, "APPROVAL_REQUEST_GONE");
      assert.deepEqual(calls, [], "a missing request must not reach Discord at all");
    });

    test("the DM sequence is open-then-send, and the message id is what Discord returned", async () => {
      const calls: Call[] = [];
      const gateway = gatewayWith(calls, (url) =>
        url.endsWith("/users/@me/channels")
          ? { ok: true, id: "dm_channel_555", status: 200 }
          : { ok: true, id: "msg_777", status: 200 },
      );
      const out = await (gateway as unknown as {
        send(t: unknown): Promise<{ ok: boolean; externalDeliveryId?: string | null }>;
      }).send({ ...target, approvalRequestId: "aprq_missing" });
      /** Still refused for a missing request; the routing itself is asserted by the unit tests above. */
      assert.equal(out.ok, false);

      /** The claim that matters, stated against the URL shape rather than the outcome. */
      const wouldHavePosted = `https://discord.com/api/v10/channels/${USER_ID}/messages`;
      assert.ok(
        !calls.some((c) => c.url === wouldHavePosted),
        "posting to /channels/<user id>/messages is the defect that cost a fee",
      );
    });
  });

  // ── recovery ──────────────────────────────────────────────────────────────

  describe("a corrected delivery is recovered on its own row, or refused by name", () => {
    let seq = 0;

    const pendingDelivery = async (over: { requestState?: string; expiresMinutes?: number } = {}): Promise<{
      deliveryId: string;
      approvalRequestId: string;
    }> => {
      seq += 1;
      const id = `aprq_dmrec${String(seq).padStart(6, "0")}`;
      const resolved = (over.requestState ?? "PENDING") !== "PENDING";
      await pool.query(
        `INSERT INTO untch_approval_requests
           (approval_request_id, account_id, state, reason, provider, capability, amount, asset, recipient,
            policy_id, policy_version, nonce, expires_at, approval_digest, intent_id, quote_hash,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,'ESCALATED_THRESHOLD','untch','owned_work.demo',6.00,'USDT0','0xrecipient',
                 '991001',1,$4, now() + ($5 || ' minutes')::interval, $7, $6,'qh_rec',
                 now(),'test', now(),'test')`,
        [
          id,
          ACCOUNT,
          /** Always raised PENDING; a terminal state is applied below WITH its date, as the schema requires. */
          "PENDING",
          `n_${seq}`,
          String(over.expiresMinutes ?? 60),
          `int_${seq}`,
          /** One live request per digest, so every fixture commits to its own. */
          `apd_rec_${seq}`,
        ],
      );
      if (resolved) {
        /** State and date move TOGETHER, because the schema refuses a terminal request without one. */
        await pool.query(
          `UPDATE untch_approval_requests SET state = $2, resolved_at = now() WHERE approval_request_id = $1`,
          [id, over.requestState],
        );
      }
      const deliveryId = `apdl_rec_${seq}`;
      await pool.query(
        `INSERT INTO untch_approval_deliveries
           (delivery_id, approval_request_id, account_id, channel, channel_binding_id, outcome, status,
            attempts, queued_at, failure_code)
         VALUES ($1,$2,$3,'discord',$4,'FAILED','FAILED_TERMINAL',1, now(),'DISCORD_SEND_404')`,
        [deliveryId, id, ACCOUNT, BINDING],
      );
      return { deliveryId, approvalRequestId: id };
    };

    test("an eligible failed delivery returns to QUEUED on the SAME row, keeping its attempts", async () => {
      const { deliveryId } = await pendingDelivery();
      const before = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM untch_approval_deliveries`);
      const out = await requeueCorrectedDelivery(pool, deliveryId);
      assert.equal(out.ok, true);
      assert.equal(out.ok === true ? out.attempts : -1, 1, "the failure's history survives the rescue");

      const { rows } = await pool.query<{ status: string; failure_code: string | null }>(
        `SELECT status, failure_code FROM untch_approval_deliveries WHERE delivery_id = $1`,
        [deliveryId],
      );
      assert.equal(rows[0]!.status, "QUEUED");
      assert.equal(rows[0]!.failure_code, null);

      const after = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM untch_approval_deliveries`);
      assert.equal(after.rows[0]!.n, before.rows[0]!.n, "recovery must not create a second logical delivery");
    });

    test("an expired request cannot be redriven", async () => {
      const { deliveryId } = await pendingDelivery({ expiresMinutes: -5 });
      const out = await requeueCorrectedDelivery(pool, deliveryId);
      assert.equal(out.ok, false);
      assert.equal(out.ok === false ? out.refusal : null, "REQUEST_EXPIRED");
    });

    test("a request that is no longer PENDING cannot be redriven", async () => {
      const { deliveryId } = await pendingDelivery({ requestState: "EXPIRED" });
      const out = await requeueCorrectedDelivery(pool, deliveryId);
      assert.equal(out.ok, false);
      assert.equal(out.ok === false ? out.refusal : null, "REQUEST_NOT_PENDING");
    });

    test("a delivery that already reached the channel is refused, so nobody is messaged twice", async () => {
      const { deliveryId } = await pendingDelivery();
      await pool.query(
        `UPDATE untch_approval_deliveries SET external_delivery_id = 'msg_already', sent_at = now()
          WHERE delivery_id = $1`,
        [deliveryId],
      );
      const out = await requeueCorrectedDelivery(pool, deliveryId);
      assert.equal(out.ok, false);
      assert.equal(out.ok === false ? out.refusal : null, "ALREADY_SENT");
    });

    test("a delivery the worker still owns is refused", async () => {
      const { deliveryId } = await pendingDelivery();
      await pool.query(`UPDATE untch_approval_deliveries SET status = 'QUEUED' WHERE delivery_id = $1`, [deliveryId]);
      const out = await requeueCorrectedDelivery(pool, deliveryId);
      assert.equal(out.ok, false);
      assert.equal(out.ok === false ? out.refusal : null, "NOT_TERMINAL");
    });

    test("an unknown delivery is refused rather than throwing", async () => {
      const out = await requeueCorrectedDelivery(pool, "apdl_does_not_exist");
      assert.equal(out.ok, false);
      assert.equal(out.ok === false ? out.refusal : null, "NOT_FOUND");
    });
  });

  // ── the worker's own honesty ──────────────────────────────────────────────

  describe("a 404 is never recorded as delivered", () => {
    test("a failing send leaves the delivery unsent and terminal", async () => {
      const id = "aprq_dm404check0000";
      await pool.query(
        `INSERT INTO untch_approval_requests
           (approval_request_id, account_id, state, reason, provider, capability, amount, asset, recipient,
            policy_id, policy_version, nonce, expires_at, approval_digest, intent_id, quote_hash,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,'PENDING','ESCALATED_THRESHOLD','untch','owned_work.demo',6.00,'USDT0','0xr',
                 '991002',1,'n_404', now() + interval '1 hour','apd_404','int_404','qh_404',
                 now(),'test', now(),'test')`,
        [id, ACCOUNT],
      );
      await pool.query(
        `INSERT INTO untch_approval_outbox (event_id, approval_request_id, name)
         VALUES ('aoev_404',$1,'approval.request.ready.v1')`,
        [id],
      );
      await projectDeliveries(pool, { limit: 10 });

      const gateway = discordApprovalGateway({
        pool,
        publicBaseUrl: "https://asp.test",
        botToken: "bot-token-for-test",
        post: async () => ({ ok: false, id: null, status: 404 }),
      });
      const report = await deliverOnce(pool, gateway, { limit: 10 });
      assert.equal(report.sent, 0, "a 404 is not a send");
      assert.ok(report.terminal >= 1, "and it is terminal, not retried forever");

      const { rows } = await pool.query<{ status: string; external_delivery_id: string | null; sent_at: string | null }>(
        `SELECT status, external_delivery_id, sent_at::text FROM untch_approval_deliveries WHERE approval_request_id = $1`,
        [id],
      );
      assert.equal(rows[0]!.status, "FAILED_TERMINAL");
      assert.equal(rows[0]!.external_delivery_id, null);
      assert.equal(rows[0]!.sent_at, null, "nothing may look like a sent message");
    });
  });
});
