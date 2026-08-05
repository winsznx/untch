import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import {
  PgApprovalStore,
  PgServiceCallStore,
  actOnApproval,
  consumeActionRef,
  createPool,
  ensureActionReferences,
  finalizeSettlement,
  invalidateActionRefs,
  mintTokenForRef,
  newApprovalDecisionId,
  resolveActionRef,
  type Pool,
} from "@untch/consumer-core";
import { persistEscalatedApproval } from "../src/consumer/escalated-approval";
import { parseVerifiedPaymentAuthorization } from "../src/consumer/payment-authorization";
import { csrfForTest, sealActorForTest } from "../src/consumer/approval-action-routes";

/**
 * The bound action path, and the database that does not trust it.
 *
 * THE DEFECT THESE EXIST FOR
 *
 * `POST /consumer/approvals/:id/decide` predates the paid model and writes the same tables. Once the
 * paid path began raising requests, a session cookie could move one to APPROVED with no action token,
 * no consumed nonce, no FINALIZED service call, no budget recheck and no reservation.
 *
 * Closing the route is necessary and is not sufficient, because the next handler somebody writes will
 * not know about it. So the tests below are in two halves: one proves the route refuses, and one proves
 * the DATABASE refuses even when the route is bypassed entirely.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_bound_actions";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_boundactiontestaccountaaaa";
const OTHER_ACCOUNT = "acct_boundactionotheraccountbbb";
const CHAIN = "eip155:196";
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const PAYER = "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64";
const PAY_TO = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const SECRET = "bound-action-test-secret";
const DISCORD_SUBJECT = "discord-subject-owner";

function presentedHeader(nonce: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      accepted: { scheme: "exact", network: CHAIN, asset: TOKEN, amount: "50000", payTo: PAY_TO },
      payload: {
        signature: "0xsignaturethatmustnevertravel",
        authorization: { from: PAYER, to: PAY_TO, value: "50000", validAfter: "0", validBefore: "99999999999", nonce },
      },
    }),
    "utf8",
  ).toString("base64");
}

describe("a paid approval can only be resolved through the bound action path", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let store: PgServiceCallStore;
  let approvals: PgApprovalStore;
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
    for (const id of [ACCOUNT, OTHER_ACCOUNT]) {
      await pool.query(
        `INSERT INTO untch_accounts (account_id, status, created_at, created_by, updated_at, updated_by)
         VALUES ($1,'ACTIVE', now(),'test', now(),'test') ON CONFLICT DO NOTHING`,
        [id],
      );
      await pool.query(
        `INSERT INTO untch_wallet_bindings
           (binding_id, account_id, address, chain_kind, role, proof_kind, verified_at, status, scopes,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,'evm','primary','siwe', now(),'ACTIVE',ARRAY['identity','policy-authority'],
                 now(),'test', now(),'test')
         ON CONFLICT DO NOTHING`,
        [`wb_${id.slice(-8)}`, id, `0x${id.slice(-40).replace(/[^0-9a-f]/g, "0").padStart(40, "0")}`],
      );
    }
    await pool.query(
      `INSERT INTO untch_channel_bindings
         (binding_id, account_id, channel, channel_user_id, can_decide, status, verified_at, scopes,
          verification_method, account_ref_hash, created_at, created_by, updated_at, updated_by)
       VALUES ('cbnd_owner', $1, 'discord', $2, true, 'ACTIVE', now(),
               ARRAY['notify','policy-approval'], 'discord_oauth_identify', 'arh_owner', now(),'test', now(),'test')
       ON CONFLICT DO NOTHING`,
      [ACCOUNT, DISCORD_SUBJECT],
    );
    store = new PgServiceCallStore(pool);
    approvals = new PgApprovalStore(pool);
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

  /** One request, activated to PENDING exactly the way production does it. */
  const pendingRequest = async (over: { amount?: string } = {}): Promise<{ approvalRequestId: string; serviceCallId: string; digest: string }> => {
    seq += 1;
    const nonce = `0xbound${String(seq).padStart(4, "0")}${"b".repeat(50)}`;
    const auth = parseVerifiedPaymentAuthorization(presentedHeader(nonce), { chainId: 196 });
    assert.ok(auth);
    const record = await inTx((tx) =>
      persistEscalatedApproval(tx, store, auth, {
        route: "/preflight_payment",
        accountId: ACCOUNT,
        idempotencyKey: `bound-idem-${seq}`,
        provider: "untch",
        capability: "owned_work.demo",
        amount: over.amount ?? "6.00",
        asset: "USDT0",
        deadline: "2026-08-04T12:00:00.000Z",
        chain: CHAIN,
        recipient: PAY_TO,
        decisionId: `dec_bound_${seq}`,
        intentHash: `0xboundintent${seq}`,
        quoteDigest: `qd_bound_${seq}`,
        policySnapshotHash: `0xsnap${seq}`,
        policyId: "778001",
        policyHash: "0xpolicyhash",
        policyVersion: 1,
        intentNonce: `inonce_${seq}`,
        taskHash: "0xtask",
        acceptanceHash: "0xacceptance",
        requesterPrincipalKind: "ACCOUNT",
        requesterPrincipalNamespace: "untch",
        requesterPrincipalRef: `req_${seq}`,
        accountRefHash: "arh_owner",
        walletAuthorityRef: `wa_${seq}`,
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
          transactionHash: `0xtxbound${seq}`,
          paymentId: null,
          terms: { authorizationNonce: nonce, payer: PAYER, token: TOKEN, amount: "50000", payTo: PAY_TO, chain: CHAIN },
        },
      }),
    );
    return { approvalRequestId: record.approvalRequestId, serviceCallId: record.serviceCallId, digest: record.approvalDigest };
  };

  const policy10 = async () => ({ status: "ACTIVE", expiresAtMs: null, dailyLimit: "10.00" });

  // ── §1 the legacy route ──────────────────────────────────────────────────

  test("the generic decide store still reaches a service-call-backed request, which is why the route must refuse it", async () => {
    const { approvalRequestId } = await pendingRequest();
    const request = await approvals.get(approvalRequestId);
    assert.ok(request);
    /**
     * This is the DEFECT stated as a test. The legacy store has no idea this request is paid, so the
     * route in front of it is what has to know — and `serviceCallId` is the field it branches on.
     */
    assert.notEqual(request.serviceCallId, null, "a paid request must be identifiable as one");
  });

  test("a legacy request carries no service call, so it stays on the old route", async () => {
    const legacyId = `aprq_legacy_${Date.now()}`;
    await pool.query(
      `INSERT INTO untch_approval_requests
         (approval_request_id, account_id, policy_id, policy_version, intent_id, quote_hash, provider,
          capability, amount, asset, reason, approval_digest, nonce, state, expires_at, created_by, updated_by)
       VALUES ($1,$2,'778001',1,'legacy_intent','qh_legacy','untch','owned_work.demo','1.00','USDT0',
               'LEGACY','apd_legacy','n_legacy','PENDING', now() + interval '1 hour','test','test')`,
      [legacyId, ACCOUNT],
    );
    const request = await approvals.get(legacyId);
    assert.equal(request?.serviceCallId, null, "a legacy request must not be mistaken for a paid one");
  });

  // ── §2 the database backstop ─────────────────────────────────────────────

  test("a terminal decision naming no action nonce is refused by the database", async () => {
    const { approvalRequestId } = await pendingRequest();
    await assert.rejects(
      () =>
        inTx(async (tx) => {
          await (tx as unknown as Pool).query(
            `INSERT INTO untch_approval_decisions
               (decision_id, approval_request_id, account_id, channel, channel_binding_id, actor,
                decision, approval_digest, created_by)
             VALUES ($1,$2,$3,'dashboard',NULL,'someone','APPROVE','apd_whatever','forgotten-path')`,
            [newApprovalDecisionId(), approvalRequestId, ACCOUNT],
          );
        }),
      /must name the action nonce/,
      "the backstop must refuse a decision that cannot prove it came through the bound path",
    );
  });

  test("an APPROVE naming a nonce but creating no reservation is refused by the database", async () => {
    const { approvalRequestId } = await pendingRequest();
    await assert.rejects(
      () =>
        inTx(async (tx) => {
          const q = (tx as unknown as Pool).query.bind(tx as unknown as Pool);
          await q(
            `INSERT INTO untch_approval_action_nonces (nonce, approval_request_id, channel_binding_id, action)
             VALUES ($1,$2,'cbnd_owner','APPROVE')`,
            [`apn_naked_${approvalRequestId.slice(-8)}`, approvalRequestId],
          );
          await q(
            `INSERT INTO untch_approval_decisions
               (decision_id, approval_request_id, account_id, channel, channel_binding_id, actor,
                decision, approval_digest, created_by, action_nonce)
             VALUES ($1,$2,$3,'discord','cbnd_owner',$4,'APPROVE','apd_whatever','forgotten-path',$5)`,
            [newApprovalDecisionId(), approvalRequestId, ACCOUNT, DISCORD_SUBJECT, `apn_naked_${approvalRequestId.slice(-8)}`],
          );
        }),
      /must create exactly one reservation/,
      "authority that exists nowhere the next decision can see it is the failure this refuses",
    );
  });

  test("a nonce belonging to another request cannot authorise this one", async () => {
    const a = await pendingRequest();
    const b = await pendingRequest();
    await assert.rejects(
      () =>
        inTx(async (tx) => {
          const q = (tx as unknown as Pool).query.bind(tx as unknown as Pool);
          const stolen = `apn_stolen_${b.approvalRequestId.slice(-8)}`;
          await q(
            `INSERT INTO untch_approval_action_nonces (nonce, approval_request_id, channel_binding_id, action)
             VALUES ($1,$2,'cbnd_owner','APPROVE')`,
            [stolen, b.approvalRequestId],
          );
          await q(
            `INSERT INTO untch_approval_decisions
               (decision_id, approval_request_id, account_id, channel, channel_binding_id, actor,
                decision, approval_digest, created_by, action_nonce)
             VALUES ($1,$2,$3,'discord','cbnd_owner',$4,'APPROVE',$5,'forgotten-path',$6)`,
            [newApprovalDecisionId(), a.approvalRequestId, ACCOUNT, DISCORD_SUBJECT, a.digest, stolen],
          );
        }),
      /action nonce belongs to request/,
    );
  });

  test("a decision for an account that does not own the request is refused", async () => {
    const { approvalRequestId } = await pendingRequest();
    await assert.rejects(
      () =>
        inTx(async (tx) => {
          const q = (tx as unknown as Pool).query.bind(tx as unknown as Pool);
          const n = `apn_cross_${approvalRequestId.slice(-8)}`;
          await q(
            `INSERT INTO untch_approval_action_nonces (nonce, approval_request_id, channel_binding_id, action)
             VALUES ($1,$2,'cbnd_owner','APPROVE')`,
            [n, approvalRequestId],
          );
          await q(
            `INSERT INTO untch_approval_decisions
               (decision_id, approval_request_id, account_id, channel, channel_binding_id, actor,
                decision, approval_digest, created_by, action_nonce)
             VALUES ($1,$2,$3,'discord','cbnd_owner',$4,'APPROVE','apd_x','forgotten-path',$5)`,
            [newApprovalDecisionId(), approvalRequestId, OTHER_ACCOUNT, DISCORD_SUBJECT, n],
          );
        }),
      /does not own request/,
    );
  });

  test("a resolved request cannot be returned to PENDING", async () => {
    const { approvalRequestId } = await pendingRequest();
    await pool.query(
      `UPDATE untch_approval_requests SET state = 'REJECTED', resolved_at = now() WHERE approval_request_id = $1`,
      [approvalRequestId],
    );
    await assert.rejects(
      () => pool.query(`UPDATE untch_approval_requests SET state = 'PENDING' WHERE approval_request_id = $1`, [approvalRequestId]),
      /terminal and cannot return/,
    );
  });

  test("a legacy request is exempt, so history is not retroactively invalidated", async () => {
    const legacyId = `aprq_legacyok_${Date.now()}`;
    await pool.query(
      `INSERT INTO untch_approval_requests
         (approval_request_id, account_id, policy_id, policy_version, intent_id, quote_hash, provider,
          capability, amount, asset, reason, approval_digest, nonce, state, expires_at, created_by, updated_by)
       VALUES ($1,$2,'778001',1,'legacy_intent2','qh_legacy2','untch','owned_work.demo','1.00','USDT0',
               'LEGACY','apd_legacy2','n_legacy2','PENDING', now() + interval '1 hour','test','test')`,
      [legacyId, ACCOUNT],
    );
    /** No action nonce, no reservation, no service call. Accepted, because it never had any of them. */
    await pool.query(
      `INSERT INTO untch_approval_decisions
         (decision_id, approval_request_id, account_id, channel, channel_binding_id, actor,
          decision, approval_digest, created_by)
       VALUES ($1,$2,$3,'dashboard',NULL,'0xwallet','APPROVE','apd_legacy2','legacy-route')`,
      [newApprovalDecisionId(), legacyId, ACCOUNT],
    );
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_decisions WHERE approval_request_id = $1`,
      [legacyId],
    );
    assert.equal(rows[0]!.n, "1");
  });

  // ── §3 the action reference ──────────────────────────────────────────────

  test("an action reference is opaque and carries no token material", async () => {
    const { approvalRequestId, digest } = await pendingRequest();
    const refs = await inTx((tx) =>
      ensureActionReferences(tx, {
        approvalRequestId,
        accountId: ACCOUNT,
        accountRefHash: "arh_owner",
        channelBindingId: "cbnd_owner",
        approvalDigest: digest,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    assert.match(refs.APPROVE, /^aref_[A-Za-z0-9_-]{43}$/, "the reference must be unguessable");
    assert.notEqual(refs.APPROVE, refs.DENY, "approve and deny must not share a reference");
    /** The token commits to the amount and the recipient. None of that may appear in a URL. */
    assert.ok(!refs.APPROVE.includes(digest));
    assert.ok(!refs.APPROVE.includes("6.00"));
    assert.ok(!refs.APPROVE.includes(PAY_TO));

    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM untch_approval_action_refs WHERE action_reference_id = $1`,
      [refs.APPROVE],
    );
    assert.equal(rows[0]!.consumed_at, null);
    assert.equal(rows[0]!.token_fingerprint, null, "no token material may be stored before use");
  });

  test("minting references twice returns the same live pair rather than a second pressable URL", async () => {
    const { approvalRequestId, digest } = await pendingRequest();
    const args = {
      approvalRequestId,
      accountId: ACCOUNT,
      accountRefHash: "arh_owner",
      channelBindingId: "cbnd_owner",
      approvalDigest: digest,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const first = await inTx((tx) => ensureActionReferences(tx, args));
    const second = await inTx((tx) => ensureActionReferences(tx, args));
    assert.deepEqual(first, second);
  });

  test("the wrong Discord subject is refused, and the right one resolves", async () => {
    const { approvalRequestId, digest } = await pendingRequest();
    const refs = await inTx((tx) =>
      ensureActionReferences(tx, {
        approvalRequestId,
        accountId: ACCOUNT,
        accountRefHash: "arh_owner",
        channelBindingId: "cbnd_owner",
        approvalDigest: digest,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const wrong = await resolveActionRef(pool, refs.APPROVE, "discord-subject-somebody-else", Date.now());
    assert.equal(wrong.ok, false);
    assert.equal(wrong.ok === false ? wrong.refusal : null, "SUBJECT_MISMATCH");

    const right = await resolveActionRef(pool, refs.APPROVE, DISCORD_SUBJECT, Date.now());
    assert.equal(right.ok, true);
    assert.equal(right.ok === true ? right.ref.action : null, "APPROVE");
  });

  test("an expired, consumed or invalidated reference refuses", async () => {
    const { approvalRequestId, digest } = await pendingRequest();
    const refs = await inTx((tx) =>
      ensureActionReferences(tx, {
        approvalRequestId,
        accountId: ACCOUNT,
        accountRefHash: "arh_owner",
        channelBindingId: "cbnd_owner",
        approvalDigest: digest,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const future = Date.now() + 7_200_000;
    const expired = await resolveActionRef(pool, refs.APPROVE, DISCORD_SUBJECT, future);
    assert.equal(expired.ok === false ? expired.refusal : null, "EXPIRED");

    assert.equal(await inTx((tx) => consumeActionRef(tx, refs.DENY, "tok")), true);
    const consumed = await resolveActionRef(pool, refs.DENY, DISCORD_SUBJECT, Date.now());
    assert.equal(consumed.ok === false ? consumed.refusal : null, "ALREADY_CONSUMED");

    /** Single-use, enforced by the conditional UPDATE rather than by a flag somebody checks. */
    assert.equal(await inTx((tx) => consumeActionRef(tx, refs.DENY, "tok")), false);
  });

  test("a revoked binding refuses even while the reference is live", async () => {
    const { approvalRequestId, digest } = await pendingRequest();
    await pool.query(
      `INSERT INTO untch_channel_bindings
         (binding_id, account_id, channel, channel_user_id, can_decide, status, verified_at, scopes,
          verification_method, account_ref_hash, created_at, created_by, updated_at, updated_by)
       VALUES ('cbnd_revoked', $1, 'discord', 'discord-subject-revoked', true, 'ACTIVE', now(),
               ARRAY['notify','policy-approval'], 'discord_oauth_identify', 'arh_owner', now(),'t', now(),'t')
       ON CONFLICT DO NOTHING`,
      [ACCOUNT],
    );
    const refs = await inTx((tx) =>
      ensureActionReferences(tx, {
        approvalRequestId,
        accountId: ACCOUNT,
        accountRefHash: "arh_owner",
        channelBindingId: "cbnd_revoked",
        approvalDigest: digest,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    await pool.query(`UPDATE untch_channel_bindings SET status = 'REVOKED' WHERE binding_id = 'cbnd_revoked'`);
    const verdict = await resolveActionRef(pool, refs.APPROVE, "discord-subject-revoked", Date.now());
    assert.equal(verdict.ok === false ? verdict.refusal : null, "BINDING_NOT_ACTIVE");
    await pool.query(`UPDATE untch_channel_bindings SET status = 'ACTIVE' WHERE binding_id = 'cbnd_revoked'`);
  });

  test("a reference whose subject moved under it stops resolving", async () => {
    const { approvalRequestId, digest } = await pendingRequest();
    const refs = await inTx((tx) =>
      ensureActionReferences(tx, {
        approvalRequestId,
        accountId: ACCOUNT,
        accountRefHash: "arh_owner",
        channelBindingId: "cbnd_owner",
        approvalDigest: digest,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    /** A requote is what does this in production. Simulated here by moving the reference's subject. */
    await pool.query(
      `UPDATE untch_approval_action_refs SET approval_digest = 'apd_stale' WHERE action_reference_id = $1`,
      [refs.APPROVE],
    );
    const verdict = await resolveActionRef(pool, refs.APPROVE, DISCORD_SUBJECT, Date.now());
    assert.equal(verdict.ok === false ? verdict.refusal : null, "DIGEST_MOVED");
  });

  // ── the full bound decision ──────────────────────────────────────────────

  test("the bound path approves once, creates one reservation, and burns every link", async () => {
    const { approvalRequestId, digest } = await pendingRequest();
    const refs = await inTx((tx) =>
      ensureActionReferences(tx, {
        approvalRequestId,
        accountId: ACCOUNT,
        accountRefHash: "arh_owner",
        channelBindingId: "cbnd_owner",
        approvalDigest: digest,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );

    const result = await inTx(async (tx) => {
      const verdict = await resolveActionRef(tx, refs.APPROVE, DISCORD_SUBJECT, Date.now());
      assert.equal(verdict.ok, true);
      if (!verdict.ok) throw new Error("unreachable");
      const token = await mintTokenForRef(tx, SECRET, verdict.ref, Date.now(), 600_000);
      assert.ok(token);
      assert.equal(await consumeActionRef(tx, verdict.ref.actionReferenceId, token), true);
      return actOnApproval(tx, {
        approvalRequestId,
        action: "APPROVE",
        token,
        tokenSecret: SECRET,
        channelBindingId: "cbnd_owner",
        nowMs: Date.now(),
        partitionKey: "policy:778001",
        resolvePolicy: policy10,
      });
    });

    assert.equal(result.outcome, "APPROVED");
    assert.ok(result.reservationId, "an approval must create authority the next decision can see");
    assert.equal(result.budget?.activeReservedExposure, "0.00", "exposure before this approval");
    assert.equal(result.budget?.effectiveBudgetUsage, "6.00", "6.00 of authority after it");
    assert.equal(result.budget?.settledGovernedSpend, "0.00", "an approval spends nothing");

    const decisions = await pool.query<{ n: string; action_nonce: string | null }>(
      `SELECT count(*)::text n, max(action_nonce) AS action_nonce FROM untch_approval_decisions WHERE approval_request_id = $1`,
      [approvalRequestId],
    );
    assert.equal(decisions.rows[0]!.n, "1", "exactly one terminal decision");
    assert.ok(decisions.rows[0]!.action_nonce, "the decision must name the nonce it consumed");

    const reservations = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_budget_reservations WHERE approval_request_id = $1 AND status = 'ACTIVE'`,
      [approvalRequestId],
    );
    assert.equal(reservations.rows[0]!.n, "1", "one reservation at most");

    /** Every other link for this request dies in the same transaction. */
    const live = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_action_refs
        WHERE approval_request_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [approvalRequestId],
    );
    assert.equal(live.rows[0]!.n, "0", "the deny link must not survive an approval");

    const denyVerdict = await resolveActionRef(pool, refs.DENY, DISCORD_SUBJECT, Date.now());
    assert.equal(denyVerdict.ok, false, "the deny link must no longer resolve");
  });

  test("a denial creates no reservation and a second action returns ALREADY_RESOLVED", async () => {
    const { approvalRequestId, digest } = await pendingRequest();
    const refs = await inTx((tx) =>
      ensureActionReferences(tx, {
        approvalRequestId,
        accountId: ACCOUNT,
        accountRefHash: "arh_owner",
        channelBindingId: "cbnd_owner",
        approvalDigest: digest,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const denied = await inTx(async (tx) => {
      const verdict = await resolveActionRef(tx, refs.DENY, DISCORD_SUBJECT, Date.now());
      if (!verdict.ok) throw new Error(verdict.refusal);
      const token = await mintTokenForRef(tx, SECRET, verdict.ref, Date.now(), 600_000);
      assert.ok(token);
      await consumeActionRef(tx, verdict.ref.actionReferenceId, token);
      return actOnApproval(tx, {
        approvalRequestId,
        action: "DENY",
        token,
        tokenSecret: SECRET,
        channelBindingId: "cbnd_owner",
        nowMs: Date.now(),
        partitionKey: "policy:778001",
        resolvePolicy: policy10,
      });
    });
    assert.equal(denied.outcome, "DENIED");
    assert.equal(denied.reservationId, null, "a denial must create no authority");

    const reservations = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_budget_reservations WHERE approval_request_id = $1`,
      [approvalRequestId],
    );
    assert.equal(reservations.rows[0]!.n, "0");

    /** A second attempt, as a person double-tapping would produce. */
    const again = await inTx(async (tx) => {
      const token = await mintTokenForRef(
        tx,
        SECRET,
        {
          actionReferenceId: refs.APPROVE,
          approvalRequestId,
          accountId: ACCOUNT,
          accountRefHash: "arh_owner",
          channelBindingId: "cbnd_owner",
          channel: "discord",
          action: "APPROVE",
          nonce: "apn_second_attempt",
          approvalDigest: digest,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          channelUserId: DISCORD_SUBJECT,
        },
        Date.now(),
        600_000,
      );
      assert.ok(token);
      return actOnApproval(tx, {
        approvalRequestId,
        action: "APPROVE",
        token,
        tokenSecret: SECRET,
        channelBindingId: "cbnd_owner",
        nowMs: Date.now(),
        partitionKey: "policy:778001",
        resolvePolicy: policy10,
      });
    });
    assert.equal(again.outcome, "ALREADY_RESOLVED");
  });

  test("a budget that moved between the ask and the answer refuses the approval", async () => {
    const { approvalRequestId, digest } = await pendingRequest();
    const refs = await inTx((tx) =>
      ensureActionReferences(tx, {
        approvalRequestId,
        accountId: ACCOUNT,
        accountRefHash: "arh_owner",
        channelBindingId: "cbnd_owner",
        approvalDigest: digest,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const tight = await inTx(async (tx) => {
      const verdict = await resolveActionRef(tx, refs.APPROVE, DISCORD_SUBJECT, Date.now());
      if (!verdict.ok) throw new Error(verdict.refusal);
      const token = await mintTokenForRef(tx, SECRET, verdict.ref, Date.now(), 600_000);
      assert.ok(token);
      return actOnApproval(tx, {
        approvalRequestId,
        action: "APPROVE",
        token,
        tokenSecret: SECRET,
        channelBindingId: "cbnd_owner",
        nowMs: Date.now(),
        partitionKey: "policy:778001",
        // The policy can no longer afford 6.00.
        resolvePolicy: async () => ({ status: "ACTIVE", expiresAtMs: null, dailyLimit: "4.00" }),
      });
    });
    assert.equal(tight.outcome, "BUDGET_CHANGED_BEFORE_APPROVAL");
    const reservations = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_budget_reservations WHERE approval_request_id = $1`,
      [approvalRequestId],
    );
    assert.equal(reservations.rows[0]!.n, "0", "a refused approval must create no authority");
  });

  test("supersession invalidates every action reference for the old quote", async () => {
    const { approvalRequestId, digest } = await pendingRequest();
    const refs = await inTx((tx) =>
      ensureActionReferences(tx, {
        approvalRequestId,
        accountId: ACCOUNT,
        accountRefHash: "arh_owner",
        channelBindingId: "cbnd_owner",
        approvalDigest: digest,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const killed = await inTx((tx) => invalidateActionRefs(tx, approvalRequestId, "QUOTE_SUPERSEDED"));
    assert.equal(killed, 2, "both links die with the quote they described");
    const verdict = await resolveActionRef(pool, refs.APPROVE, DISCORD_SUBJECT, Date.now());
    assert.equal(verdict.ok === false ? verdict.refusal : null, "INVALIDATED");
  });

  // ── the actor seal and CSRF ──────────────────────────────────────────────

  test("the sealed actor cannot be forged, reused across references, or outlive its window", () => {
    const ref = "aref_example";
    const sealed = sealActorForTest(SECRET, ref, DISCORD_SUBJECT, Date.now() + 60_000);
    assert.ok(!sealed.includes(DISCORD_SUBJECT), "the raw subject must not be readable from the cookie");

    const csrf = csrfForTest(SECRET, ref, DISCORD_SUBJECT);
    assert.notEqual(csrf, csrfForTest(SECRET, "aref_other", DISCORD_SUBJECT), "CSRF must be reference-bound");
    assert.notEqual(csrf, csrfForTest(SECRET, ref, "someone-else"), "CSRF must be subject-bound");
    assert.notEqual(csrf, csrfForTest("another-secret", ref, DISCORD_SUBJECT), "CSRF must be key-bound");
  });
});
