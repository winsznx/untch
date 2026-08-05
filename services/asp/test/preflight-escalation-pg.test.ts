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
  reconcileOnce,
  type ChannelGateway,
  type DeliveryTarget,
  type Pool,
  type SettlementOracle,
} from "@untch/consumer-core";
import {
  EscalatedApprovalRefused,
  persistEscalatedApproval,
  type EscalatedApprovalInput,
} from "../src/consumer/escalated-approval";
import {
  parseVerifiedPaymentAuthorization,
  type VerifiedPaymentAuthorizationContext,
} from "../src/consumer/payment-authorization";
import { narrowToDecisionOnly, ExecutionDependencyLeakError } from "../src/route-profiles";

/**
 * The production escalated branch, against a real database.
 *
 * The function under test is the one `handlePublicPreflight` calls — not a reimplementation of it — so
 * a defect here is a defect on the paid path. What it proves is narrow and deliberate: the branch
 * records a payment it can later be checked against, and it records NOTHING a human could act on.
 *
 * Everything that makes an approval actionable is exercised through `finalizeSettlement`, because that
 * is the only writer allowed to do it, and the tests that matter most are the ones showing an accepted
 * settlement is not a confirmed one.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_preflight_escalation";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_escalationtestaccount1abcd";
const CHAIN = "eip155:196";
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const PAYER = "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64";
const PAY_TO = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";

/** The header an x402 client actually presents, built the way a client builds it. */
function presentedHeader(nonce: string, over: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      accepted: { scheme: "exact", network: CHAIN, asset: TOKEN, amount: "50000", payTo: PAY_TO, ...over },
      payload: {
        signature: "0xdeadbeefsignaturethatmustnevertravel",
        authorization: { from: PAYER, to: PAY_TO, value: "50000", validAfter: "0", validBefore: "99999999999", nonce },
      },
    }),
    "utf8",
  ).toString("base64");
}

describe("the escalated branch of the paid preflight", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
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
       VALUES ($1,'ACTIVE', now(),'test', now(),'test') ON CONFLICT DO NOTHING`,
      [ACCOUNT],
    );
    store = new PgServiceCallStore(pool);
  });

  after(async () => {
    await pool?.end();
  });

  const input = (over: Partial<EscalatedApprovalInput> = {}): EscalatedApprovalInput => {
    seq += 1;
    return {
      route: "/preflight_payment",
      accountId: ACCOUNT,
      idempotencyKey: `idem-escalation-${seq}`,
      provider: "untch",
      capability: "owned_work.demo",
      amount: "6.00",
      asset: "USDT0",
      deadline: "2026-08-04T12:00:00.000Z",
      chain: CHAIN,
      recipient: PAY_TO,
      decisionId: `dec_escalation_${seq}`,
      intentHash: `0xintent${seq}`,
      quoteDigest: `qd_${seq}`,
      policySnapshotHash: `0xsnap${seq}`,
      policyId: "778001",
      policyHash: "0xpolicyhash",
      policyVersion: 1,
      intentNonce: `nonce_${seq}`,
      taskHash: "0xtask",
      acceptanceHash: "0xacceptance",
      requesterPrincipalKind: "ACCOUNT",
      requesterPrincipalNamespace: "untch",
      requesterPrincipalRef: `req_${seq}`,
      accountRefHash: `arh_${seq}`,
      walletAuthorityRef: `wa_${seq}`,
      reason: "ESCALATED_THRESHOLD",
      approvalExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...over,
    };
  };

  /** One decision transaction, the same shape `evidenceTx` hands the handler. */
  const inTx = async <T,>(fn: (tx: { query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> }) => Promise<T>): Promise<T> => {
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

  const auth = (nonce: string): VerifiedPaymentAuthorizationContext => {
    const parsed = parseVerifiedPaymentAuthorization(presentedHeader(nonce), { chainId: 196 });
    assert.ok(parsed, "the presented header must parse");
    return parsed;
  };

  // ── the data boundary ───────────────────────────────────────────────────

  test("the parsed authorization carries the terms and never the signature", () => {
    const parsed = auth("0xnonce-boundary");
    assert.equal(parsed.authorizationNonce, "0xnonce-boundary");
    assert.equal(parsed.payer, PAYER);
    assert.equal(parsed.amount, "50000");
    assert.equal(parsed.payTo, PAY_TO);
    assert.equal(parsed.chain, CHAIN);

    /**
     * The property the whole boundary exists for. A serialised context is what would reach a log, a
     * database or another process, and nothing spendable may survive that trip.
     */
    const serialised = JSON.stringify(parsed);
    assert.ok(!serialised.includes("signature"), "the signature must not survive parsing");
    assert.ok(!serialised.includes("0xdeadbeef"), "no part of the signature may appear in the context");
    for (const [key, value] of Object.entries(parsed)) {
      assert.notEqual(typeof value, "function", `${key} is callable, so this context can act`);
    }
  });

  test("an unparseable or absent authorization yields null rather than a half-built context", () => {
    assert.equal(parseVerifiedPaymentAuthorization(null), null);
    assert.equal(parseVerifiedPaymentAuthorization("not-base64-json"), null);
    // A header with no nonce cannot key an attempt, so it is refused rather than stored with a hole.
    const noNonce = Buffer.from(JSON.stringify({ accepted: {}, payload: { authorization: {} } }), "utf8").toString("base64");
    assert.equal(parseVerifiedPaymentAuthorization(noNonce), null);
  });

  test("the decision bundle still refuses an execution dependency at runtime", () => {
    assert.throws(
      () =>
        narrowToDecisionOnly({
          policyProvider: {} as never,
          intentStore: {} as never,
          // The name is what the guard refuses. A settlement capability arriving under it must not pass.
          settlementSender: () => undefined,
        } as never),
      ExecutionDependencyLeakError,
    );
  });

  // ── what the branch writes ──────────────────────────────────────────────

  test("an escalated decision writes a service call, an attempt bound to the exact nonce, and a PROVISIONAL request", async () => {
    const nonce = "0xnonce-provisional";
    const record = await inTx((tx) => persistEscalatedApproval(tx as never, store, auth(nonce), input()));

    assert.equal(record.state, "PROVISIONAL");
    assert.equal(record.authorizationNonce, nonce);

    const { rows: attempts } = await pool.query<{ authorization_nonce: string; payer: string; amount: string; state: string }>(
      `SELECT authorization_nonce, payer, amount, state FROM untch_x402_payment_attempts WHERE service_call_id = $1`,
      [record.serviceCallId],
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.authorization_nonce, nonce);
    assert.equal(attempts[0]!.payer, PAYER);
    assert.equal(attempts[0]!.state, "VERIFIED");

    const { rows: requests } = await pool.query<{ state: string; service_call_id: string; approval_digest: string }>(
      `SELECT state, service_call_id, approval_digest FROM untch_approval_requests WHERE approval_request_id = $1`,
      [record.approvalRequestId],
    );
    assert.equal(requests[0]!.state, "PROVISIONAL");
    assert.equal(requests[0]!.service_call_id, record.serviceCallId);
  });

  test("a PROVISIONAL request creates no outbox event, no delivery and no reservation", async () => {
    const record = await inTx((tx) => persistEscalatedApproval(tx as never, store, auth("0xnonce-noeffects"), input()));
    const counts = await pool.query<{ outbox: string; deliveries: string; reservations: string }>(
      `SELECT (SELECT count(*) FROM untch_approval_outbox WHERE approval_request_id = $1)::text AS outbox,
              (SELECT count(*) FROM untch_approval_deliveries WHERE approval_request_id = $1)::text AS deliveries,
              (SELECT count(*) FROM untch_budget_reservations WHERE approval_request_id = $1)::text AS reservations`,
      [record.approvalRequestId],
    );
    assert.deepEqual(counts.rows[0], { outbox: "0", deliveries: "0", reservations: "0" });
  });

  test("an escalated decision with no presented authorization refuses and writes nothing", async () => {
    const before = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM untch_approval_requests`);
    await assert.rejects(
      () => inTx((tx) => persistEscalatedApproval(tx as never, store, null, input())),
      (err: unknown) => err instanceof EscalatedApprovalRefused && err.code === "PAYMENT_AUTHORIZATION_ABSENT",
    );
    const after = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM untch_approval_requests`);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n, "a refusal must take its whole transaction with it");
  });

  test("a rolled-back decision leaves no approval request behind", async () => {
    const before = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM untch_approval_requests`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await persistEscalatedApproval(client as never, store, auth("0xnonce-rolledback"), input());
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const after = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM untch_approval_requests`);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n);
  });

  // ── activation ──────────────────────────────────────────────────────────

  const oracle = (status: "pending" | "success" | "failed"): SettlementOracle => ({
    async settlementFor({ terms, transactionHash }) {
      if (!transactionHash) return { kind: "UNKNOWN", detail: "no hash" };
      if (status === "failed") return { kind: "FAILED", failureCode: "FACILITATOR_REPORTED_FAILURE", failureDetail: null };
      if (status === "pending") return { kind: "PENDING", transactionHash, paymentId: null };
      return { kind: "CONFIRMED", source: "facilitator_settle_status", transactionHash, paymentId: null, terms };
    },
  });

  test("a pending settlement activates nothing, and a confirmed one activates exactly once", async () => {
    const nonce = "0xnonce-activation";
    const record = await inTx((tx) => persistEscalatedApproval(tx as never, store, auth(nonce), input()));
    const terms = { authorizationNonce: nonce, payer: PAYER, token: TOKEN, amount: "50000", payTo: PAY_TO, chain: CHAIN };

    const pending = await inTx((tx) =>
      finalizeSettlement(tx as never, { serviceCallId: record.serviceCallId, evidence: { kind: "PENDING", transactionHash: "0xtxpending", paymentId: null } }),
    );
    assert.equal(pending.outcome, "LEFT_UNRESOLVED");
    const stillProvisional = await pool.query<{ state: string }>(
      `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`,
      [record.approvalRequestId],
    );
    assert.equal(stillProvisional.rows[0]!.state, "PROVISIONAL", "a pending settlement must never activate an approval");

    const confirmed = await inTx((tx) =>
      finalizeSettlement(tx as never, {
        serviceCallId: record.serviceCallId,
        evidence: { kind: "CONFIRMED", source: "facilitator_settle_status", transactionHash: "0xtxpending", paymentId: null, terms },
      }),
    );
    assert.equal(confirmed.outcome, "ACTIVATED");

    const again = await inTx((tx) =>
      finalizeSettlement(tx as never, {
        serviceCallId: record.serviceCallId,
        evidence: { kind: "CONFIRMED", source: "facilitator_settle_status", transactionHash: "0xtxpending", paymentId: null, terms },
      }),
    );
    assert.equal(again.outcome, "ALREADY_ACTIVE");

    const events = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_outbox WHERE approval_request_id = $1`,
      [record.approvalRequestId],
    );
    assert.equal(events.rows[0]!.n, "1", "repeated finalization must not produce a second outbox event");
  });

  test("a failed settlement activates nothing", async () => {
    const nonce = "0xnonce-failed";
    const record = await inTx((tx) => persistEscalatedApproval(tx as never, store, auth(nonce), input()));
    const result = await inTx((tx) =>
      finalizeSettlement(tx as never, {
        serviceCallId: record.serviceCallId,
        evidence: { kind: "FAILED", failureCode: "FACILITATOR_REPORTED_FAILURE", failureDetail: null },
      }),
    );
    assert.equal(result.outcome, "PAYMENT_FAILED");
    const state = await pool.query<{ state: string }>(
      `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`,
      [record.approvalRequestId],
    );
    assert.equal(state.rows[0]!.state, "PAYMENT_FAILED");
  });

  test("a FINALIZED call refuses a second attempt, so no second fee can begin", async () => {
    const nonce = "0xnonce-nosecondfee";
    const shared = input();
    const record = await inTx((tx) => persistEscalatedApproval(tx as never, store, auth(nonce), shared));
    const terms = { authorizationNonce: nonce, payer: PAYER, token: TOKEN, amount: "50000", payTo: PAY_TO, chain: CHAIN };
    await inTx((tx) =>
      finalizeSettlement(tx as never, {
        serviceCallId: record.serviceCallId,
        evidence: { kind: "CONFIRMED", source: "facilitator_settle_status", transactionHash: "0xtxnosecond", paymentId: null, terms },
      }),
    );

    /**
     * The same logical request arriving again, exactly as a client retrying after a lost response would
     * send it: same idempotency key, same terms, a FRESH authorization. It must be refused before an
     * attempt row exists, because the middleware settles on any 2xx.
     */
    await assert.rejects(
      () => inTx((tx) => persistEscalatedApproval(tx as never, store, auth("0xnonce-second-fee"), shared)),
      (err: unknown) => err instanceof EscalatedApprovalRefused && err.code === "SERVICE_CALL_NOT_CLAIMABLE",
    );
    const attempts = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_x402_payment_attempts WHERE service_call_id = $1`,
      [record.serviceCallId],
    );
    assert.equal(attempts.rows[0]!.n, "1", "a settled call must never grow a second attempt");
  });

  test("the reconciler completes an activation the response never finished", async () => {
    const nonce = "0xnonce-reconciled";
    const record = await inTx((tx) => persistEscalatedApproval(tx as never, store, auth(nonce), input()));
    // The process dies here: the settlement went out and nothing recorded the result.
    await inTx((tx) =>
      finalizeSettlement(tx as never, { serviceCallId: record.serviceCallId, evidence: { kind: "PENDING", transactionHash: "0xtxreconciled", paymentId: null } }),
    );

    const report = await reconcileOnce(pool, oracle("success"), { limit: 50 });
    assert.ok(report.activated >= 1, `the reconciler should have activated the interrupted call, got ${JSON.stringify(report)}`);

    const state = await pool.query<{ state: string }>(
      `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`,
      [record.approvalRequestId],
    );
    assert.equal(state.rows[0]!.state, "PENDING");
  });

  test("the reconciler never initiates a payment and leaves an unknown settlement unresolved", async () => {
    const nonce = "0xnonce-unknown";
    const record = await inTx((tx) => persistEscalatedApproval(tx as never, store, auth(nonce), input()));
    // No transaction hash was ever recorded, so there is nothing to ask an authority about.
    const report = await reconcileOnce(pool, oracle("pending"), { limit: 50 });
    assert.equal(report.failed, 0, "an unanswerable settlement must never be declared failed");
    const state = await pool.query<{ state: string }>(
      `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`,
      [record.approvalRequestId],
    );
    assert.equal(state.rows[0]!.state, "PROVISIONAL");
  });

  // ── delivery ────────────────────────────────────────────────────────────

  test("delivery happens only after commit, and only for an active binding that may decide", async () => {
    const nonce = "0xnonce-delivery";
    const record = await inTx((tx) => persistEscalatedApproval(tx as never, store, auth(nonce), input()));
    const terms = { authorizationNonce: nonce, payer: PAYER, token: TOKEN, amount: "50000", payTo: PAY_TO, chain: CHAIN };

    await pool.query(
      `INSERT INTO untch_channel_bindings
         (binding_id, account_id, channel, channel_user_id, can_decide, status, verified_at, scopes,
          verification_method, created_at, created_by, updated_at, updated_by)
       VALUES ('cbnd_test_discord', $1, 'discord', 'discord-subject-1', true, 'ACTIVE', now(),
               ARRAY['notify','policy-approval'], 'discord_oauth_identify', now(), 'test', now(), 'test')
       ON CONFLICT DO NOTHING`,
      [ACCOUNT],
    );

    /**
     * Before activation this request has no ready event, so the worker must produce nothing FOR IT.
     *
     * Scoped to this approval rather than asserting a zero total: earlier tests in this suite left
     * their own activated requests behind, and a global count would be measuring them.
     */
    await projectDeliveries(pool, { limit: 10 });
    const beforeActivation = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_deliveries WHERE approval_request_id = $1`,
      [record.approvalRequestId],
    );
    assert.equal(beforeActivation.rows[0]!.n, "0", "a PROVISIONAL request must never be delivered");

    await inTx((tx) =>
      finalizeSettlement(tx as never, {
        serviceCallId: record.serviceCallId,
        evidence: { kind: "CONFIRMED", source: "facilitator_settle_status", transactionHash: "0xtxdelivery", paymentId: null, terms },
      }),
    );

    await projectDeliveries(pool, { limit: 10 });
    const projected = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_deliveries WHERE approval_request_id = $1`,
      [record.approvalRequestId],
    );
    assert.equal(projected.rows[0]!.n, "1", "one logical delivery per active binding");

    const sent: DeliveryTarget[] = [];
    const gateway: ChannelGateway = {
      async send(target) {
        sent.push(target);
        return { ok: true, externalDeliveryId: `discord-msg-${sent.length}` };
      },
    };
    await deliverOnce(pool, gateway, { limit: 10 });
    /**
     * Scoped to THIS request. Earlier tests in this suite left their own PENDING requests behind, and
     * they became deliverable the moment a binding existed, so an aggregate count would be measuring
     * them rather than this one.
     */
    const mine = sent.filter((t) => t.approvalRequestId === record.approvalRequestId);
    assert.equal(mine.length, 1, "exactly one message for this request");
    assert.equal(mine[0]!.channel, "discord");
    assert.equal(mine[0]!.canDecide, true);

    const stored = await pool.query<{ external_delivery_id: string; status: string }>(
      `SELECT external_delivery_id, status FROM untch_approval_deliveries WHERE approval_request_id = $1`,
      [record.approvalRequestId],
    );
    assert.equal(stored.rows[0]!.status, "SENT");
    assert.match(
      stored.rows[0]!.external_delivery_id,
      /^discord-msg-\d+$/,
      "the identifier the channel returned must be persisted, so a delivery can be traced to a real message",
    );

    /** Running the worker again must not duplicate a logical delivery. */
    await projectDeliveries(pool, { limit: 10 });
    const again = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_deliveries WHERE approval_request_id = $1`,
      [record.approvalRequestId],
    );
    assert.equal(again.rows[0]!.n, "1");
  });

  test("a rolled-back decision sends nothing", async () => {
    const gateway: ChannelGateway = {
      async send() {
        assert.fail("a rolled-back decision must never reach a channel");
      },
    };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await persistEscalatedApproval(client as never, store, auth("0xnonce-nosend"), input());
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    await projectDeliveries(pool, { limit: 10 });
    const report = await deliverOnce(pool, gateway, { limit: 10 });
    assert.equal(report.sent, 0);
  });
});
