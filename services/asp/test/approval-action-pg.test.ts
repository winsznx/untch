import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import {
  APPROVAL_ACTION_TOKEN_VERSION,
  actOnApproval,
  activeReservedExposure,
  createPool,
  deliverOnce,
  mintApprovalActionToken,
  newActionNonce,
  NEVER_PUBLIC_CASE_FIELDS,
  approvalCaseProjection,
  newApprovalRequestId,
  newQuoteLineageId,
  projectDeliveries,
  supersedePriorQuote,
  settledGovernedSpend,
  verifyApprovalActionToken,
  type ApprovalActionClaims,
  type ApprovalActionSubject,
  type ChannelGateway,
  type Pool,
  type ResolvedPolicy,
  type SendOutcome,
} from "@untch/consumer-core";

/**
 * The human half of the approval path, against a real database.
 *
 * A PENDING request reserves nothing, so everything here turns on what is true at ACTION time rather
 * than at request time. The tests that matter most are the ones where the world moved in between: the
 * budget filled up, the binding was revoked, the quote was re-quoted, or two channels answered at once.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_approval_action";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_approvalactiontestacct01ab";
const OTHER = "acct_approvalactionotheracct1ab";
const TOKEN_SECRET = "approval-action-token-test-secret";
const POLICY_ID = "778001";
const CHAIN = "eip155:196";

const POLICY_10: ResolvedPolicy = { status: "ACTIVE", expiresAtMs: null, dailyLimit: "10.00" };

describe("a human answer becomes authority, or is refused", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
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

  const binding = async (
    channel: string,
    opts: { account?: string; canDecide?: boolean; scopes?: string[]; status?: string } = {},
  ): Promise<string> => {
    seq += 1;
    const id = `cbnd_${channel}_${seq}`;
    await pool.query(
      `INSERT INTO untch_channel_bindings
         (binding_id, account_id, channel, channel_user_id, channel_chat_id, can_decide, status,
          verified_at, scopes, verification_method, created_at, created_by, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$4,$5,$6, now(), $7,'link_code_callback', now(),'t', now(),'t')`,
      [
        id,
        opts.account ?? ACCOUNT,
        channel,
        `${channel}-user-${seq}`,
        opts.canDecide ?? true,
        opts.status ?? "ACTIVE",
        opts.scopes ?? ["notify", "policy-approval"],
      ],
    );
    return id;
  };

  /** A PENDING request whose fee is settled and finalized, as the finalizer would leave it. */
  /**
   * Each request gets its OWN policy id. Sharing one made every later test inherit the reservations
   * earlier tests created, so a budget refusal appeared in a test about something else entirely.
   */
  const pending = async (amount = "6.00", lineage: string | null = null): Promise<{ id: string; subject: ApprovalActionSubject; policyId: string }> => {
    seq += 1;
    const policyId = `77${String(8000 + seq)}`;
    const serviceCallId = `svc_action_${seq}`;
    const attemptId = `pay_action_${seq}`;
    await pool.query(
      /**
       * EVALUATED first, then the attempt, then FINALIZED. The insert trigger refuses a payment
       * attempt on an already-settled call, which is the guard that stops a second charge, so the
       * fixture has to build the row in the order production does rather than jumping to the end.
       */
      `INSERT INTO untch_x402_service_calls (service_call_id, account_id, route, idempotency_key, request_fingerprint, state)
       VALUES ($1,$2,'/preflight_payment',$3,$4,'EVALUATED')`,
      [serviceCallId, ACCOUNT, `k-${seq}`, `fp-${seq}`],
    );
    await pool.query(
      `INSERT INTO untch_x402_payment_attempts (attempt_id, service_call_id, authorization_nonce, authorization_digest,
         payer, token, amount, pay_to, chain, state, transaction_hash, settled_at)
       VALUES ($1,$2,$3,'adg','0xpayer','0xtok','50000','0xto',$4,'SETTLED',$5, now())`,
      [attemptId, serviceCallId, `0xnonce-${seq}`, CHAIN, `0xtx-${seq}`],
    );
    await pool.query(
      `UPDATE untch_x402_service_calls SET state='FINALIZED', settled_at=now(), finalized_at=now() WHERE service_call_id=$1`,
      [serviceCallId],
    );
    const id = newApprovalRequestId();
    const subject: ApprovalActionSubject = {
      approvalRequestId: id,
      approvalDigest: `apd_${seq}`,
      intentHash: `0xih${seq}`,
      quoteDigest: `qd_${seq}`,
      policyId,
      policyHash: `0xph${seq}`,
      amount,
      asset: "USDT0",
      chain: CHAIN,
      recipient: "0xrecipient",
      provider: "untch",
      capability: "owned_work.demo",
      requesterPrincipalRef: `req_${seq}`,
      walletAuthorityRef: `wa_${seq}`,
      accountRefHash: `arh_${seq}`,
    };
    await pool.query(
      `INSERT INTO untch_approval_requests
        (approval_request_id, account_id, policy_id, policy_version, intent_id, quote_hash, provider, capability,
         amount, asset, reason, approval_digest, nonce, state, expires_at, created_by, updated_by,
         service_call_id, settled_attempt_id, activated_at, decision_id, intent_hash, quote_digest, policy_hash,
         chain, recipient, requester_principal_ref, wallet_authority_ref, account_ref_hash, quote_lineage_id)
       VALUES ($1,$2,$3,1,$4,'qh','untch','owned_work.demo',$5,'USDT0','threshold',$6,$7,'PENDING',
               now() + interval '1 hour','t','t',$8,$9, now(),$10,$11,$12,$13,$14,'0xrecipient',$15,$16,$17,$18)`,
      [
        id, ACCOUNT, policyId, `intent-${seq}`, amount, subject.approvalDigest, `n${seq}`,
        serviceCallId, attemptId, `dec_${seq}`, subject.intentHash, subject.quoteDigest, subject.policyHash,
        CHAIN, subject.requesterPrincipalRef, subject.walletAuthorityRef, subject.accountRefHash, lineage,
      ],
    );
    return { id, subject, policyId };
  };

  const claims = (
    subject: ApprovalActionSubject,
    bindingId: string,
    over: Partial<ApprovalActionClaims> = {},
  ): ApprovalActionClaims => ({
    v: APPROVAL_ACTION_TOKEN_VERSION,
    approvalRequestId: subject.approvalRequestId,
    approvalDigest: subject.approvalDigest,
    intentHash: subject.intentHash,
    quoteDigest: subject.quoteDigest,
    policyId: subject.policyId,
    policyHash: subject.policyHash,
    amount: subject.amount,
    asset: subject.asset,
    chain: subject.chain,
    recipient: subject.recipient,
    provider: subject.provider,
    capability: subject.capability,
    requesterPrincipalRef: subject.requesterPrincipalRef,
    walletAuthorityRef: subject.walletAuthorityRef,
    accountRefHash: subject.accountRefHash,
    channelBindingId: bindingId,
    action: "APPROVE",
    nonce: newActionNonce(),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    ...over,
  });

  const act = async (
    requestId: string,
    token: string,
    bindingId: string,
    over: { action?: "APPROVE" | "DENY"; policy?: ResolvedPolicy; policyId?: string } = {},
  ) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await actOnApproval(client, {
        approvalRequestId: requestId,
        action: over.action ?? "APPROVE",
        token,
        tokenSecret: TOKEN_SECRET,
        channelBindingId: bindingId,
        nowMs: Date.now(),
        partitionKey: `policy:${over.policyId ?? POLICY_ID}`,
        resolvePolicy: async () => over.policy ?? POLICY_10,
      });
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  // ── the token ──────────────────────────────────────────────────────────────

  test("plain text is not an approval", () => {
    const { subject } = { subject: baseSubject() };
    for (const word of ["yes", "approve", "ok", "send it", "APPROVE"]) {
      const v = verifyApprovalActionToken(TOKEN_SECRET, word, subject, {
        action: "APPROVE",
        channelBindingId: "cbnd_x",
        nowMs: Date.now(),
      });
      assert.equal(v.ok, false, `"${word}" must never approve anything`);
    }
  });

  function baseSubject(): ApprovalActionSubject {
    return {
      approvalRequestId: "aprq_x", approvalDigest: "apd_x", intentHash: "0xih", quoteDigest: "qd",
      policyId: POLICY_ID, policyHash: "0xph", amount: "6.00", asset: "USDT0", chain: CHAIN,
      recipient: "0xrecipient", provider: "untch", capability: "owned_work.demo",
      requesterPrincipalRef: "req", walletAuthorityRef: "wa", accountRefHash: "arh",
    };
  }

  for (const [field, mutated, expected] of [
    ["amount", { amount: "6.50" }, "AMOUNT_MISMATCH"],
    ["asset", { asset: "USDC" }, "ASSET_MISMATCH"],
    ["recipient", { recipient: "0xsomebodyelse" }, "RECIPIENT_MISMATCH"],
    ["quoteDigest", { quoteDigest: "qd2" }, "QUOTE_MISMATCH"],
    ["policyId", { policyId: "999" }, "POLICY_MISMATCH"],
    ["requesterPrincipalRef", { requesterPrincipalRef: "req2" }, "REQUESTER_MISMATCH"],
    ["walletAuthorityRef", { walletAuthorityRef: "wa2" }, "WALLET_AUTHORITY_MISMATCH"],
    ["accountRefHash", { accountRefHash: "arh2" }, "ACTOR_MISMATCH"],
    ["approvalDigest", { approvalDigest: "apd_y" }, "DIGEST_MISMATCH"],
  ] as const) {
    test(`a token whose ${field} no longer matches the request is refused`, () => {
      const subject = baseSubject();
      const token = mintApprovalActionToken(TOKEN_SECRET, {
        ...claims(subject, "cbnd_x"),
      });
      const v = verifyApprovalActionToken(TOKEN_SECRET, token, { ...subject, ...mutated }, {
        action: "APPROVE",
        channelBindingId: "cbnd_x",
        nowMs: Date.now(),
      });
      assert.equal(v.ok, false);
      assert.equal(v.ok === false && v.refusal, expected);
    });
  }

  test("a token minted for another channel binding is refused", () => {
    const subject = baseSubject();
    const token = mintApprovalActionToken(TOKEN_SECRET, claims(subject, "cbnd_telegram"));
    const v = verifyApprovalActionToken(TOKEN_SECRET, token, subject, {
      action: "APPROVE", channelBindingId: "cbnd_discord", nowMs: Date.now(),
    });
    assert.equal(v.ok === false && v.refusal, "WRONG_BINDING");
  });

  test("an expired token is refused, and a DENY token cannot approve", () => {
    const subject = baseSubject();
    const stale = mintApprovalActionToken(TOKEN_SECRET, claims(subject, "cbnd_x", { expiresAt: Date.now() - 1 }));
    assert.equal(
      verifyApprovalActionToken(TOKEN_SECRET, stale, subject, { action: "APPROVE", channelBindingId: "cbnd_x", nowMs: Date.now() }).ok === false &&
        verifyApprovalActionToken(TOKEN_SECRET, stale, subject, { action: "APPROVE", channelBindingId: "cbnd_x", nowMs: Date.now() }).refusal,
      "EXPIRED",
    );
    const denyToken = mintApprovalActionToken(TOKEN_SECRET, claims(subject, "cbnd_x", { action: "DENY" }));
    const v = verifyApprovalActionToken(TOKEN_SECRET, denyToken, subject, {
      action: "APPROVE", channelBindingId: "cbnd_x", nowMs: Date.now(),
    });
    assert.equal(v.ok === false && v.refusal, "WRONG_ACTION");
  });

  test("a token signed with another secret is refused", () => {
    const subject = baseSubject();
    const token = mintApprovalActionToken("some-other-secret", claims(subject, "cbnd_x"));
    const v = verifyApprovalActionToken(TOKEN_SECRET, token, subject, {
      action: "APPROVE", channelBindingId: "cbnd_x", nowMs: Date.now(),
    });
    assert.equal(v.ok === false && v.refusal, "BAD_SIGNATURE");
  });

  test("the token carries no raw accountId", () => {
    const subject = baseSubject();
    const token = mintApprovalActionToken(TOKEN_SECRET, claims(subject, "cbnd_x"));
    const decoded = Buffer.from(token.slice(0, token.lastIndexOf(".")), "base64url").toString("utf8");
    assert.ok(!decoded.includes(ACCOUNT), "a channel message must not leak which account it belongs to");
    assert.ok(decoded.includes("arh"), "it carries the account reference hash instead");
  });

  // ── the decision ───────────────────────────────────────────────────────────

  test("a valid approval creates one decision and one ACTIVE reservation", async () => {
    const b = await binding("telegram");
    const { id, subject, policyId } = await pending("6.00");
    const token = mintApprovalActionToken(TOKEN_SECRET, claims(subject, b));
    const result = await act(id, token, b, { policyId });

    assert.equal(result.outcome, "APPROVED");
    assert.ok(result.decisionId && result.reservationId);
    assert.equal(result.budget?.settledGovernedSpend, "0.00", "no money has moved");
    assert.equal(result.budget?.effectiveBudgetUsage, "6.00");

    const { rows } = await pool.query<{ status: string; amount: string }>(
      `SELECT status, amount FROM untch_budget_reservations WHERE approval_request_id = $1`,
      [id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "ACTIVE");
    const { rows: consumed } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_budget_reservations WHERE status = 'CONSUMED'`);
    assert.equal(Number(consumed[0]!.n), 0, "reserved authority is not spend: nothing is CONSUMED");
  });

  test("a second action returns ALREADY_RESOLVED and creates nothing", async () => {
    const b = await binding("telegram");
    const { id, subject, policyId } = await pending();
    await act(id, mintApprovalActionToken(TOKEN_SECRET, claims(subject, b)), b, { policyId });
    const second = await act(id, mintApprovalActionToken(TOKEN_SECRET, claims(subject, b)), b, { policyId });
    assert.equal(second.outcome, "ALREADY_RESOLVED");
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_decisions WHERE approval_request_id = $1`,
      [id],
    );
    assert.equal(Number(rows[0]!.n), 1);
  });

  test("concurrent Telegram and Discord actions produce exactly one decision", async () => {
    const tg = await binding("telegram");
    const dc = await binding("discord");
    const { id, subject, policyId } = await pending();
    const results = await Promise.all([
      act(id, mintApprovalActionToken(TOKEN_SECRET, claims(subject, tg)), tg, { policyId }),
      act(id, mintApprovalActionToken(TOKEN_SECRET, claims(subject, dc)), dc, { policyId }),
    ]);
    const approved = results.filter((r) => r.outcome === "APPROVED");
    const resolved = results.filter((r) => r.outcome === "ALREADY_RESOLVED");
    assert.equal(approved.length, 1, "exactly one channel wins");
    assert.equal(resolved.length, 1, "the other is told it is already handled");

    const { rows: d } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_decisions WHERE approval_request_id = $1`, [id]);
    const { rows: r } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_budget_reservations WHERE approval_request_id = $1`, [id]);
    assert.equal(Number(d[0]!.n), 1);
    assert.equal(Number(r[0]!.n), 1, "one approval, one authority");
  });

  test("a denial creates a decision and no reservation", async () => {
    const b = await binding("web");
    const { id, subject, policyId } = await pending();
    const token = mintApprovalActionToken(TOKEN_SECRET, claims(subject, b, { action: "DENY" }));
    const result = await act(id, token, b, { action: "DENY", policyId });
    assert.equal(result.outcome, "DENIED");
    assert.equal(result.reservationId, null);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_budget_reservations WHERE approval_request_id = $1`, [id]);
    assert.equal(Number(rows[0]!.n), 0);
  });

  test("a binding for another account cannot approve", async () => {
    const theirs = await binding("telegram", { account: OTHER });
    const { id, subject, policyId } = await pending();
    const token = mintApprovalActionToken(TOKEN_SECRET, claims(subject, theirs));
    const result = await act(id, token, theirs);
    assert.equal(result.outcome, "BINDING_WRONG_ACCOUNT");
  });

  test("a revoked binding cannot approve", async () => {
    const b = await binding("telegram", { status: "REVOKED" });
    const { id, subject, policyId } = await pending();
    const result = await act(id, mintApprovalActionToken(TOKEN_SECRET, claims(subject, b)), b, { policyId });
    assert.equal(result.outcome, "BINDING_NOT_ACTIVE");
  });

  test("a notify-only binding cannot approve", async () => {
    const b = await binding("email", { canDecide: false, scopes: ["notify"] });
    const { id, subject, policyId } = await pending();
    const result = await act(id, mintApprovalActionToken(TOKEN_SECRET, claims(subject, b)), b, { policyId });
    assert.equal(result.outcome, "BINDING_CANNOT_DECIDE");
  });

  test("an inactive policy cannot be approved against", async () => {
    const b = await binding("telegram");
    const { id, subject, policyId } = await pending();
    const result = await act(id, mintApprovalActionToken(TOKEN_SECRET, claims(subject, b)), b, {
      policy: { status: "PAUSED", expiresAtMs: null, dailyLimit: "10.00" }, policyId,
    });
    assert.equal(result.outcome, "POLICY_INACTIVE");
  });

  // ── the recheck ────────────────────────────────────────────────────────────

  test("a budget that filled up between asking and answering refuses", async () => {
    const b = await binding("telegram");
    const { id, subject, policyId } = await pending("6.00");
    /** Another approval consumed the headroom while this one waited. */
    const result = await act(id, mintApprovalActionToken(TOKEN_SECRET, claims(subject, b)), b, {
      policy: { status: "ACTIVE", expiresAtMs: null, dailyLimit: "4.00" }, policyId,
    });
    assert.equal(result.outcome, "BUDGET_CHANGED_BEFORE_APPROVAL");
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_budget_reservations WHERE approval_request_id = $1`, [id]);
    assert.equal(Number(rows[0]!.n), 0, "no authority was created");
    const { rows: d } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_decisions WHERE approval_request_id = $1 AND decision = 'APPROVE'`, [id]);
    assert.equal(Number(d[0]!.n), 0, "and no APPROVED decision was recorded");
  });

  test("a pending request reserves nothing before anyone answers", async () => {
    const { id, policyId } = await pending("6.00");
    const client = await pool.connect();
    try {
      const exposure = await activeReservedExposure(client, policyId, Date.now());
      const spend = await settledGovernedSpend(client, policyId);
      assert.equal(spend, 0n, "nothing has settled");
      assert.ok(exposure >= 0n);
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text n FROM untch_budget_reservations WHERE approval_request_id = $1`, [id]);
      assert.equal(Number(rows[0]!.n), 0);
    } finally {
      client.release();
    }
  });

  // ── delivery ───────────────────────────────────────────────────────────────

  test("deliveries are projected only for active approval-scoped bindings", async () => {
    const decider = await binding("telegram");
    const notifyOnly = await binding("email", { canDecide: false, scopes: ["notify"] });
    const revoked = await binding("discord", { status: "REVOKED" });
    const { id, policyId } = await pending();
    await pool.query(
      `INSERT INTO untch_approval_outbox (event_id, approval_request_id, name) VALUES ($1,$2,'approval.request.ready.v1')`,
      [`aoev_${id}`, id],
    );
    await projectDeliveries(pool, { limit: 10 });
    const { rows } = await pool.query<{ channel_binding_id: string }>(
      `SELECT channel_binding_id FROM untch_approval_deliveries WHERE approval_request_id = $1`, [id]);
    const targets = rows.map((r) => r.channel_binding_id);
    assert.ok(targets.includes(decider));
    assert.ok(!targets.includes(notifyOnly), "notify-only holds no policy-approval scope");
    assert.ok(!targets.includes(revoked), "a revoked binding receives nothing");
  });

  test("two workers do not send the same message twice", async () => {
    const b = await binding("telegram");
    const { id, policyId } = await pending();
    await pool.query(
      `INSERT INTO untch_approval_outbox (event_id, approval_request_id, name) VALUES ($1,$2,'approval.request.ready.v1')`,
      [`aoev2_${id}`, id],
    );
    await projectDeliveries(pool, { limit: 10 });

    const sends: string[] = [];
    const gateway: ChannelGateway = {
      async send(t): Promise<SendOutcome> {
        sends.push(t.approvalDeliveryId);
        return { ok: true, externalDeliveryId: `ext_${t.approvalDeliveryId}` };
      },
    };
    await Promise.all([deliverOnce(pool, gateway, { limit: 10 }), deliverOnce(pool, gateway, { limit: 10 })]);
    const forThis = sends.filter((s) => s.length > 0);
    const { rows } = await pool.query<{ n: string; status: string }>(
      `SELECT count(*)::text n, max(status) status FROM untch_approval_deliveries
        WHERE approval_request_id = $1 AND channel_binding_id = $2`, [id, b]);
    assert.equal(Number(rows[0]!.n), 1, "one logical delivery per binding, however many workers ran");
    assert.equal(rows[0]!.status, "SENT");
    const seen = new Set(sends);
    assert.equal(seen.size, sends.length, "no delivery was handed to the gateway twice");
    assert.ok(forThis.length >= 1);
  });

  test("a rolled-back approval sends nothing", async () => {
    const b = await binding("telegram");
    const { id, subject, policyId } = await pending();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await actOnApproval(client, {
        approvalRequestId: id,
        action: "APPROVE",
        token: mintApprovalActionToken(TOKEN_SECRET, claims(subject, b)),
        tokenSecret: TOKEN_SECRET,
        channelBindingId: b,
        nowMs: Date.now(),
        partitionKey: `policy:${policyId}`,
        resolvePolicy: async () => POLICY_10,
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{ state: string }>(
      `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`, [id]);
    assert.equal(rows[0]!.state, "PENDING", "the rollback left nothing to notify anyone about");
    const { rows: r } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_budget_reservations WHERE approval_request_id = $1`, [id]);
    assert.equal(Number(r[0]!.n), 0);
  });

  test("acting invalidates every sibling delivery in the same transaction", async () => {
    const tg = await binding("telegram");
    const dc = await binding("discord");
    const { id, subject, policyId } = await pending();
    await pool.query(
      `INSERT INTO untch_approval_outbox (event_id, approval_request_id, name) VALUES ($1,$2,'approval.request.ready.v1')`,
      [`aoev3_${id}`, id],
    );
    await projectDeliveries(pool, { limit: 10 });
    await act(id, mintApprovalActionToken(TOKEN_SECRET, claims(subject, tg)), tg, { policyId });

    const { rows } = await pool.query<{ channel_binding_id: string; status: string }>(
      `SELECT channel_binding_id, status FROM untch_approval_deliveries WHERE approval_request_id = $1`, [id]);
    const acted = rows.find((r) => r.channel_binding_id === tg);
    const other = rows.find((r) => r.channel_binding_id === dc);
    assert.equal(acted?.status, "ACTED", "the channel that answered is recorded as the one that did");
    assert.equal(other?.status, "INVALIDATED", "and the rest stop being actionable");
  });

  // ── bootstrap bindings ─────────────────────────────────────────────────────

  test("a bootstrap receive-only binding cannot approve", async () => {
    seq += 1;
    const id = `cbnd_bootstrap_${seq}`;
    await pool.query(
      `INSERT INTO untch_channel_bindings
         (binding_id, account_id, channel, channel_user_id, channel_chat_id, can_decide, status,
          scopes, verification_method, created_at, created_by, updated_at, updated_by)
       VALUES ($1,$2,'telegram',$3,$3,false,'ACTIVE_RECEIVE_ONLY', ARRAY['notify'],
               'operator_bootstrap_unverified', now(),'t', now(),'t')`,
      [id, ACCOUNT, `tg-bootstrap-${seq}`],
    );
    const { id: reqId, subject, policyId } = await pending();
    const result = await act(reqId, mintApprovalActionToken(TOKEN_SECRET, claims(subject, id)), id, { policyId });
    assert.equal(result.outcome, "CHANNEL_BINDING_NOT_VERIFIED_FOR_APPROVAL");
    assert.equal(result.reservationId, null);
  });

  test("the database refuses to give a bootstrap binding approval scope", async () => {
    seq += 1;
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO untch_channel_bindings
             (binding_id, account_id, channel, channel_user_id, can_decide, status, verified_at,
              scopes, verification_method, created_at, created_by, updated_at, updated_by)
           VALUES ($1,$2,'telegram',$3,true,'ACTIVE_RECEIVE_ONLY', now(), ARRAY['notify','policy-approval'],
                   'operator_bootstrap_unverified', now(),'t', now(),'t')`,
          [`cbnd_bad_${seq}`, ACCOUNT, `tg-bad-${seq}`],
        ),
      /untch_channel_receive_only_cannot_decide|untch_channel_unverified_cannot_approve/,
    );
  });

  test("a bootstrap binding receives no approval delivery", async () => {
    seq += 1;
    const boot = `cbnd_bootrecv_${seq}`;
    await pool.query(
      `INSERT INTO untch_channel_bindings
         (binding_id, account_id, channel, channel_user_id, can_decide, status, scopes,
          verification_method, created_at, created_by, updated_at, updated_by)
       VALUES ($1,$2,'discord',$3,false,'ACTIVE_RECEIVE_ONLY', ARRAY['notify'],
               'operator_bootstrap_unverified', now(),'t', now(),'t')`,
      [boot, ACCOUNT, `dc-bootstrap-${seq}`],
    );
    const { id } = await pending();
    await pool.query(
      `INSERT INTO untch_approval_outbox (event_id, approval_request_id, name) VALUES ($1,$2,'approval.request.ready.v1')`,
      [`aoev_boot_${id}`, id],
    );
    await projectDeliveries(pool, { limit: 10 });
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_approval_deliveries WHERE approval_request_id = $1 AND channel_binding_id = $2`,
      [id, boot],
    );
    assert.equal(Number(rows[0]!.n), 0, "an approval message needs a channel that could answer it");
  });

  // ── supersession ───────────────────────────────────────────────────────────

  test("a requote supersedes the prior quote, its reservation and its messages", async () => {
    const b = await binding("telegram");
    const lineage = newQuoteLineageId();
    const first = await pending("6.00", lineage);
    await pool.query(
      `INSERT INTO untch_approval_outbox (event_id, approval_request_id, name) VALUES ($1,$2,'approval.request.ready.v1')`,
      [`aoev_sup_${first.id}`, first.id],
    );
    await projectDeliveries(pool, { limit: 10 });
    const approved = await act(first.id, mintApprovalActionToken(TOKEN_SECRET, claims(first.subject, b)), b, { policyId: first.policyId });
    assert.equal(approved.outcome, "APPROVED");

    const client = await pool.connect();
    let exposureAfter = 0n;
    try {
      await client.query("BEGIN");
      const result = await supersedePriorQuote(client, {
        priorApprovalRequestId: first.id,
        newApprovalRequestId: "aprq_new_650",
        quoteLineageId: lineage,
        newQuoteDigest: "qd_650",
        reason: "PROVIDER_REQUOTE",
        accountId: ACCOUNT,
      });
      assert.equal(result.ok, true);
      assert.equal(result.ok === true && result.releasedExposure, "6.00");
      exposureAfter = await activeReservedExposure(client, first.policyId, Date.now());
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    assert.equal(exposureAfter, 0n, "the 6.00 authority stops counting the moment it is superseded");
    const { rows: req } = await pool.query<{ state: string }>(
      `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`, [first.id]);
    assert.equal(req[0]!.state, "SUPERSEDED");
    const { rows: rsv } = await pool.query<{ status: string }>(
      `SELECT status FROM untch_budget_reservations WHERE approval_request_id = $1`, [first.id]);
    assert.equal(rsv[0]!.status, "SUPERSEDED");
    const { rows: del } = await pool.query<{ status: string }>(
      `SELECT status FROM untch_approval_deliveries WHERE approval_request_id = $1`, [first.id]);
    assert.ok(del.every((d) => ["INVALIDATED", "ACTED"].includes(d.status)), "no live button survives a requote");
  });

  test("the old token refuses once the request is superseded", async () => {
    const b = await binding("telegram");
    const lineage = newQuoteLineageId();
    const first = await pending("6.00", lineage);
    const oldToken = mintApprovalActionToken(TOKEN_SECRET, claims(first.subject, b));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await supersedePriorQuote(client, {
        priorApprovalRequestId: first.id,
        newApprovalRequestId: "aprq_new_650b",
        quoteLineageId: lineage,
        newQuoteDigest: "qd_650b",
        reason: "PROVIDER_REQUOTE",
        accountId: ACCOUNT,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const result = await act(first.id, oldToken, b, { policyId: first.policyId });
    assert.equal(result.outcome, "APPROVAL_SUPERSEDED", "the 6.00 token cannot authorise anything now");
  });

  test("an unchanged quote cannot claim supersession", async () => {
    const lineage = newQuoteLineageId();
    const first = await pending("6.00", lineage);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await supersedePriorQuote(client, {
        priorApprovalRequestId: first.id,
        newApprovalRequestId: "aprq_same",
        quoteLineageId: lineage,
        newQuoteDigest: first.subject.quoteDigest,
        reason: "NOT_REALLY_A_REQUOTE",
        accountId: ACCOUNT,
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.refusal, "QUOTE_UNCHANGED");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  test("another account cannot supersede a request it does not own", async () => {
    const lineage = newQuoteLineageId();
    const first = await pending("6.00", lineage);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await supersedePriorQuote(client, {
        priorApprovalRequestId: first.id,
        newApprovalRequestId: "aprq_theirs",
        quoteLineageId: lineage,
        newQuoteDigest: "qd_theirs",
        reason: "HOSTILE",
        accountId: OTHER,
      });
      assert.equal(result.ok === false && result.refusal, "ACCOUNT_MISMATCH");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  test("a rolled-back supersession leaves the prior authority exactly as it was", async () => {
    const b = await binding("telegram");
    const lineage = newQuoteLineageId();
    const first = await pending("6.00", lineage);
    await act(first.id, mintApprovalActionToken(TOKEN_SECRET, claims(first.subject, b)), b, { policyId: first.policyId });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await supersedePriorQuote(client, {
        priorApprovalRequestId: first.id,
        newApprovalRequestId: "aprq_rolled",
        quoteLineageId: lineage,
        newQuoteDigest: "qd_rolled",
        reason: "PROVIDER_REQUOTE",
        accountId: ACCOUNT,
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const { rows: req } = await pool.query<{ state: string }>(
      `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`, [first.id]);
    assert.equal(req[0]!.state, "APPROVED", "the rollback preserved the old state");
    const { rows: rsv } = await pool.query<{ status: string }>(
      `SELECT status FROM untch_budget_reservations WHERE approval_request_id = $1`, [first.id]);
    assert.equal(rsv[0]!.status, "ACTIVE");
  });

  test("only one successor may be open in a lineage", async () => {
    const lineage = newQuoteLineageId();
    await pending("6.50", lineage);
    await assert.rejects(() => pending("6.75", lineage), /untch_approval_one_open_per_lineage/);
  });

  // ── the public case ────────────────────────────────────────────────────────

  test("the public case joins the whole story and leaks none of it", async () => {
    const b = await binding("telegram");
    const { id, subject, policyId } = await pending("6.00");
    await pool.query(
      `INSERT INTO untch_approval_outbox (event_id, approval_request_id, name) VALUES ($1,$2,'approval.request.ready.v1')`,
      [`aoev_case_${id}`, id],
    );
    await projectDeliveries(pool, { limit: 10 });
    await act(id, mintApprovalActionToken(TOKEN_SECRET, claims(subject, b)), b, { policyId });

    const client = await pool.connect();
    let json = "";
    let projected: Awaited<ReturnType<typeof approvalCaseProjection>> = null;
    try {
      projected = await approvalCaseProjection(client, id);
      json = JSON.stringify(projected);
    } finally {
      client.release();
    }

    assert.ok(projected, "the case exists");
    assert.equal(projected!.projection, "APPROVAL_CASE_PROJECTION");
    assert.equal(projected!.serviceCall.state, "FINALIZED");
    assert.ok(projected!.serviceCall.settlementTransactionHash, "the confirmed settlement is named");
    assert.equal(projected!.approval.state, "APPROVED");
    assert.equal(projected!.terminalDecision?.decision, "APPROVE");
    assert.equal(projected!.reservation?.storedStatus, "ACTIVE");
    assert.equal(projected!.reservation?.effectiveStatus, "ACTIVE");
    assert.equal(projected!.reservation?.countsTowardExposure, true);
    assert.equal(projected!.reservation?.economicClassification, "RESERVED_AUTHORITY_NOT_SPEND");
    assert.ok(projected!.deliveries.length >= 1);
    assert.ok(projected!.deliveries.every((d) => typeof d.channel === "string"));

    assert.ok(!json.includes(ACCOUNT), "the raw account id never appears");
    for (const forbidden of NEVER_PUBLIC_CASE_FIELDS) {
      assert.ok(!json.includes(`"${forbidden}"`), `${forbidden} must not be published`);
    }
    assert.ok(!json.includes("telegram-user-"), "a platform handle is somebody real");
  });

  test("an expired reservation reads EXPIRED in the case without a sweeper", async () => {
    const b = await binding("telegram");
    const { id, subject, policyId } = await pending("6.00");
    await act(id, mintApprovalActionToken(TOKEN_SECRET, claims(subject, b)), b, { policyId });
    await pool.query(
      `UPDATE untch_budget_reservations SET expires_at = now() - interval '1 minute' WHERE approval_request_id = $1`,
      [id],
    );
    const client = await pool.connect();
    try {
      const c = await approvalCaseProjection(client, id);
      assert.equal(c!.reservation?.storedStatus, "ACTIVE", "the stored status is preserved");
      assert.equal(c!.reservation?.effectiveStatus, "EXPIRED", "and the derived one tells the truth");
      assert.equal(c!.reservation?.countsTowardExposure, false);
    } finally {
      client.release();
    }
  });

  test("a cross-account delivery cannot be written at all", async () => {
    const theirs = await binding("telegram", { account: OTHER });
    const { id, policyId } = await pending();
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO untch_approval_deliveries (delivery_id, approval_request_id, channel, channel_binding_id, outcome, status)
           VALUES ($1,$2,'telegram',$3,'SKIPPED','QUEUED')`,
          [`apdl_bad_${id}`, id, theirs],
        ),
      /channel bound to account/,
    );
  });
});
