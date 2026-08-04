import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import {
  APPROVAL_DIGEST_SCHEMA_VERSION,
  PgServiceCallStore,
  SettlementEvidenceError,
  approvalDigest,
  authorizationDigest,
  createPool,
  facilitatorOracle,
  finalizeSettlement,
  newApprovalRequestId,
  reconcileOnce,
  requestFingerprint,
  type AuthorizedTerms,
  type Pool,
  type SettlementEvidence,
} from "@untch/consumer-core";

/**
 * The settlement boundary, against a real database.
 *
 * Everything here exists because of one fact established by reading the installed x402 package:
 * `processSettlement` returns `success: true` for a `pending` settlement as well as a confirmed one.
 * A pending settlement is accepted and unconfirmed. So the tests that matter most are the ones that
 * prove a pending result changes nothing, and that the only path to an actionable approval runs
 * through evidence carrying a transaction hash.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_approval_settlement";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_settlementtestaccount01abc";
const CHAIN = "eip155:196";
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const PAYER = "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64";
const PAY_TO = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";

describe("the settlement boundary between a fee and a human", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
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

  const terms = (nonce: string, over: Partial<AuthorizedTerms> = {}): AuthorizedTerms => ({
    authorizationNonce: nonce,
    payer: PAYER,
    token: TOKEN,
    amount: "50000",
    payTo: PAY_TO,
    chain: CHAIN,
    ...over,
  });

  /**
   * One escalated paid request, as the handler would leave it: a service call, a verified payment
   * attempt, and a PROVISIONAL approval that nobody can act on.
   */
  const provisional = async (): Promise<{ serviceCallId: string; approvalRequestId: string; nonce: string }> => {
    seq += 1;
    const nonce = `0x${String(seq).padStart(4, "0")}${"a".repeat(60)}`;
    const call = await store.upsertServiceCall(
      {
        accountId: ACCOUNT,
        route: "/preflight_payment",
        idempotencyKey: `idem-${seq}`,
        requestFingerprint: requestFingerprint({
          provider: "untch",
          capability: "owned_work.demo",
          amount: "6.00",
          currency: "USDT0",
          policyId: "778001",
          deadline: "2026-08-04T12:00:00.000Z",
        }),
      },
      { decisionId: `dec_${seq}`, intentHash: `0xintent${seq}`, policyId: "778001" },
    );
    await store.recordAttempt(call.serviceCallId, terms(nonce), { validAfter: null, validBefore: null });
    const approvalRequestId = newApprovalRequestId();
    await pool.query(
      `INSERT INTO untch_approval_requests
        (approval_request_id, account_id, policy_id, policy_version, intent_id, quote_hash, provider, capability,
         amount, asset, reason, approval_digest, nonce, state, expires_at, created_by, updated_by,
         service_call_id, decision_id, approval_digest_schema_version)
       VALUES ($1,$2,'778001',1,$3,'qh','untch','owned_work.demo','6.00','USDT0','threshold',$4,$5,
               'PROVISIONAL', now() + interval '1 hour','test','test',$6,$7,$8)`,
      [
        approvalRequestId,
        ACCOUNT,
        `intent-${seq}`,
        `apd_${String(seq).padStart(64, "0")}`,
        `n${seq}`,
        call.serviceCallId,
        `dec_${seq}`,
        APPROVAL_DIGEST_SCHEMA_VERSION,
      ],
    );
    return { serviceCallId: call.serviceCallId, approvalRequestId, nonce };
  };

  const inTx = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  const stateOf = async (serviceCallId: string) => {
    const { rows } = await pool.query<{ state: string }>(
      `SELECT state FROM untch_x402_service_calls WHERE service_call_id = $1`,
      [serviceCallId],
    );
    return rows[0]!.state;
  };
  const requestState = async (id: string) => {
    const { rows } = await pool.query<{ state: string; settled_attempt_id: string | null }>(
      `SELECT state, settled_attempt_id FROM untch_approval_requests WHERE approval_request_id = $1`,
      [id],
    );
    return rows[0]!;
  };
  const outboxCount = async (id: string) => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_outbox WHERE approval_request_id = $1`,
      [id],
    );
    return Number(rows[0]!.n);
  };

  const confirmed = (nonce: string, tx: string): SettlementEvidence => ({
    kind: "CONFIRMED",
    source: "facilitator_settle_status",
    transactionHash: tx,
    paymentId: "pid-1",
    terms: terms(nonce),
  });

  // ── the pending trap ───────────────────────────────────────────────────────

  test("a pending settlement activates nothing, because processSettlement calls it success", async () => {
    const { serviceCallId, approvalRequestId } = await provisional();
    const result = await inTx((tx) =>
      finalizeSettlement(tx, {
        serviceCallId,
        evidence: { kind: "PENDING", transactionHash: "0xpending", paymentId: "pid" },
      }),
    );
    assert.equal(result.outcome, "LEFT_UNRESOLVED");
    assert.equal((await requestState(approvalRequestId)).state, "PROVISIONAL", "still nobody can act");
    assert.equal(await outboxCount(approvalRequestId), 0, "nobody was queued to be told");
  });

  test("a facilitator success with no transaction hash is refused as non-authoritative", async () => {
    const { serviceCallId, nonce } = await provisional();
    await assert.rejects(
      () =>
        inTx((tx) =>
          finalizeSettlement(tx, {
            serviceCallId,
            evidence: {
              kind: "CONFIRMED",
              source: "facilitator_success",
              transactionHash: "",
              paymentId: null,
              terms: terms(nonce),
            },
          }),
        ),
      (e: SettlementEvidenceError) => e.code === "EVIDENCE_NOT_AUTHORITATIVE",
    );
  });

  test("the database refuses a SETTLED attempt with no transaction hash", async () => {
    const { serviceCallId } = await provisional();
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE untch_x402_payment_attempts SET state='SETTLED', settled_at=now() WHERE service_call_id=$1`,
          [serviceCallId],
        ),
      /untch_x402_attempt_settled_has_evidence/,
    );
  });

  // ── activation ─────────────────────────────────────────────────────────────

  test("confirmed settlement activates exactly one request and one event", async () => {
    const { serviceCallId, approvalRequestId, nonce } = await provisional();
    const result = await inTx((tx) => finalizeSettlement(tx, { serviceCallId, evidence: confirmed(nonce, "0xtx-a") }));
    assert.equal(result.outcome, "ACTIVATED");
    const req = await requestState(approvalRequestId);
    assert.equal(req.state, "PENDING");
    assert.ok(req.settled_attempt_id, "an actionable request names the payment that bought it");
    assert.equal(await outboxCount(approvalRequestId), 1);
    assert.equal(await stateOf(serviceCallId), "FINALIZED");
  });

  test("repeated finalization is idempotent and creates no second event", async () => {
    const { serviceCallId, approvalRequestId, nonce } = await provisional();
    await inTx((tx) => finalizeSettlement(tx, { serviceCallId, evidence: confirmed(nonce, "0xtx-b") }));
    const again = await inTx((tx) => finalizeSettlement(tx, { serviceCallId, evidence: confirmed(nonce, "0xtx-b") }));
    assert.equal(again.outcome, "ALREADY_ACTIVE");
    assert.equal(again.approvalRequestId, approvalRequestId);
    assert.equal(await outboxCount(approvalRequestId), 1, "one fee, one notification");
  });

  test("a settled call refuses another payment attempt before any second transfer", async () => {
    const { serviceCallId, nonce } = await provisional();
    await inTx((tx) => finalizeSettlement(tx, { serviceCallId, evidence: confirmed(nonce, "0xtx-c") }));
    await assert.rejects(
      () => store.recordAttempt(serviceCallId, terms("0xfresh-nonce-c"), { validAfter: null, validBefore: null }),
      /cannot accept another payment attempt/,
    );
  });

  // ── evidence has to match what was authorized ──────────────────────────────

  for (const [field, over] of [
    ["payer", { payer: "0x000000000000000000000000000000000000dead" }],
    ["token", { token: "0x000000000000000000000000000000000000beef" }],
    ["amount", { amount: "999999" }],
    ["payTo", { payTo: "0x000000000000000000000000000000000000cafe" }],
    ["chain", { chain: "eip155:1" }],
  ] as const) {
    test(`a settlement whose ${field} differs is refused`, async () => {
      const { serviceCallId, nonce } = await provisional();
      await assert.rejects(
        () =>
          inTx((tx) =>
            finalizeSettlement(tx, {
              serviceCallId,
              evidence: {
                kind: "CONFIRMED",
                source: "facilitator_settle_status",
                transactionHash: `0xtx-${field}`,
                paymentId: null,
                terms: terms(nonce, over),
              },
            }),
          ),
        (e: SettlementEvidenceError) => e.code === "TERMS_MISMATCH",
      );
    });
  }

  test("a settlement for an unknown nonce is refused", async () => {
    const { serviceCallId } = await provisional();
    await assert.rejects(
      () => inTx((tx) => finalizeSettlement(tx, { serviceCallId, evidence: confirmed("0xnot-a-real-nonce", "0xtx-x") })),
      (e: SettlementEvidenceError) => e.code === "ATTEMPT_NOT_FOUND",
    );
  });

  // ── failure ────────────────────────────────────────────────────────────────

  test("a failed settlement leaves nothing actionable and can never become PENDING", async () => {
    const { serviceCallId, approvalRequestId } = await provisional();
    const result = await inTx((tx) =>
      finalizeSettlement(tx, {
        serviceCallId,
        evidence: { kind: "FAILED", failureCode: "INSUFFICIENT_BALANCE", failureDetail: null },
      }),
    );
    assert.equal(result.outcome, "PAYMENT_FAILED");
    assert.equal((await requestState(approvalRequestId)).state, "PAYMENT_FAILED");
    assert.equal(await outboxCount(approvalRequestId), 0);
    await assert.rejects(
      () => pool.query(`UPDATE untch_approval_requests SET state='PENDING' WHERE approval_request_id=$1`, [approvalRequestId]),
      /PAYMENT_FAILED is terminal/,
    );
  });

  // ── the interruption case ──────────────────────────────────────────────────

  test("a settlement confirmed before the process died is recovered by the reconciler", async () => {
    const { serviceCallId, approvalRequestId, nonce } = await provisional();
    /**
     * The cut point the whole design turns on. The transfer confirmed, and the service never got to
     * record it: no hash, no activation, and no callback is ever going to fire. Only asking the
     * facilitator can finish this.
     */
    await pool.query(
      `UPDATE untch_x402_payment_attempts SET state='SETTLEMENT_PENDING', transaction_hash=$2 WHERE authorization_nonce=$1`,
      [nonce, "0xtx-recovered"],
    );
    await pool.query(`UPDATE untch_x402_service_calls SET state='SETTLEMENT_PENDING' WHERE service_call_id=$1`, [serviceCallId]);

    const oracle = facilitatorOracle({
      async getSettleStatus() {
        return { success: true, status: "success" };
      },
    });
    const report = await reconcileOnce(pool, oracle, { limit: 50 });
    assert.ok(report.activated >= 1, "the reconciler finished what no callback could");
    assert.equal((await requestState(approvalRequestId)).state, "PENDING");
    assert.equal(await outboxCount(approvalRequestId), 1);
  });

  test("the reconciler leaves a still-pending settlement alone", async () => {
    const { serviceCallId, approvalRequestId, nonce } = await provisional();
    await pool.query(
      `UPDATE untch_x402_payment_attempts SET state='SETTLEMENT_PENDING', transaction_hash=$2 WHERE authorization_nonce=$1`,
      [nonce, "0xtx-still-pending"],
    );
    await pool.query(`UPDATE untch_x402_service_calls SET state='SETTLEMENT_PENDING' WHERE service_call_id=$1`, [serviceCallId]);
    const oracle = facilitatorOracle({
      async getSettleStatus() {
        return { success: true, status: "pending" };
      },
    });
    await reconcileOnce(pool, oracle, { limit: 50 });
    assert.equal((await requestState(approvalRequestId)).state, "PROVISIONAL");
    assert.equal(await outboxCount(approvalRequestId), 0);
  });

  test("an oracle that throws leaves the state unknown rather than failed", async () => {
    const { serviceCallId, approvalRequestId, nonce } = await provisional();
    await pool.query(
      `UPDATE untch_x402_payment_attempts SET state='SETTLEMENT_PENDING', transaction_hash=$2 WHERE authorization_nonce=$1`,
      [nonce, "0xtx-oracle-down"],
    );
    await pool.query(`UPDATE untch_x402_service_calls SET state='SETTLEMENT_PENDING' WHERE service_call_id=$1`, [serviceCallId]);
    const oracle = facilitatorOracle({
      async getSettleStatus() {
        throw new Error("facilitator unreachable");
      },
    });
    await reconcileOnce(pool, oracle, { limit: 50 });
    assert.equal((await requestState(approvalRequestId)).state, "PROVISIONAL", "an outage is not a refund");
    assert.equal(await outboxCount(approvalRequestId), 0);
  });

  test("two replicas reconciling at once converge on one activation and one event", async () => {
    const { serviceCallId, approvalRequestId, nonce } = await provisional();
    await pool.query(
      `UPDATE untch_x402_payment_attempts SET state='SETTLEMENT_PENDING', transaction_hash=$2 WHERE authorization_nonce=$1`,
      [nonce, "0xtx-two-replicas"],
    );
    await pool.query(`UPDATE untch_x402_service_calls SET state='SETTLEMENT_PENDING' WHERE service_call_id=$1`, [serviceCallId]);
    const oracle = facilitatorOracle({
      async getSettleStatus() {
        return { success: true, status: "success" };
      },
    });
    await Promise.all([reconcileOnce(pool, oracle, { limit: 50 }), reconcileOnce(pool, oracle, { limit: 50 })]);
    assert.equal((await requestState(approvalRequestId)).state, "PENDING");
    assert.equal(await outboxCount(approvalRequestId), 1, "two workers, one notification");
  });

  // ── identity ───────────────────────────────────────────────────────────────

  test("the same idempotency identity resolves to one service call", async () => {
    const id = {
      accountId: ACCOUNT,
      route: "/preflight_payment",
      idempotencyKey: "stable-key",
      requestFingerprint: requestFingerprint({
        provider: "untch",
        capability: "owned_work.demo",
        amount: "6.00",
        currency: "USDT0",
        policyId: "778001",
        deadline: "2026-08-04T12:00:00.000Z",
      }),
    };
    const first = await store.upsertServiceCall(id);
    const second = await store.upsertServiceCall(id);
    assert.equal(second.serviceCallId, first.serviceCallId, "a retry is the same call, not a new one");
  });

  test("the same key with different terms is a different service call", async () => {
    const base = { accountId: ACCOUNT, route: "/preflight_payment", idempotencyKey: "reused-key" };
    const cheap = await store.upsertServiceCall({
      ...base,
      requestFingerprint: requestFingerprint({
        provider: "untch", capability: "owned_work.demo", amount: "6.00",
        currency: "USDT0", policyId: "778001", deadline: "2026-08-04T12:00:00.000Z",
      }),
    });
    const dear = await store.upsertServiceCall({
      ...base,
      requestFingerprint: requestFingerprint({
        provider: "untch", capability: "owned_work.demo", amount: "6.50",
        currency: "USDT0", policyId: "778001", deadline: "2026-08-04T12:00:00.000Z",
      }),
    });
    assert.notEqual(dear.serviceCallId, cheap.serviceCallId, "a client key cannot merge two obligations");
  });

  test("an authorization digest changes with every term, and holds no signature", () => {
    const base = terms("0xn1");
    const digest = authorizationDigest(base);
    for (const over of [{ amount: "1" }, { payer: PAY_TO }, { payTo: PAYER }, { chain: "eip155:1" }, { token: PAYER }]) {
      assert.notEqual(authorizationDigest({ ...base, ...over }), digest);
    }
    assert.equal(authorizationDigest({ ...base, payer: PAYER.toUpperCase() }), digest, "address case is not a term");
  });

  // ── the digest ─────────────────────────────────────────────────────────────

  test("the v3 digest binds the settlement fields and leaves v1 and v2 untouched", () => {
    const subject = {
      intentId: "i", quoteHash: "q", amount: "6.00", asset: "USDT0", provider: "untch",
      capability: "owned_work.demo", recipient: null, policyId: "778001", policyVersion: 1,
      nonce: "n", expiresAt: "2026-08-04T12:00:00.000Z",
    };
    const v1 = approvalDigest(subject);
    const requester = {
      requesterPrincipalKind: "direct_account", requesterPrincipalNamespace: "untch",
      requesterPrincipalRef: "r", accountRefHash: "a", walletAuthorityRef: "w", quoteDigest: "qd",
    };
    const v2 = approvalDigest({ ...subject, requester });
    const v3Binding = {
      serviceCallId: "svc_1", decisionId: "dec_1", intentHash: "0xih", policyHash: "0xph",
      policySnapshotHash: "0xps", chain: CHAIN, taskHash: "0xth", acceptanceHash: "0xah",
      requestExpiresAt: "2026-08-04T11:00:00.000Z",
    };
    const v3 = approvalDigest({ ...subject, requester, v3: v3Binding });

    assert.notEqual(v2, v1, "v1 stays exactly what it was");
    assert.notEqual(v3, v2);
    assert.equal(approvalDigest(subject), v1, "adding v3 to the type did not move v1");

    for (const key of Object.keys(v3Binding) as (keyof typeof v3Binding)[]) {
      const changed = approvalDigest({ ...subject, requester, v3: { ...v3Binding, [key]: "CHANGED" } });
      assert.notEqual(changed, v3, `${key} must change the digest`);
    }
  });

  test("the ready event carries no account id, binding id or token", async () => {
    const { serviceCallId, approvalRequestId, nonce } = await provisional();
    await inTx((tx) => finalizeSettlement(tx, { serviceCallId, evidence: confirmed(nonce, "0xtx-projection") }));
    const { rows } = await pool.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM untch_approval_outbox WHERE approval_request_id = $1`,
      [approvalRequestId],
    );
    const body = JSON.stringify(rows[0]!.data);
    assert.ok(!body.includes(ACCOUNT), "the raw account id must never leave the service");
    for (const forbidden of ["accountId", "walletBindingId", "sessionToken", "bearer", "authorization"]) {
      assert.ok(!Object.keys(rows[0]!.data).includes(forbidden), `${forbidden} must not be published`);
    }
    assert.ok(rows[0]!.data.approvalDigest, "what it does carry is the commitment a human answers");
  });
});
