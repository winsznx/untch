import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import {
  PgServiceCallStore,
  createPool,
  deliverOnce,
  finalizeSettlement,
  projectDeliveries,
  resolveActionRef,
  type Pool,
} from "@untch/consumer-core";
import { persistEscalatedApproval } from "../src/consumer/escalated-approval";
import { parseVerifiedPaymentAuthorization } from "../src/consumer/payment-authorization";
import { discordApprovalGateway } from "../src/consumer/discord-approval-gateway";

/**
 * The message, and the two links that are the only way to answer it.
 *
 * The assertions that matter are about what the URL does NOT contain. A Discord message is copied,
 * quoted, screenshotted and unfurled, so anything in a link is effectively public — and the action
 * token deliberately commits to the whole obligation, which is exactly why it must never be in one.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_discord_gateway";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_discordgatewayaccountaaaaa";
const CHAIN = "eip155:196";
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const PAYER = "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64";
const PAY_TO = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const SUBJECT = "discord-subject-gateway";
const BASE = "https://asp.untch.xyz";

describe("the Discord approval message", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let store: PgServiceCallStore;
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
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, file), "utf8"));
    }
    await pool.query(
      `INSERT INTO untch_accounts (account_id, status, created_at, created_by, updated_at, updated_by)
       VALUES ($1,'ACTIVE', now(),'t', now(),'t') ON CONFLICT DO NOTHING`,
      [ACCOUNT],
    );
    await pool.query(
      `INSERT INTO untch_channel_bindings
         (binding_id, account_id, channel, channel_user_id, channel_chat_id, can_decide, status,
          verified_at, scopes, verification_method, account_ref_hash, created_at, created_by, updated_at, updated_by)
       VALUES ('cbnd_gw', $1, 'discord', $2, '999888777', true, 'ACTIVE', now(),
               ARRAY['notify','policy-approval'], 'discord_oauth_identify', 'arh_gw', now(),'t', now(),'t')
       ON CONFLICT DO NOTHING`,
      [ACCOUNT, SUBJECT],
    );
    store = new PgServiceCallStore(pool);
  });

  after(async () => {
    await pool?.end();
  });

  const inTx = async <T,>(fn: (tx: never) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client as never);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  const pendingRequest = async (): Promise<{ approvalRequestId: string; digest: string }> => {
    seq += 1;
    const nonce = `0xgw${String(seq).padStart(4, "0")}${"c".repeat(54)}`;
    const header = Buffer.from(
      JSON.stringify({
        accepted: { scheme: "exact", network: CHAIN, asset: TOKEN, amount: "50000", payTo: PAY_TO },
        payload: { authorization: { from: PAYER, to: PAY_TO, value: "50000", validAfter: "0", validBefore: "99999999999", nonce } },
      }),
      "utf8",
    ).toString("base64");
    const auth = parseVerifiedPaymentAuthorization(header, { chainId: 196 });
    assert.ok(auth);
    const record = await inTx((tx) =>
      persistEscalatedApproval(tx, store, auth, {
        route: "/preflight_payment",
        accountId: ACCOUNT,
        idempotencyKey: `gw-idem-${seq}`,
        provider: "untch",
        capability: "owned_work.demo",
        amount: "6.00",
        asset: "USDT0",
        deadline: "2026-08-04T12:00:00.000Z",
        chain: CHAIN,
        recipient: PAY_TO,
        decisionId: `dec_gw_${seq}`,
        intentHash: `0xgwintent${seq}`,
        quoteDigest: `qd_gw_${seq}`,
        policySnapshotHash: `0xsnap${seq}`,
        policyId: "778001",
        policyHash: "0xpolicyhash",
        policyVersion: 1,
        intentNonce: `inonce_gw_${seq}`,
        taskHash: "0xtask",
        acceptanceHash: "0xacceptance",
        requesterPrincipalKind: "ACCOUNT",
        requesterPrincipalNamespace: "untch",
        requesterPrincipalRef: `req_gw_${seq}`,
        accountRefHash: "arh_gw",
        walletAuthorityRef: `wa_gw_${seq}`,
        reason: "ESCALATED_THRESHOLD",
        approvalExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    await inTx((tx) =>
      finalizeSettlement(tx, {
        serviceCallId: record.serviceCallId,
        evidence: {
          kind: "CONFIRMED",
          source: "facilitator_settle_status",
          transactionHash: `0xtxgw${seq}`,
          paymentId: null,
          terms: { authorizationNonce: nonce, payer: PAYER, token: TOKEN, amount: "50000", payTo: PAY_TO, chain: CHAIN },
        },
      }),
    );
    return { approvalRequestId: record.approvalRequestId, digest: record.approvalDigest };
  };

  interface Sent {
    readonly url: string;
    readonly body: Record<string, unknown>;
  }

  const recordingGateway = (sent: Sent[], ok = true) =>
    discordApprovalGateway({
      pool,
      publicBaseUrl: BASE,
      botToken: "bot-token-for-test",
      post: async (url, body) => {
        sent.push({ url, body: body as Record<string, unknown> });
        return { ok, id: ok ? `msg_${sent.length}` : null, status: ok ? 200 : 500 };
      },
    });

  test("the message names the exact obligation and its two clocks", async () => {
    const { approvalRequestId } = await pendingRequest();
    await projectDeliveries(pool, { limit: 10 });
    const sent: Sent[] = [];
    await deliverOnce(pool, recordingGateway(sent), { limit: 10 });

    const message = sent.find((s) => s.url.includes("/messages"));
    assert.ok(message, "a message must have been sent to the bound channel");
    const embed = (message.body.embeds as Record<string, unknown>[])[0]!;
    const fields = embed.fields as { name: string; value: string }[];
    const named = Object.fromEntries(fields.map((f) => [f.name, f.value]));

    assert.equal(named.Provider, "untch");
    assert.equal(named.Capability, "owned_work.demo");
    assert.equal(named.Amount, "6.00 USDT0");
    assert.equal(named.Policy, "778001");
    assert.equal(named.Status, "PENDING");
    assert.ok(named["Request expires"], "a request clock must be shown");
    assert.ok(named["Approval expires"], "an approval clock must be shown");
    /** Truncated, not the full address pasted into a chat log that outlives the decision. */
    assert.ok(named.Recipient?.includes("…"));
    assert.ok(!named.Recipient?.includes(PAY_TO));

    // The amount is on the content line too, so a notification preview shows it without opening Discord.
    assert.match(String(message.body.content), /6\.00 USDT0/);
    void approvalRequestId;
  });

  test("the links carry an opaque reference and nothing that could be redeemed", async () => {
    const { approvalRequestId, digest } = await pendingRequest();
    await projectDeliveries(pool, { limit: 10 });
    const sent: Sent[] = [];
    await deliverOnce(pool, recordingGateway(sent), { limit: 10 });

    const message = sent.find((s) => s.url.includes("/messages"));
    assert.ok(message);
    const row = (message.body.components as Record<string, unknown>[])[0]!;
    const buttons = row.components as { label: string; url: string; style: number }[];
    assert.equal(buttons.length, 2);

    for (const button of buttons) {
      assert.equal(button.style, 5, "link buttons, so no Discord Interactions Endpoint is required");
      assert.match(button.url, new RegExp(`^${BASE}/consumer/approvals/action/aref_[A-Za-z0-9_-]+$`));
      /** Everything the token commits to must be absent from the URL. */
      assert.ok(!button.url.includes(digest), "the approval digest must not be in a link");
      assert.ok(!button.url.includes(approvalRequestId), "the request id must not be in a link");
      assert.ok(!button.url.includes(ACCOUNT), "the account id must not be in a link");
      assert.ok(!button.url.includes(PAY_TO), "the recipient must not be in a link");
      assert.ok(!button.url.includes("6.00"), "the amount must not be in a link");
      assert.ok(!button.url.toLowerCase().includes("token"));
    }

    /** And the references they name actually resolve, for the bound subject only. */
    const approveRef = buttons[0]!.url.split("/").pop()!;
    const mine = await resolveActionRef(pool, approveRef, SUBJECT, Date.now());
    assert.equal(mine.ok, true);
    const stranger = await resolveActionRef(pool, approveRef, "someone-else", Date.now());
    assert.equal(stranger.ok, false, "possession of the URL must not be identity");
  });

  test("a retry reuses the same links rather than leaving two pressable messages", async () => {
    const { approvalRequestId } = await pendingRequest();
    await projectDeliveries(pool, { limit: 10 });

    const failed: Sent[] = [];
    await deliverOnce(pool, recordingGateway(failed, false), { limit: 10 });
    const firstUrls = failed.filter((s) => s.url.includes("/messages")).map((s) => JSON.stringify(s.body.components));

    const retried: Sent[] = [];
    await deliverOnce(pool, recordingGateway(retried), { limit: 10, nowMs: Date.now() + 3_600_000 });
    const secondUrls = retried.filter((s) => s.url.includes("/messages")).map((s) => JSON.stringify(s.body.components));

    assert.ok(firstUrls.length > 0 && secondUrls.length > 0, "both attempts must have built a message");
    assert.deepEqual(secondUrls, firstUrls, "a retry must reuse the live references");

    const live = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_action_refs
        WHERE approval_request_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [approvalRequestId],
    );
    assert.equal(live.rows[0]!.n, "2", "exactly one approve link and one deny link stay live");
  });

  test("a deployment with no bot token refuses rather than marking a message sent", async () => {
    await pendingRequest();
    await projectDeliveries(pool, { limit: 10 });
    const gateway = discordApprovalGateway({ pool, publicBaseUrl: BASE, botToken: null });
    const report = await deliverOnce(pool, gateway, { limit: 10 });
    assert.equal(report.sent, 0, "nothing may be reported as sent when nothing can be sent");
    assert.ok(report.retryable > 0, "the delivery must stay claimable once a token exists");
  });

  test("a superseded or resolved request receives nothing", async () => {
    const { approvalRequestId } = await pendingRequest();
    await pool.query(
      `UPDATE untch_approval_requests SET state = 'SUPERSEDED', resolved_at = now(), superseded_at = now()
        WHERE approval_request_id = $1`,
      [approvalRequestId],
    );
    await projectDeliveries(pool, { limit: 10 });
    const deliveries = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_deliveries WHERE approval_request_id = $1`,
      [approvalRequestId],
    );
    assert.equal(deliveries.rows[0]!.n, "0", "a request that moved on must not be delivered");
  });
});
