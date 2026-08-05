import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import {
  PgServiceCallStore,
  createPool,
  finalizeSettlement,
  newApprovalDecisionId,
  type Pool,
} from "@untch/consumer-core";
import { persistEscalatedApproval } from "../src/consumer/escalated-approval";
import { parseVerifiedPaymentAuthorization } from "../src/consumer/payment-authorization";

/**
 * Migration 030's backstop, exercised the way it will actually be attacked.
 *
 * WHAT A BACKSTOP IS FOR
 *
 * Every refusal here is already made by application code, and that is exactly why these exist. The
 * failure this closes was not a missing check; it was a SECOND WRITER — a route that predated the paid
 * model and wrote the same tables without knowing the new rules. Closing that route fixed the instance
 * of the problem and none of the class, because the next handler somebody writes will not know either.
 *
 * So none of the writes below go through application code. They are raw INSERTs against a database that
 * has been set up correctly by the real path and is then asked, in SQL, to accept something the real
 * path would never produce. If the trigger is the thing keeping the invariant, these fail; if the
 * application code was, they succeed and the invariant was never real.
 *
 * `bound-approval-action-pg` covers the nonce, the actor and the resurrection cases. This covers the
 * three the trigger enforces that nothing yet asserts: an unpaid service call, a reservation that names
 * somebody else's decision, and a refusal that granted authority anyway.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_migration_030";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_m030owneraaaaaaaaaaaaaaaaa";
const OTHER_ACCOUNT = "acct_m030otherbbbbbbbbbbbbbbbbb";
const CHAIN = "eip155:196";
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const PAYER = "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64";
const PAY_TO = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const SUBJECT = "discord-subject-m030";
const BINDING = "cbnd_m030";

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

describe(
  "the database refuses what no application code is asked about",
  { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" },
  () => {
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
      for (const id of [ACCOUNT, OTHER_ACCOUNT]) {
        await pool.query(
          `INSERT INTO untch_accounts (account_id, status, created_at, created_by, updated_at, updated_by)
           VALUES ($1,'ACTIVE', now(),'test', now(),'test')`,
          [id],
        );
      }
      await pool.query(
        `INSERT INTO untch_channel_bindings
           (binding_id, account_id, channel, channel_user_id, can_decide, status, verified_at, scopes,
            verification_method, account_ref_hash, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,'discord',$3,true,'ACTIVE', now(), ARRAY['notify','policy-approval'],
                 'discord_oauth_identify','arh_m030', now(),'test', now(),'test')`,
        [BINDING, ACCOUNT, SUBJECT],
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

    /**
     * A real request against a real service call. `settle` decides whether the fee that bought the right
     * to ask was ever confirmed — which is the difference between a request somebody paid for and one
     * they did not.
     */
    const request = async (settle: boolean): Promise<{ approvalRequestId: string; serviceCallId: string }> => {
      seq += 1;
      const nonce = `0xm030${String(seq).padStart(4, "0")}${"e".repeat(51)}`;
      const auth = parseVerifiedPaymentAuthorization(presentedHeader(nonce), { chainId: 196 });
      assert.ok(auth);
      const record = await inTx((tx) =>
        persistEscalatedApproval(tx, store, auth, {
          route: "/preflight_payment",
          accountId: ACCOUNT,
          idempotencyKey: `m030-idem-${seq}`,
          provider: "untch",
          capability: "owned_work.demo",
          amount: "6.00",
          asset: "USDT0",
          deadline: "2026-08-04T12:00:00.000Z",
          chain: CHAIN,
          recipient: PAY_TO,
          decisionId: `dec_m030_${seq}`,
          intentHash: `0xm030intent${seq}`,
          quoteDigest: `qd_m030_${seq}`,
          policySnapshotHash: `0xsnap${seq}`,
          policyId: "781001",
          policyHash: "0xpolicyhash",
          policyVersion: 1,
          intentNonce: `inonce_m030_${seq}`,
          taskHash: "0xtask",
          acceptanceHash: "0xacceptance",
          requesterPrincipalKind: "ACCOUNT",
          requesterPrincipalNamespace: "untch",
          requesterPrincipalRef: `req_m030_${seq}`,
          accountRefHash: "arh_m030",
          walletAuthorityRef: `wa_m030_${seq}`,
          reason: "ESCALATED_THRESHOLD",
          approvalExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      );
      if (settle) {
        await inTx((tx) =>
          finalizeSettlement(tx, {
            serviceCallId: record.serviceCallId,
            evidence: {
              kind: "CONFIRMED",
              source: "facilitator_settle_status",
              transactionHash: `0xtxm030${seq}`,
              paymentId: null,
              terms: { authorizationNonce: nonce, payer: PAYER, token: TOKEN, amount: "50000", payTo: PAY_TO, chain: CHAIN },
            },
          }),
        );
      }
      return { approvalRequestId: record.approvalRequestId, serviceCallId: record.serviceCallId };
    };

    /** A consumed nonce, written directly, because the point is to satisfy every OTHER check. */
    const nonceFor = async (
      tx: { query(sql: string, params?: readonly unknown[]): Promise<unknown> },
      approvalRequestId: string,
      action: "APPROVE" | "DENY",
    ): Promise<string> => {
      const nonce = `apn_m030_${approvalRequestId.slice(-10)}_${action}`;
      await tx.query(
        `INSERT INTO untch_approval_action_nonces (nonce, approval_request_id, channel_binding_id, action)
         VALUES ($1,$2,$3,$4)`,
        [nonce, approvalRequestId, BINDING, action],
      );
      return nonce;
    };

    const insertDecision = async (
      tx: { query(sql: string, params?: readonly unknown[]): Promise<unknown> },
      args: { decisionId: string; approvalRequestId: string; decision: "APPROVE" | "REJECT"; nonce: string },
    ): Promise<void> => {
      await tx.query(
        `INSERT INTO untch_approval_decisions
           (decision_id, approval_request_id, account_id, channel, channel_binding_id, actor,
            decision, approval_digest, created_by, action_nonce)
         VALUES ($1,$2,$3,'discord',$4,$5,$6,'apd_whatever','raw-sql-bypass',$7)`,
        [args.decisionId, args.approvalRequestId, ACCOUNT, BINDING, SUBJECT, args.decision, args.nonce],
      );
    };

    const insertReservation = async (
      tx: { query(sql: string, params?: readonly unknown[]): Promise<unknown> },
      args: { reservationId: string; approvalRequestId: string; decisionId: string },
    ): Promise<void> => {
      await tx.query(
        `INSERT INTO untch_budget_reservations
           (reservation_id, account_id, policy_id, partition_key, decision_id, intent_id, intent_hash,
            quote_digest, requester_principal_ref, wallet_authority_ref, amount, asset, chain, recipient,
            provider, capability, day_key, status, expires_at, approval_request_id, approval_decision_id)
         VALUES ($1,$2,'781001','policy:781001',$3,$4,$5,'qd','req','wa',6.00,'USDT0',$6,$7,
                 'untch','owned_work.demo','2026-08-05','ACTIVE', now() + interval '1 hour', $8, $9)`,
        [
          args.reservationId,
          ACCOUNT,
          `dec_raw_${args.reservationId.slice(-8)}`,
          `int_${args.reservationId.slice(-8)}`,
          `0xhash${args.reservationId.slice(-8)}`,
          CHAIN,
          PAY_TO,
          args.approvalRequestId,
          args.decisionId,
        ],
      );
    };

    /**
     * The trigger is DEFERRABLE INITIALLY DEFERRED, so it fires at COMMIT rather than at INSERT. A test
     * that only awaited the INSERT would see it succeed and conclude the database allows it.
     */
    const commitShouldFail = async (
      body: (tx: { query(sql: string, params?: readonly unknown[]): Promise<unknown> }) => Promise<void>,
      expected: RegExp,
      why: string,
    ): Promise<void> => {
      const client = await pool.connect();
      let error: unknown = null;
      try {
        await client.query("BEGIN");
        await body(client as never);
        await client.query("COMMIT");
      } catch (err) {
        error = err;
        await client.query("ROLLBACK").catch(() => undefined);
      } finally {
        client.release();
      }
      assert.ok(error, why);
      assert.match(String((error as Error).message), expected, why);
    };

    test("a decision on a request whose fee never settled is refused", async () => {
      const r = await request(false);
      const { rows } = await pool.query<{ state: string }>(
        `SELECT state FROM untch_x402_service_calls WHERE service_call_id = $1`,
        [r.serviceCallId],
      );
      assert.notEqual(rows[0]!.state, "FINALIZED", "the fixture must start from an unsettled call");

      await commitShouldFail(
        async (tx) => {
          const nonce = await nonceFor(tx, r.approvalRequestId, "APPROVE");
          const decisionId = newApprovalDecisionId();
          await insertDecision(tx, {
            decisionId,
            approvalRequestId: r.approvalRequestId,
            decision: "APPROVE",
            nonce,
          });
          await insertReservation(tx, {
            reservationId: `resv_unpaid_${seq}`,
            approvalRequestId: r.approvalRequestId,
            decisionId,
          });
        },
        /not FINALIZED/,
        "an approval nobody paid for is authority nobody bought",
      );
    });

    test("an APPROVE whose reservation names a different decision is refused", async () => {
      const r = await request(true);
      await commitShouldFail(
        async (tx) => {
          const nonce = await nonceFor(tx, r.approvalRequestId, "APPROVE");
          const decisionId = newApprovalDecisionId();
          await insertDecision(tx, {
            decisionId,
            approvalRequestId: r.approvalRequestId,
            decision: "APPROVE",
            nonce,
          });
          /**
           * The reservation exists, is ACTIVE, and belongs to this request. It simply names a decision
           * that is not this one — which is how a hold could be created by one answer and counted as
           * the authority for another.
           */
          await insertReservation(tx, {
            reservationId: `resv_wrongdec_${seq}`,
            approvalRequestId: r.approvalRequestId,
            decisionId: newApprovalDecisionId(),
          });
        },
        /must create exactly one reservation naming it/,
        "a reservation that names another decision is not this decision's authority",
      );
    });

    test("a DENY that created a reservation anyway is refused", async () => {
      const r = await request(true);
      await commitShouldFail(
        async (tx) => {
          const nonce = await nonceFor(tx, r.approvalRequestId, "DENY");
          const decisionId = newApprovalDecisionId();
          await insertDecision(tx, {
            decisionId,
            approvalRequestId: r.approvalRequestId,
            decision: "REJECT",
            nonce,
          });
          await insertReservation(tx, {
            reservationId: `resv_denied_${seq}`,
            approvalRequestId: r.approvalRequestId,
            decisionId,
          });
        },
        /must create no reservation/,
        "a refusal that granted spending authority is the worst possible outcome of a No",
      );
    });

    /**
     * The mirror of the case above. Refusing bad writes is only half of a backstop; a backstop that also
     * refused the CORRECT write would be discovered in production by a person whose approval failed.
     */
    test("the shape the real path produces is accepted", async () => {
      const r = await request(true);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const nonce = await nonceFor(client as never, r.approvalRequestId, "APPROVE");
        const decisionId = newApprovalDecisionId();
        await insertDecision(client as never, {
          decisionId,
          approvalRequestId: r.approvalRequestId,
          decision: "APPROVE",
          nonce,
        });
        await insertReservation(client as never, {
          reservationId: `resv_good_${seq}`,
          approvalRequestId: r.approvalRequestId,
          decisionId,
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM untch_approval_decisions WHERE approval_request_id = $1`,
        [r.approvalRequestId],
      );
      assert.equal(Number(rows[0]!.n), 1);
    });

    /**
     * The exemption, asserted as a NARROW one. It is keyed on `service_call_id IS NULL` and nothing else,
     * because a request raised before the paid model existed cannot retroactively acquire a fee — and any
     * broader exemption would be a way back in for the writer this trigger exists to stop.
     */
    test("the legacy exemption is exactly service_call_id IS NULL, and nothing wider", async () => {
      const legacyId = `aprq_m030legacy${String(seq + 900).padStart(6, "0")}`;
      await pool.query(
        `INSERT INTO untch_approval_requests
           (approval_request_id, account_id, state, reason, provider, capability, amount, asset, recipient,
            policy_id, policy_version, nonce, expires_at, approval_digest, intent_id, quote_hash,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,'PENDING','ESCALATED_THRESHOLD','untch','owned_work.demo',6.00,'USDT0',$3,
                 '781001',1,$4, now() + interval '1 hour','apd_legacy',$5,'qh_legacy',
                 now(),'test', now(),'test')`,
        [legacyId, ACCOUNT, PAY_TO, `nonce_${legacyId.slice(-8)}`, `int_${legacyId.slice(-8)}`],
      );

      const { rows: check } = await pool.query<{ service_call_id: string | null }>(
        `SELECT service_call_id FROM untch_approval_requests WHERE approval_request_id = $1`,
        [legacyId],
      );
      assert.equal(check[0]!.service_call_id, null, "the fixture must be a genuinely legacy request");

      /** No nonce, no reservation, no service call — and accepted, because history is not rewritten. */
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO untch_approval_decisions
             (decision_id, approval_request_id, account_id, channel, channel_binding_id, actor,
              decision, approval_digest, created_by)
           VALUES ($1,$2,$3,'dashboard',NULL,'legacy-actor','APPROVE','apd_legacy','legacy-path')`,
          [newApprovalDecisionId(), legacyId, ACCOUNT],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM untch_approval_decisions WHERE approval_request_id = $1`,
        [legacyId],
      );
      assert.equal(Number(rows[0]!.n), 1, "a legacy request must still be answerable");
    });

    test("a request that HAS a service call gets no part of the legacy exemption", async () => {
      const r = await request(true);
      await commitShouldFail(
        async (tx) => {
          await tx.query(
            `INSERT INTO untch_approval_decisions
               (decision_id, approval_request_id, account_id, channel, channel_binding_id, actor,
                decision, approval_digest, created_by)
             VALUES ($1,$2,$3,'dashboard',NULL,'someone','APPROVE','apd_whatever','legacy-shaped-write')`,
            [newApprovalDecisionId(), r.approvalRequestId, ACCOUNT],
          );
        },
        /must name the action nonce/,
        "writing a paid request in the legacy shape must not buy the legacy exemption",
      );
    });
  },
);
