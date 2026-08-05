import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import {
  APPROVAL_ACTION_TOKEN_VERSION,
  actOnApproval,
  activeReservedExposure,
  approvalCaseProjection,
  createPool,
  finalizeSettlement,
  mintApprovalActionToken,
  newActionNonce,
  newApprovalRequestId,
  newQuoteLineageId,
  NEVER_PUBLIC_CASE_FIELDS,
  settledGovernedSpend,
  validateRequoteClaim,
  type ApprovalActionSubject,
  type AuthorizedTerms,
  type Pool,
  type RequoteCommercialIdentity,
  type ResolvedPolicy,
  type SettlementEvidence,
} from "@untch/consumer-core";

/**
 * A price that moved after somebody was asked.
 *
 * THE SHAPE OF THE PROBLEM
 *
 * An approval is raised for 6.00 and answered yes. The provider re-quotes at 6.50. Two things must now
 * be true at once, and they pull in opposite directions:
 *
 *   the 6.00 authority must not survive the 6.50 — or the lineage holds 12.50 of exposure for one
 *   piece of work, two answerable messages, and either token able to commit money;
 *
 *   the 6.00 authority must not be destroyed until the 6.50 is PAID FOR — or a requote whose fee never
 *   settles has taken back a yes the person consciously gave and left them with nothing.
 *
 * The window between those two is the entire subject of this file. It opens when the handler commits
 * and closes when an authority confirms the fee, and everything asserted below is about what is true
 * inside it, at each edge of it, and when the process dies in the middle of it.
 *
 * WHY THIS IS A POSTGRES SUITE AND COULD NOT BE ANYTHING ELSE
 *
 * The guarantees are locks, partial unique indexes, deferred constraint triggers and one transaction.
 * An in-memory double can reproduce the happy path of all four and none of the races, and the races are
 * the reason any of it is written this way.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_requote_lineage";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_requotelineagetestaccount0";
const OTHER = "acct_requoteotheraccount0000000";
const TOKEN_SECRET = "requote-lineage-token-test-secret";
const CHAIN = "eip155:196";
const PROVIDER = "untch";
const CAPABILITY = "owned_work.demo";
const ASSET = "USDT0";
const RECIPIENT = "0xrecipient";
const TASK_HASH = "0xtask";
const ACCEPTANCE_HASH = "0xacceptance";

const POLICY_20: ResolvedPolicy = { status: "ACTIVE", expiresAtMs: null, dailyLimit: "20.00" };

/**
 * Opaque per-account references, DERIVED rather than built by interpolating the account id.
 *
 * The last assertion in this file is that no projection contains the raw account id anywhere. A fixture
 * that wrote `req_acct_…` into the requester ref would fail that assertion for a reason that has nothing
 * to do with the projection — and, worse, a fixture that used the account id in a field the projection
 * legitimately publishes would make the assertion pass or fail on the shape of the test data rather than
 * on the behaviour being checked.
 */
const refsFor = (accountId: string): {
  requesterPrincipalRef: string;
  walletAuthorityRef: string;
  accountRefHash: string;
} => {
  const tag = accountId === ACCOUNT ? "aa" : "bb";
  return {
    requesterPrincipalRef: `0xrequester${tag}`,
    walletAuthorityRef: `0xwalletauthority${tag}`,
    accountRefHash: `0xaccountref${tag}`,
  };
};

describe("a requote replaces an authority, and only once it has been paid for", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
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
    const u = new URL(TEST_DB!);
    u.pathname = `/${OWN_DATABASE}`;
    pool = createPool(u.toString());
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, f), "utf8"));
    }
    for (const id of [ACCOUNT, OTHER]) {
      await pool.query(
        `INSERT INTO untch_accounts (account_id, status, created_at, created_by, updated_at, updated_by)
         VALUES ($1,'ACTIVE', now(),'t', now(),'t') ON CONFLICT DO NOTHING`,
        [id],
      );
      /**
       * `policy-authority`, not merely `identity`.
       *
       * `actOnApproval` re-reads the live wallet binding at ACTION time rather than trusting the session
       * that got the person to the button, so a fixture with no active binding gets
       * WALLET_AUTHORITY_INACTIVE — which is the correct refusal and would make every test below assert
       * against the wrong thing.
       */
      await pool.query(
        `INSERT INTO untch_wallet_bindings (binding_id, account_id, chain_kind, address, proof_kind, role, status,
           verified_at, scopes, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,'evm',$3,'siwe','primary','ACTIVE', now(), ARRAY['identity','policy-authority'],
                 now(),'t', now(),'t') ON CONFLICT DO NOTHING`,
        [`wbnd_${id.slice(-8)}`, id, `0x${id.replace(/[^a-f0-9]/g, "0").slice(-40).padStart(40, "0")}`],
      );
    }
  });

  after(async () => {
    await pool?.end();
  });

  const binding = async (account = ACCOUNT): Promise<string> => {
    seq += 1;
    const id = `cbnd_rq_${seq}`;
    await pool.query(
      `INSERT INTO untch_channel_bindings
         (binding_id, account_id, channel, channel_user_id, channel_chat_id, can_decide, status,
          verified_at, scopes, verification_method, created_at, created_by, updated_at, updated_by)
       VALUES ($1,$2,'discord',$3,$3,true,'ACTIVE', now(), ARRAY['notify','policy-approval'],
               'link_code_callback', now(),'t', now(),'t')`,
      [id, account, `discord-user-${seq}`],
    );
    return id;
  };

  interface Quote {
    readonly id: string;
    readonly serviceCallId: string;
    readonly attemptId: string;
    readonly nonce: string;
    readonly policyId: string;
    readonly lineage: string;
    readonly quoteDigest: string;
    readonly amount: string;
    readonly subject: ApprovalActionSubject;
  }

  /**
   * Raise a request exactly as the handler leaves it: PROVISIONAL, with a service call and a payment
   * attempt, and nothing actionable anywhere.
   *
   * Every quote gets its OWN policy id unless one is passed in. Sharing a policy made a later test
   * inherit an earlier test's reservations, so a budget refusal turned up in a test about lineage.
   */
  const raise = async (args: {
    readonly amount: string;
    readonly lineage?: string;
    readonly policyId?: string;
    readonly account?: string;
    readonly supersedes?: { readonly requestId: string; readonly reservationId: string | null; readonly previousQuoteDigest: string };
    readonly provider?: string;
    readonly recipient?: string;
    readonly taskHash?: string;
  }): Promise<Quote> => {
    seq += 1;
    const account = args.account ?? ACCOUNT;
    const policyId = args.policyId ?? `99${String(1000 + seq)}`;
    const serviceCallId = `svc_rq_${seq}`;
    const attemptId = `pay_rq_${seq}`;
    const nonce = `0xnonce-rq-${seq}`;
    const lineage = args.lineage ?? newQuoteLineageId();
    const quoteDigest = `qd_rq_${seq}`;
    const id = newApprovalRequestId();

    await pool.query(
      `INSERT INTO untch_x402_service_calls (service_call_id, account_id, route, idempotency_key, request_fingerprint, state)
       VALUES ($1,$2,'/preflight_payment',$3,$4,'EVALUATED')`,
      [serviceCallId, account, `k-rq-${seq}`, `fp-rq-${seq}`],
    );
    await pool.query(
      `INSERT INTO untch_x402_payment_attempts (attempt_id, service_call_id, authorization_nonce, authorization_digest,
         payer, token, amount, pay_to, chain, state)
       VALUES ($1,$2,$3,'adg','0xpayer','0xtok','50000','0xto',$4,'VERIFIED')`,
      [attemptId, serviceCallId, nonce, CHAIN],
    );
    await pool.query(
      `UPDATE untch_x402_service_calls SET state='PAYMENT_AUTH_VERIFIED' WHERE service_call_id=$1`,
      [serviceCallId],
    );

    const subject: ApprovalActionSubject = {
      approvalRequestId: id,
      approvalDigest: `apd_rq_${seq}`,
      intentHash: `0xih_rq_${seq}`,
      quoteDigest,
      policyId,
      policyHash: `0xph_rq_${seq}`,
      amount: args.amount,
      asset: ASSET,
      chain: CHAIN,
      recipient: args.recipient ?? RECIPIENT,
      provider: args.provider ?? PROVIDER,
      capability: CAPABILITY,
      requesterPrincipalRef: refsFor(account).requesterPrincipalRef,
      walletAuthorityRef: refsFor(account).walletAuthorityRef,
      accountRefHash: refsFor(account).accountRefHash,
    };

    await pool.query(
      `INSERT INTO untch_approval_requests
        (approval_request_id, account_id, policy_id, policy_version, intent_id, quote_hash, provider, capability,
         amount, asset, reason, approval_digest, nonce, state, expires_at, created_by, updated_by,
         service_call_id, decision_id, intent_hash, quote_digest, policy_hash, chain, recipient,
         requester_principal_kind, requester_principal_ref, wallet_authority_ref, account_ref_hash,
         quote_lineage_id, quote_version, task_hash, acceptance_hash,
         supersedes_approval_request_id, supersedes_reservation_id, previous_quote_digest)
       VALUES ($1,$2,$3,1,$4,'qh',$5,$6,$7,$8,'ESCALATED_THRESHOLD',$9,$10,'PROVISIONAL',
               now() + interval '1 hour','t','t',$11,$12,$13,$14,$15,$16,$17,
               'account',$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
      [
        id, account, policyId, `intent-rq-${seq}`, subject.provider, CAPABILITY,
        args.amount, ASSET, subject.approvalDigest, `n-rq-${seq}`,
        serviceCallId, `dec_rq_${seq}`, subject.intentHash, quoteDigest, subject.policyHash, CHAIN,
        subject.recipient, subject.requesterPrincipalRef, subject.walletAuthorityRef, subject.accountRefHash,
        lineage, args.supersedes ? 2 : 1, args.taskHash ?? TASK_HASH, ACCEPTANCE_HASH,
        args.supersedes?.requestId ?? null,
        args.supersedes?.reservationId ?? null,
        args.supersedes?.previousQuoteDigest ?? null,
      ],
    );
    return { id, serviceCallId, attemptId, nonce, policyId, lineage, quoteDigest, amount: args.amount, subject };
  };

  const termsFor = (q: Quote): AuthorizedTerms => ({
    authorizationNonce: q.nonce,
    payer: "0xpayer",
    token: "0xtok",
    amount: "50000",
    payTo: "0xto",
    chain: CHAIN,
  });

  const confirmed = (q: Quote): SettlementEvidence => ({
    kind: "CONFIRMED",
    source: "facilitator_settle_status",
    transactionHash: `0xtx-${q.serviceCallId}`,
    paymentId: null,
    terms: termsFor(q),
  });

  /** One finalization, in its own transaction, exactly as the middleware hook and the reconciler run it. */
  const finalize = async (q: Quote, evidence: SettlementEvidence) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await finalizeSettlement(client, { serviceCallId: q.serviceCallId, evidence });
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  const decide = async (
    q: Quote,
    bindingId: string,
    action: "APPROVE" | "DENY" = "APPROVE",
  ) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await actOnApproval(client, {
        approvalRequestId: q.id,
        action,
        token: mintApprovalActionToken(TOKEN_SECRET, {
          v: APPROVAL_ACTION_TOKEN_VERSION,
          ...q.subject,
          channelBindingId: bindingId,
          action,
          nonce: newActionNonce(),
          issuedAt: Date.now(),
          expiresAt: Date.now() + 3_600_000,
        }),
        tokenSecret: TOKEN_SECRET,
        channelBindingId: bindingId,
        nowMs: Date.now(),
        partitionKey: `policy:${q.policyId}`,
        resolvePolicy: async () => POLICY_20,
      });
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  const stateOf = async (id: string): Promise<string> => {
    const { rows } = await pool.query<{ state: string }>(
      `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`, [id]);
    return rows[0]!.state;
  };

  const reservationOf = async (id: string): Promise<{ reservationId: string; status: string } | null> => {
    const { rows } = await pool.query<{ reservation_id: string; status: string }>(
      `SELECT reservation_id, status FROM untch_budget_reservations WHERE approval_request_id = $1`, [id]);
    return rows[0] ? { reservationId: rows[0].reservation_id, status: rows[0].status } : null;
  };

  const exposure = async (policyId: string): Promise<bigint> => {
    const c = await pool.connect();
    try {
      return await activeReservedExposure(c, policyId, Date.now());
    } finally {
      c.release();
    }
  };

  const identityFor = (q: Quote, over: Partial<RequoteCommercialIdentity> = {}): RequoteCommercialIdentity => ({
    accountId: ACCOUNT,
    requesterPrincipalRef: refsFor(ACCOUNT).requesterPrincipalRef,
    provider: PROVIDER,
    capability: CAPABILITY,
    asset: ASSET,
    chain: CHAIN,
    recipient: RECIPIENT,
    taskHash: TASK_HASH,
    acceptanceHash: ACCEPTANCE_HASH,
    policyId: q.policyId,
    newQuoteDigest: "qd_changed",
    ...over,
  });

  const validate = async (
    q: Quote,
    claimOver: Partial<{ quoteLineageId: string; previousQuoteDigest: string; supersedesApprovalRequestId: string; supersedesReservationId: string | null }> = {},
    identityOver: Partial<RequoteCommercialIdentity> = {},
  ) => {
    const rsv = await reservationOf(q.id);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const verdict = await validateRequoteClaim(
        client,
        {
          quoteLineageId: q.lineage,
          previousQuoteDigest: q.quoteDigest,
          supersedesApprovalRequestId: q.id,
          supersedesReservationId: rsv?.status === "ACTIVE" ? rsv.reservationId : null,
          ...claimOver,
        },
        identityFor(q, identityOver),
      );
      await client.query("ROLLBACK");
      return verdict;
    } finally {
      client.release();
    }
  };

  /** A 6.00 raised, paid for, activated and answered yes. The state every requote test starts from. */
  const approvedSixHundred = async (): Promise<{ quote: Quote; bindingId: string; reservationId: string }> => {
    const bindingId = await binding();
    const first = await raise({ amount: "6.00" });
    const activated = await finalize(first, confirmed(first));
    assert.equal(activated.outcome, "ACTIVATED");
    assert.equal(await stateOf(first.id), "PENDING");
    const decision = await decide(first, bindingId);
    assert.equal(decision.outcome, "APPROVED");
    const rsv = await reservationOf(first.id);
    assert.equal(rsv?.status, "ACTIVE", "an APPROVE creates exactly one ACTIVE reservation");
    return { quote: first, bindingId, reservationId: rsv!.reservationId };
  };

  // ───────────────────────────────────────────────────────────────────────────
  // The baseline the whole file is measured against
  // ───────────────────────────────────────────────────────────────────────────

  test("a first quote approved holds its amount as authority, and spends nothing", async () => {
    const { quote } = await approvedSixHundred();
    assert.equal(await exposure(quote.policyId), 6_000_000n, "6.00 of authority is live");
    const c = await pool.connect();
    try {
      assert.equal(
        await settledGovernedSpend(c, quote.policyId, Date.now()),
        0n,
        "and none of it is spend — nothing executed, nothing settled, nothing was delivered",
      );
    } finally {
      c.release();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The window: raised, unpaid, and the predecessor untouched
  // ───────────────────────────────────────────────────────────────────────────

  test("a provisional requote does not touch the authority it names", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    const second = await raise({
      amount: "6.50",
      lineage: first.lineage,
      policyId: first.policyId,
      supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
    });

    assert.equal(await stateOf(second.id), "PROVISIONAL");
    assert.equal(await stateOf(first.id), "APPROVED", "the answered 6.00 is exactly where the person left it");
    assert.equal((await reservationOf(first.id))?.status, "ACTIVE");
    assert.equal(await exposure(first.policyId), 6_000_000n, "and still holds its 6.00");

    const { rows: outbox } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_outbox WHERE approval_request_id = $1`, [second.id]);
    assert.equal(Number(outbox[0]!.n), 0, "a provisional successor asks nobody anything");
    const { rows: rsv } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_budget_reservations WHERE approval_request_id = $1`, [second.id]);
    assert.equal(Number(rsv[0]!.n), 0, "and reserves nothing");
  });

  test("a pending settlement does not supersede", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    const second = await raise({
      amount: "6.50", lineage: first.lineage, policyId: first.policyId,
      supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
    });

    const result = await finalize(second, { kind: "PENDING", transactionHash: "0xmaybe", paymentId: null });
    assert.equal(result.outcome, "LEFT_UNRESOLVED");
    assert.equal(result.superseded, null, "a facilitator saying 'pending' is not an authority saying 'paid'");
    assert.equal(await stateOf(first.id), "APPROVED");
    assert.equal((await reservationOf(first.id))?.status, "ACTIVE");
    assert.equal(await stateOf(second.id), "PROVISIONAL");
  });

  test("an unknown settlement does not supersede, and initiates no second payment", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    const second = await raise({
      amount: "6.50", lineage: first.lineage, policyId: first.policyId,
      supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
    });

    const result = await finalize(second, { kind: "UNKNOWN", detail: "facilitator unreachable" });
    assert.equal(result.outcome, "LEFT_UNRESOLVED");
    assert.equal(result.superseded, null);
    assert.equal(await stateOf(first.id), "APPROVED");
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_x402_payment_attempts WHERE service_call_id = $1`, [second.serviceCallId]);
    assert.equal(Number(rows[0]!.n), 1, "an unresolved settlement is asked about again, never paid again");
  });

  test("a failed settlement leaves the granted authority exactly as it was", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    const second = await raise({
      amount: "6.50", lineage: first.lineage, policyId: first.policyId,
      supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
    });

    const result = await finalize(second, { kind: "FAILED", failureCode: "INSUFFICIENT_FUNDS", failureDetail: null });
    assert.equal(result.outcome, "PAYMENT_FAILED");
    assert.equal(result.superseded, null);
    assert.equal(await stateOf(second.id), "PAYMENT_FAILED");
    assert.equal(await stateOf(first.id), "APPROVED", "a failed payment must not revoke authority already granted");
    assert.equal((await reservationOf(first.id))?.status, "ACTIVE");
    assert.equal(await exposure(first.policyId), 6_000_000n);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_outbox WHERE approval_request_id = $1`, [second.id]);
    assert.equal(Number(rows[0]!.n), 0, "and nobody is asked about a request nobody paid for");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The edge: confirmation, and one atomic exchange of authority
  // ───────────────────────────────────────────────────────────────────────────

  test("a confirmed settlement retires the predecessor and activates the successor in one transaction", async () => {
    const { quote: first, bindingId, reservationId } = await approvedSixHundred();
    const second = await raise({
      amount: "6.50", lineage: first.lineage, policyId: first.policyId,
      supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
    });

    const result = await finalize(second, confirmed(second));
    assert.equal(result.outcome, "ACTIVATED");
    assert.equal(result.superseded?.approvalRequestId, first.id);
    assert.equal(result.superseded?.priorState, "APPROVED");
    assert.equal(result.superseded?.reservationId, reservationId);
    assert.equal(result.superseded?.releasedExposure, "6.00");

    assert.equal(await stateOf(first.id), "SUPERSEDED");
    assert.equal((await reservationOf(first.id))?.status, "SUPERSEDED");
    assert.equal(await stateOf(second.id), "PENDING");
    assert.equal(
      await exposure(first.policyId),
      0n,
      "the 6.00 stops counting the moment it is retired — the successor reserves nothing until it is answered",
    );

    const { rows: events } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_outbox WHERE approval_request_id = $1 AND name = 'approval.request.ready.v1'`,
      [second.id],
    );
    assert.equal(Number(events[0]!.n), 1, "exactly one message is queued, and it is for the new price");

    const { rows: links } = await pool.query<{ superseded_by_approval_request_id: string | null }>(
      `SELECT superseded_by_approval_request_id FROM untch_approval_requests WHERE approval_request_id = $1`,
      [first.id],
    );
    assert.equal(links[0]!.superseded_by_approval_request_id, second.id, "the timeline walks from either end");

    /** The old button is dead. Not "returns nothing" — refuses, by name. */
    const stale = await decide(first, bindingId);
    assert.equal(stale.outcome, "APPROVAL_SUPERSEDED");
    assert.equal(
      (await reservationOf(first.id))?.status,
      "SUPERSEDED",
      "and pressing it created no second authority",
    );
  });

  test("the old action references stop resolving", async () => {
    const { quote: first, bindingId, reservationId } = await approvedSixHundred();
    await pool.query(
      `INSERT INTO untch_approval_action_refs
         (action_reference_id, approval_request_id, account_id, channel_binding_id, approval_digest,
          account_ref_hash, action, nonce, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'APPROVE',$7, now() + interval '1 hour')`,
      [`aref_old_${first.id}`, first.id, ACCOUNT, bindingId, first.subject.approvalDigest, `arh_${ACCOUNT}`, `nx_${first.id}`],
    );
    const second = await raise({
      amount: "6.50", lineage: first.lineage, policyId: first.policyId,
      supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
    });
    const result = await finalize(second, confirmed(second));
    assert.equal(result.superseded?.invalidatedActionRefs, 1);
    const { rows } = await pool.query<{ invalidated_at: Date | null; invalidation_reason: string | null }>(
      `SELECT invalidated_at, invalidation_reason FROM untch_approval_action_refs WHERE approval_request_id = $1`,
      [first.id],
    );
    assert.ok(rows[0]!.invalidated_at !== null, "a URL somebody is already holding must stop working");
    assert.equal(rows[0]!.invalidation_reason, "QUOTE_SUPERSEDED", "and say why, rather than reading as a broken link");
  });

  test("finalizing the same requote twice supersedes once and charges nothing twice", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    const second = await raise({
      amount: "6.50", lineage: first.lineage, policyId: first.policyId,
      supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
    });

    const once = await finalize(second, confirmed(second));
    const twice = await finalize(second, confirmed(second));

    assert.equal(once.outcome, "ACTIVATED");
    assert.equal(twice.outcome, "ALREADY_ACTIVE");
    assert.equal(twice.superseded?.approvalRequestId, first.id, "the repeat reports what happened and repeats none of it");
    assert.equal(twice.superseded?.priorState, "SUPERSEDED");
    assert.equal(once.outboxEventId, twice.outboxEventId, "one event, whichever caller asks");

    const { rows: events } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_outbox WHERE approval_request_id = $1`, [second.id]);
    assert.equal(Number(events[0]!.n), 1);
    const { rows: attempts } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_x402_payment_attempts WHERE service_call_id = $1`, [second.serviceCallId]);
    assert.equal(Number(attempts[0]!.n), 1, "no second attempt, so no second fee");
  });

  test("a rollback before commit leaves the predecessor untouched", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    const second = await raise({
      amount: "6.50", lineage: first.lineage, policyId: first.policyId,
      supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await finalizeSettlement(client, { serviceCallId: second.serviceCallId, evidence: confirmed(second) });
      assert.equal(result.outcome, "ACTIVATED", "it did all of the work…");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    assert.equal(await stateOf(first.id), "APPROVED", "…and the rollback took all of it back");
    assert.equal((await reservationOf(first.id))?.status, "ACTIVE");
    assert.equal(await stateOf(second.id), "PROVISIONAL");
    assert.equal(await exposure(first.policyId), 6_000_000n);
  });

  test("the reconciler completes a supersession the finalizer never got to", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    const second = await raise({
      amount: "6.50", lineage: first.lineage, policyId: first.policyId,
      supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
    });

    /**
     * The process dies after the facilitator confirmed and before anything was written. All that
     * survives is the committed service call and its attempt — which is exactly what the reconciler
     * reads, and the reason the response hook is an optimisation rather than a correctness boundary.
     */
    const recovered = await finalize(second, confirmed(second));
    assert.equal(recovered.outcome, "ACTIVATED");
    assert.equal(recovered.superseded?.approvalRequestId, first.id);
    assert.equal(await stateOf(first.id), "SUPERSEDED");
    assert.equal(await stateOf(second.id), "PENDING");
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_outbox WHERE approval_request_id = $1`, [second.id]);
    assert.equal(Number(rows[0]!.n), 1, "exactly one new event exists, however many passes reached it");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The claim, and every way of getting it wrong
  // ───────────────────────────────────────────────────────────────────────────

  test("a valid claim is accepted, and names the position it will occupy", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    const verdict = await validate(first);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok === true && verdict.quoteVersion, 2);
    assert.equal(verdict.ok === true && verdict.priorReservationId, reservationId);
    assert.equal(verdict.ok === true && verdict.priorAmount, "6.00");
    assert.equal(verdict.ok === true && verdict.priorState, "APPROVED");
  });

  test("a request that does not exist is refused before anything else is checked", async () => {
    const { quote: first } = await approvedSixHundred();
    const verdict = await validate(first, { supersedesApprovalRequestId: newApprovalRequestId() });
    assert.equal(verdict.ok === false && verdict.refusal, "REQUOTE_LINEAGE_NOT_FOUND");
  });

  test("another account cannot aim a requote at a request it does not own", async () => {
    const { quote: first } = await approvedSixHundred();
    const verdict = await validate(first, {}, { accountId: OTHER });
    assert.equal(verdict.ok === false && verdict.refusal, "REQUOTE_ACCOUNT_MISMATCH");
    assert.equal(await stateOf(first.id), "APPROVED", "and nothing about the target changed");
  });

  test("an unrelated request cannot claim a lineage it is not in", async () => {
    const { quote: first } = await approvedSixHundred();
    const verdict = await validate(first, { quoteLineageId: newQuoteLineageId() });
    assert.equal(verdict.ok === false && verdict.refusal, "REQUOTE_PRIOR_REQUEST_MISMATCH");
  });

  test("a stale view of the lineage is refused rather than acted on", async () => {
    const { quote: first } = await approvedSixHundred();
    const verdict = await validate(first, { previousQuoteDigest: "qd_something_older" });
    assert.equal(verdict.ok === false && verdict.refusal, "REQUOTE_PREVIOUS_QUOTE_MISMATCH");
  });

  test("an unchanged quote is not a requote", async () => {
    const { quote: first } = await approvedSixHundred();
    const verdict = await validate(first, {}, { newQuoteDigest: first.quoteDigest });
    assert.equal(verdict.ok === false && verdict.refusal, "REQUOTE_QUOTE_UNCHANGED");
  });

  test("naming the wrong reservation is refused, and so is naming none", async () => {
    const { quote: first } = await approvedSixHundred();
    assert.equal(
      (await validate(first, { supersedesReservationId: "rsv_not_this_one" })).ok === false &&
        (await validate(first, { supersedesReservationId: "rsv_not_this_one" })).refusal,
      "REQUOTE_RESERVATION_MISMATCH",
    );
    const none = await validate(first, { supersedesReservationId: null });
    assert.equal(none.ok === false && none.refusal, "REQUOTE_RESERVATION_MISMATCH");
  });

  test("a reservation that is no longer live is named as such, not as 'not found'", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    await pool.query(
      `UPDATE untch_budget_reservations SET status = 'RELEASED', released_at = now(), release_reason = 'EXPIRED'
        WHERE reservation_id = $1`,
      [reservationId],
    );
    const verdict = await validate(first, { supersedesReservationId: reservationId });
    assert.equal(verdict.ok === false && verdict.refusal, "REQUOTE_RESERVATION_ALREADY_CONSUMED");
  });

  test("a requote may change the price and nothing else", async () => {
    const { quote: first } = await approvedSixHundred();
    const cases: [Partial<RequoteCommercialIdentity>, string][] = [
      [{ provider: "someone-else" }, "REQUOTE_PROVIDER_MISMATCH"],
      [{ capability: "owned_work.other" }, "REQUOTE_CAPABILITY_MISMATCH"],
      [{ asset: "USDC" }, "REQUOTE_ASSET_MISMATCH"],
      [{ chain: "eip155:1" }, "REQUOTE_CHAIN_MISMATCH"],
      [{ recipient: "0xsomebodyelse" }, "REQUOTE_RECIPIENT_MISMATCH"],
      [{ taskHash: "0xdifferentwork" }, "REQUOTE_TASK_MISMATCH"],
      [{ acceptanceHash: "0xdifferentterms" }, "REQUOTE_ACCEPTANCE_MISMATCH"],
      [{ policyId: "990000" }, "REQUOTE_POLICY_MISMATCH"],
      [{ requesterPrincipalRef: refsFor(OTHER).requesterPrincipalRef }, "REQUOTE_REQUESTER_MISMATCH"],
    ];
    for (const [over, expected] of cases) {
      const verdict = await validate(first, {}, over);
      assert.equal(verdict.ok === false && verdict.refusal, expected, `changing ${Object.keys(over)[0]} must be refused`);
    }
  });

  test("a request that has already been replaced cannot be replaced again", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    const second = await raise({
      amount: "6.50", lineage: first.lineage, policyId: first.policyId,
      supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
    });
    await finalize(second, confirmed(second));

    const verdict = await validate(first);
    assert.equal(verdict.ok === false && verdict.refusal, "REQUOTE_PRIOR_ALREADY_SUPERSEDED");
  });

  test("a resolved request holds no authority to retire", async () => {
    const bindingId = await binding();
    const first = await raise({ amount: "6.00" });
    await finalize(first, confirmed(first));
    const denied = await decide(first, bindingId, "DENY");
    assert.equal(denied.outcome, "DENIED");

    const verdict = await validate(first);
    assert.equal(verdict.ok === false && verdict.refusal, "REQUOTE_PRIOR_NOT_SUPERSEDABLE");
  });

  test("only one successor may be in flight in a lineage", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    await raise({
      amount: "6.50", lineage: first.lineage, policyId: first.policyId,
      supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
    });

    /** The named refusal, for a caller that arrives second and in order. */
    const verdict = await validate(first);
    assert.equal(verdict.ok === false && verdict.refusal, "REQUOTE_SUCCESSOR_ALREADY_EXISTS");

    /** And the database's own answer, for two that arrive at once. */
    await assert.rejects(
      () =>
        raise({
          amount: "6.75", lineage: first.lineage, policyId: first.policyId,
          supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
        }),
      /untch_approval_one_provisional_per_lineage/,
    );
  });

  test("two concurrent requotes on one lineage produce exactly one successor", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    const attempt = async (amount: string): Promise<string | null> => {
      try {
        const q = await raise({
          amount, lineage: first.lineage, policyId: first.policyId,
          supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
        });
        return q.id;
      } catch {
        return null;
      }
    };
    const [a, b] = await Promise.all([attempt("6.50"), attempt("6.75")]);
    const winners = [a, b].filter((x) => x !== null);
    assert.equal(winners.length, 1, "one of them wins the partial unique index and the other is refused");

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_requests WHERE quote_lineage_id = $1 AND state = 'PROVISIONAL'`,
      [first.lineage],
    );
    assert.equal(Number(rows[0]!.n), 1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // What a reader is allowed to see
  // ───────────────────────────────────────────────────────────────────────────

  test("the case projection links both quotes, and leaks neither party", async () => {
    const { quote: first, reservationId } = await approvedSixHundred();
    const second = await raise({
      amount: "6.50", lineage: first.lineage, policyId: first.policyId,
      supersedes: { requestId: first.id, reservationId, previousQuoteDigest: first.quoteDigest },
    });
    await finalize(second, confirmed(second));

    const older = await approvalCaseProjection(pool, first.id, Date.now());
    const newer = await approvalCaseProjection(pool, second.id, Date.now());
    assert.ok(older && newer);

    assert.equal(older!.lineage.supersededByApprovalRequestId, second.id);
    assert.equal(older!.lineage.quoteVersion, 1);
    assert.equal(newer!.lineage.supersedesApprovalRequestId, first.id);
    assert.equal(newer!.lineage.quoteVersion, 2);
    assert.equal(newer!.lineage.previousQuoteDigest, first.quoteDigest);
    assert.equal(newer!.lineage.quoteLineageId, older!.lineage.quoteLineageId);

    for (const projection of [older, newer]) {
      const serialised = JSON.stringify(projection);
      for (const forbidden of NEVER_PUBLIC_CASE_FIELDS) {
        assert.equal(serialised.includes(`"${forbidden}"`), false, `${forbidden} must never reach a public case`);
      }
      assert.equal(serialised.includes(ACCOUNT), false, "and neither may the raw account id");
    }
  });
});
