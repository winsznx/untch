import {
  APPROVAL_ACTION_TOKEN_VERSION,
  actOnApproval,
  activeReservedExposure,
  ensureWebApprovalBinding,
  mintApprovalActionToken,
  newActionNonce,
  newQuoteLineageId,
  supersedePriorQuote,
  approvalCaseProjection,
  PgServiceCallStore,
  createPool,
  finalizeSettlement,
  newApprovalRequestId,
  requestFingerprint,
  APPROVAL_DIGEST_SCHEMA_VERSION,
  type AuthorizedTerms,
} from "@untch/consumer-core";

/**
 * The always-rollback proof for the approval foundation.
 *
 * Everything below runs against the REAL production database inside ONE transaction that always ends
 * in ROLLBACK. The point is to exercise the real schema, the real constraints and the real finalizer
 * against real data, and to leave the database exactly as it was found.
 *
 * It moves no money. The settlement evidence is constructed, not fetched, because a real settlement
 * would require a real transfer and this proof exists precisely so that is not necessary.
 *
 * Run: pnpm --filter @untch/asp exec tsx src/run-approval-foundation-proof.ts
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const TOKEN_SECRET = process.env.PROOF_TOKEN_SECRET?.trim() || "approval-proof-secret";
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const TABLES = [
  "untch_x402_service_calls",
  "untch_x402_payment_attempts",
  "untch_approval_requests",
  "untch_approval_outbox",
  "untch_approval_decisions",
  "untch_approval_deliveries",
  "untch_budget_reservations",
  "untch_decision_evidence",
  "escalations",
  "consumer_outbox",
  "ledger_entries",
  "receipts",
] as const;

async function counts(q: { query(sql: string): Promise<{ rows: unknown[] }> }): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const { rows } = await q.query(`SELECT count(*)::int AS n FROM ${t}`);
    out[t] = (rows[0] as { n: number }).n;
  }
  return out;
}

const pool = createPool(DATABASE_URL);
const before = await counts(pool);

const client = await pool.connect();
const observed: Record<string, unknown> = {};

try {
  await client.query("BEGIN");

  /**
   * An account that exists in production. Read rather than created, because creating one would be a
   * write this proof has no business making even inside a rollback.
   */
  const { rows: accts } = await client.query<{ account_id: string }>(
    `SELECT account_id FROM untch_accounts WHERE status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
  );
  if (!accts[0]) throw new Error("no ACTIVE account in production to run the proof against");
  const accountId = accts[0].account_id;
  observed.accountUsed = `${accountId.slice(0, 10)}…`;

  const store = new PgServiceCallStore(pool);
  const nonce = `0xproof${"0".repeat(58)}`;
  const terms: AuthorizedTerms = {
    authorizationNonce: nonce,
    payer: "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64",
    token: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    amount: "50000",
    payTo: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba",
    chain: "eip155:196",
  };

  const call = await store.upsertServiceCall(
    {
      accountId,
      route: "/preflight_payment",
      idempotencyKey: "approval-foundation-rollback-proof",
      requestFingerprint: requestFingerprint({
        provider: "untch",
        capability: "owned_work.demo",
        amount: "6.00",
        currency: "USDT0",
        policyId: "778001",
        deadline: "2026-08-04T12:00:00.000Z",
      }),
    },
    { decisionId: "dec_proof", intentHash: "0xproofintent", policyId: "778001" },
    client,
  );
  observed.serviceCall = { id: call.serviceCallId, state: call.state };

  const attempt = await store.recordAttempt(call.serviceCallId, terms, { validAfter: null, validBefore: null }, client);
  observed.paymentAttempt = {
    id: attempt.attemptId,
    nonce: attempt.authorizationNonce,
    state: attempt.state,
    amount: attempt.amount,
    chain: attempt.chain,
  };

  /**
   * Every field the action token binds is written at INSERT.
   *
   * The immutability trigger refuses a later change to the approval digest, which is exactly right and
   * is how the first run of this proof failed: a request cannot have its subject rewritten after a
   * human has been asked about it.
   */
  const approvalRequestId = newApprovalRequestId();
  const accountRef = `arh_proof_${call.serviceCallId.slice(-8)}`;
  const lineage = newQuoteLineageId();
  const subject = {
    approvalRequestId,
    approvalDigest: `apd_proof_${call.serviceCallId}`,
    intentHash: "0xproofintent",
    quoteDigest: "qd_proof_600",
    policyId: "778001",
    policyHash: "0xproofpolicy",
    amount: "6.00",
    asset: "USDT0",
    chain: "eip155:196",
    recipient: "0xproofrecipient",
    provider: "untch",
    capability: "owned_work.demo",
    requesterPrincipalRef: "req_proof",
    walletAuthorityRef: "wa_proof",
    accountRefHash: accountRef,
  };
  await client.query(
    `INSERT INTO untch_approval_requests
      (approval_request_id, account_id, policy_id, policy_version, intent_id, quote_hash, provider, capability,
       amount, asset, reason, approval_digest, nonce, state, expires_at, created_by, updated_by,
       service_call_id, decision_id, approval_digest_schema_version,
       intent_hash, quote_digest, policy_hash, chain, recipient,
       requester_principal_ref, wallet_authority_ref, account_ref_hash, quote_lineage_id)
     VALUES ($1,$2,'778001',1,'intent_proof','qh_proof','untch','owned_work.demo','6.00','USDT0',
             'ESCALATED_THRESHOLD', $3, 'nonce_proof', 'PROVISIONAL', now() + interval '1 hour',
             'rollback-proof','rollback-proof',$4,'dec_proof',$5,
             $6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [approvalRequestId, accountId, subject.approvalDigest, call.serviceCallId, APPROVAL_DIGEST_SCHEMA_VERSION,
     subject.intentHash, subject.quoteDigest, subject.policyHash, subject.chain, subject.recipient,
     subject.requesterPrincipalRef, subject.walletAuthorityRef, accountRef, lineage],
  );

  const provisionalOutbox = await client.query(
    `SELECT count(*)::int AS n FROM untch_approval_outbox WHERE approval_request_id = $1`,
    [approvalRequestId],
  );
  const provisionalReservations = await client.query(
    `SELECT count(*)::int AS n FROM untch_budget_reservations WHERE created_at > now() - interval '1 minute'`,
  );
  observed.provisional = {
    approvalRequestId,
    state: "PROVISIONAL",
    outboxEvents: (provisionalOutbox.rows[0] as { n: number }).n,
    newReservations: (provisionalReservations.rows[0] as { n: number }).n,
  };

  /** A pending settlement first. processSettlement would have called this success. */
  const pendingResult = await finalizeSettlement(client, {
    serviceCallId: call.serviceCallId,
    evidence: { kind: "PENDING", transactionHash: "0xproofpending", paymentId: "pid_proof" },
  });
  const afterPending = await client.query<{ state: string }>(
    `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`,
    [approvalRequestId],
  );
  observed.pendingSettlement = {
    outcome: pendingResult.outcome,
    approvalState: afterPending.rows[0]!.state,
    activatedAnything: afterPending.rows[0]!.state !== "PROVISIONAL",
  };

  /** Now authoritative confirmation. */
  const confirmedResult = await finalizeSettlement(client, {
    serviceCallId: call.serviceCallId,
    evidence: {
      kind: "CONFIRMED",
      source: "facilitator_settle_status",
      transactionHash: "0xproofpending",
      paymentId: "pid_proof",
      terms,
    },
  });
  const activated = await client.query<{ state: string; settled_attempt_id: string | null; activated_at: Date | null }>(
    `SELECT state, settled_attempt_id, activated_at FROM untch_approval_requests WHERE approval_request_id = $1`,
    [approvalRequestId],
  );
  const events = await client.query<{ event_id: string; name: string }>(
    `SELECT event_id, name FROM untch_approval_outbox WHERE approval_request_id = $1`,
    [approvalRequestId],
  );
  observed.confirmedSettlement = {
    outcome: confirmedResult.outcome,
    approvalState: activated.rows[0]!.state,
    namesSettledAttempt: activated.rows[0]!.settled_attempt_id !== null,
    outboxEvents: events.rows.length,
    eventName: events.rows[0]?.name ?? null,
  };

  /** Calling it again must change nothing. */
  const repeat = await finalizeSettlement(client, {
    serviceCallId: call.serviceCallId,
    evidence: {
      kind: "CONFIRMED",
      source: "facilitator_settle_status",
      transactionHash: "0xproofpending",
      paymentId: "pid_proof",
      terms,
    },
  });
  const eventsAfterRepeat = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM untch_approval_outbox WHERE approval_request_id = $1`,
    [approvalRequestId],
  );
  observed.repeatedFinalization = {
    outcome: repeat.outcome,
    outboxEvents: (eventsAfterRepeat.rows[0] as { n: number }).n,
  };

  /**
   * A settled call must refuse another payment attempt.
   *
   * Inside a SAVEPOINT, because this is a DELIBERATE failure and a failed statement aborts the whole
   * transaction in Postgres. Without the savepoint the refusal being proven would take every
   * subsequent read down with it, which is what happened the first time this ran.
   */
  let secondAttemptRefused = false;
  await client.query("SAVEPOINT second_attempt");
  try {
    await store.recordAttempt(call.serviceCallId, { ...terms, authorizationNonce: "0xsecond" }, { validAfter: null, validBefore: null }, client);
    await client.query("RELEASE SAVEPOINT second_attempt");
  } catch {
    secondAttemptRefused = true;
    await client.query("ROLLBACK TO SAVEPOINT second_attempt");
  }
  observed.secondAttemptRefused = secondAttemptRefused;

  const reservationsNow = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM untch_budget_reservations`,
  );
  observed.reservationsTotal = (reservationsNow.rows[0] as { n: number }).n;

  const escalationsNow = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM escalations`);
  observed.legacyEscalations = (escalationsNow.rows[0] as { n: number }).n;

  // ── the human half ────────────────────────────────────────────────────────
  //
  // Everything below runs inside the SAME always-rollback transaction. It exercises the real web
  // binding, the real action token, the real terminal decision and the real supersession against
  // production data, and leaves none of it behind.

  const web = await ensureWebApprovalBinding(client, {
    accountId,
    accountRefHash: accountRef,
    walletScopes: ["identity", "policy-authority"],
  });
  observed.webBinding = { ok: web.ok, created: web.ok === true ? web.created : null };
  if (!web.ok) throw new Error(`web binding refused: ${web.refusal}`);

  const identityOnly = await ensureWebApprovalBinding(client, {
    accountId,
    accountRefHash: `${accountRef}_id`,
    walletScopes: ["identity"],
  });
  observed.identityOnlyRefused = identityOnly.ok === false ? identityOnly.refusal : "NOT_REFUSED";


  const mkToken = (bindingId: string, over: Record<string, unknown> = {}) =>
    mintApprovalActionToken(TOKEN_SECRET, {
      v: APPROVAL_ACTION_TOKEN_VERSION,
      ...subject,
      channelBindingId: bindingId,
      action: "APPROVE",
      nonce: newActionNonce(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      ...over,
    } as never);

  const policy10 = async () => ({ status: "ACTIVE", expiresAtMs: null, dailyLimit: "10.00" });
  const policy4 = async () => ({ status: "ACTIVE", expiresAtMs: null, dailyLimit: "4.00" });

  // Proof 4 first, because a refusal must leave the request approvable afterwards.
  await client.query("SAVEPOINT budget_probe");
  const tight = await actOnApproval(client, {
    approvalRequestId, action: "APPROVE", token: mkToken(web.bindingId), tokenSecret: TOKEN_SECRET,
    channelBindingId: web.bindingId, nowMs: Date.now(), partitionKey: "policy:778001",
    resolvePolicy: policy4,
  });
  observed.budgetChanged = { outcome: tight.outcome, reservation: tight.reservationId };
  await client.query("ROLLBACK TO SAVEPOINT budget_probe");

  // A changed amount must refuse.
  await client.query("SAVEPOINT token_probe");
  const wrongAmount = await actOnApproval(client, {
    approvalRequestId, action: "APPROVE",
    token: mkToken(web.bindingId, { amount: "6.50" }), tokenSecret: TOKEN_SECRET,
    channelBindingId: web.bindingId, nowMs: Date.now(), partitionKey: "policy:778001",
    resolvePolicy: policy10,
  });
  observed.changedAmountRefused = { outcome: wrongAmount.outcome, refusal: wrongAmount.tokenRefusal };
  await client.query("ROLLBACK TO SAVEPOINT token_probe");

  // Proof 2: the real approval.
  const approved = await actOnApproval(client, {
    approvalRequestId, action: "APPROVE", token: mkToken(web.bindingId), tokenSecret: TOKEN_SECRET,
    channelBindingId: web.bindingId, nowMs: Date.now(), partitionKey: "policy:778001",
    resolvePolicy: policy10,
  });
  observed.approval = {
    outcome: approved.outcome,
    hasDecision: approved.decisionId !== null,
    hasReservation: approved.reservationId !== null,
    budget: approved.budget,
  };

  const exposureAfterApproval = await activeReservedExposure(client, "778001", Date.now());
  observed.exposureAfterApproval = exposureAfterApproval.toString();

  // Proof 3: a second action.
  const second = await actOnApproval(client, {
    approvalRequestId, action: "APPROVE", token: mkToken(web.bindingId), tokenSecret: TOKEN_SECRET,
    channelBindingId: web.bindingId, nowMs: Date.now(), partitionKey: "policy:778001",
    resolvePolicy: policy10,
  });
  observed.secondAction = second.outcome;

  // Proof 7: the public case.
  const projected = await approvalCaseProjection(client, approvalRequestId);
  const caseJson = JSON.stringify(projected);
  observed.caseProjection = {
    version: projected?.version ?? null,
    serviceCallState: projected?.serviceCall.state ?? null,
    hasSettlementTx: Boolean(projected?.serviceCall.settlementTransactionHash),
    approvalState: projected?.approval.state ?? null,
    decision: projected?.terminalDecision?.decision ?? null,
    reservationStored: projected?.reservation?.storedStatus ?? null,
    reservationEffective: projected?.reservation?.effectiveStatus ?? null,
    countsTowardExposure: projected?.reservation?.countsTowardExposure ?? null,
    leaksAccountId: caseJson.includes(accountId),
  };

  // Proof 5 and 6: the requote.
  const oldToken = mkToken(web.bindingId);
  const sup = await supersedePriorQuote(client, {
    priorApprovalRequestId: approvalRequestId,
    newApprovalRequestId: "aprq_proof_650",
    quoteLineageId: lineage,
    newQuoteDigest: "qd_proof_650",
    reason: "PROVIDER_REQUOTE",
    accountId,
  });
  observed.supersession = sup.ok
    ? { ok: true, releasedExposure: sup.releasedExposure, invalidatedDeliveries: sup.invalidatedDeliveries }
    : { ok: false, refusal: sup.refusal };

  const exposureAfterSupersession = await activeReservedExposure(client, "778001", Date.now());
  observed.exposureAfterSupersession = exposureAfterSupersession.toString();

  const oldTokenNow = await actOnApproval(client, {
    approvalRequestId, action: "APPROVE", token: oldToken, tokenSecret: TOKEN_SECRET,
    channelBindingId: web.bindingId, nowMs: Date.now(), partitionKey: "policy:778001",
    resolvePolicy: policy10,
  });
  observed.oldTokenAfterSupersession = oldTokenNow.outcome;

  const { rows: rsvNow } = await client.query<{ status: string }>(
    `SELECT status FROM untch_budget_reservations WHERE approval_request_id = $1`,
    [approvalRequestId],
  );
  observed.oldReservationStatus = rsvNow[0]?.status ?? null;

  const inTx = await counts(client);
  observed.countsInsideTransaction = inTx;
} finally {
  /**
   * ALWAYS. There is no success path that commits. A proof that could leave state behind under some
   * condition is not an always-rollback proof, it is a write with an apology attached.
   */
  await client.query("ROLLBACK");
  client.release();
}

const after = await counts(pool);
await pool.end();

const drift = Object.fromEntries(
  Object.keys(before).filter((k) => before[k] !== after[k]).map((k) => [k, { before: before[k], after: after[k] }]),
);

console.log(
  JSON.stringify(
    { proof: "APPROVAL_FOUNDATION_ROLLBACK", observed, countsBefore: before, countsAfter: after, drift, driftFree: Object.keys(drift).length === 0 },
    null,
    1,
  ),
);
