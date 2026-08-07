/**
 * Per-test ownership for the approval-delivery suites.
 *
 * THE BUG THIS EXISTS TO PREVENT
 *
 * `projectDeliveries` creates one delivery row for EVERY eligible active binding on the account. That
 * is correct: an account with a Discord binding and a web binding must be told on both. It becomes a
 * test defect the moment several tests share one account, because a binding created by an earlier
 * test is still ACTIVE and still eligible when a later test projects its own request. The later test
 * then gets two rows where it expected one, and an assertion of the shape
 *
 *     SELECT status FROM untch_approval_deliveries WHERE approval_request_id = $1   -- no ORDER BY
 *     assert.equal(rows[0].status, "FAILED_TERMINAL")
 *
 * reads an arbitrary one of them. It passed on CI and failed on a different PostgreSQL build for no
 * reason other than physical row order, which means it was never actually asserting what it claimed.
 *
 * The fix is ownership, not ordering. A test that owns its account cannot inherit another test's
 * binding, so `rows[0]` becomes deterministic because there is genuinely one row — and where a test
 * WANTS two bindings it now says so and asserts both, which is a stronger statement than before.
 *
 * WHY THE IDS ARE DERIVED RATHER THAN RANDOM
 *
 * A failing run should be reproducible from the test name alone. Random ids would make each failure a
 * new mystery, and a fixture that differs per run cannot be inspected after the fact.
 */

import { createHash } from "node:crypto";

export interface DeliveryOwnership {
  /** `acct_` + 26 lowercase base32 characters, matching `untch_accounts_id_shape`. */
  readonly accountId: string;
  readonly accountRefHash: string;
  /**
   * A Discord snowflake unique to this test.
   *
   * `untch_channel_one_active_identity` is UNIQUE on (channel, channel_user_id) for any live status,
   * so two tests reusing one user id cannot both hold an ACTIVE binding — a unique account alone is
   * not enough to isolate them.
   */
  readonly channelUserId: string;
  readonly bindingId: string;
  readonly approvalRequestId: string;
  readonly serviceCallId: string;
  readonly outboxEventId: string;
  /** Derive a further stable id when a test needs a second binding, request or delivery. */
  readonly extra: (label: string) => string;
  /**
   * A further snowflake, derived from its OWN hash rather than by mutating `channelUserId`.
   *
   * Editing a digit of the primary id looks unique and is not: the derivation can already produce a
   * value starting with that digit, and the pair then collides on
   * `untch_channel_one_active_identity`. Found by this suite failing on its first run.
   */
  readonly extraChannelUserId: (label: string) => string;
}

const hex = (input: string, bytes = 32): string =>
  createHash("sha256").update(input).digest("hex").slice(0, bytes);

/**
 * Identifiers owned by exactly one test.
 *
 * `scope` should be the test's own name. Two tests that pass the same string share a fixture, which
 * is occasionally what a pair of tests genuinely wants and is otherwise the bug this prevents — so it
 * has to be written down rather than inherited by accident.
 */
export function deliveryOwnership(scope: string): DeliveryOwnership {
  const h = hex(scope);
  return {
    accountId: `acct_${h.slice(0, 26)}`,
    accountRefHash: `0x${hex(`ref:${scope}`, 64)}`,
    // 18 digits, the shape Discord actually uses, derived so it is stable and collision-resistant.
    channelUserId: BigInt(`0x${h.slice(0, 15)}`).toString().padStart(18, "1").slice(0, 18),
    bindingId: `cbnd_${h.slice(0, 24)}`,
    approvalRequestId: `aprq_${h.slice(0, 24)}`,
    serviceCallId: `svc_${h.slice(0, 24)}`,
    outboxEventId: `aoev_${h.slice(0, 20)}`,
    extra: (label: string) => hex(`${scope}:${label}`, 24),
    extraChannelUserId: (label: string) =>
      BigInt(`0x${hex(`snowflake:${scope}:${label}`, 15)}`).toString().padStart(18, "1").slice(0, 18),
  };
}

/** The one query shape these fixtures need. Matches both a Pool and a Client. */
export interface OwnershipQuery {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/** Create the account this test owns. */
export async function createOwnedAccount(db: OwnershipQuery, own: DeliveryOwnership): Promise<void> {
  await db.query(
    `INSERT INTO untch_accounts (account_id, status, created_at, created_by, updated_at, updated_by)
     VALUES ($1,'ACTIVE', now(),'test', now(),'test')
     ON CONFLICT (account_id) DO NOTHING`,
    [own.accountId],
  );
}

export interface OwnedBindingOptions {
  readonly bindingId?: string;
  readonly channelUserId?: string;
  readonly channelChatId?: string | null;
  readonly channel?: string;
  readonly canDecide?: boolean;
  readonly status?: string;
  readonly verificationMethod?: string;
  readonly scopes?: readonly string[];
}

/** Create a binding this test owns. Nothing else in the file may rely on it existing. */
export async function createOwnedBinding(
  db: OwnershipQuery,
  own: DeliveryOwnership,
  options: OwnedBindingOptions = {},
): Promise<string> {
  const bindingId = options.bindingId ?? own.bindingId;
  await db.query(
    `INSERT INTO untch_channel_bindings
       (binding_id, account_id, channel, channel_user_id, channel_chat_id, can_decide, status,
        verified_at, scopes, verification_method, account_ref_hash, created_at, created_by, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8, $9, $10, now(),'test', now(),'test')`,
    [
      bindingId,
      own.accountId,
      options.channel ?? "discord",
      options.channelUserId ?? own.channelUserId,
      options.channelChatId === undefined ? null : options.channelChatId,
      options.canDecide ?? true,
      options.status ?? "ACTIVE",
      options.scopes ?? ["notify", "policy-approval"],
      options.verificationMethod ?? "discord_oauth_identify",
      own.accountRefHash,
    ],
  );
  return bindingId;
}

/**
 * Remove everything this test created, scoped to its own account.
 *
 * Runs in a `finally` so a failing assertion still cleans up — a test that leaves an ACTIVE binding
 * behind when it fails would turn one red test into several, and the extra failures would point
 * everywhere except the cause.
 *
 * Deliberately NOT a truncate. Truncating shared tables between concurrent tests would trade this bug
 * for a worse one, and the account scope is what makes the cleanup safe to run at any time.
 */
export async function dropOwnedFixtures(db: OwnershipQuery, own: DeliveryOwnership): Promise<void> {
  // Ordered child-first so foreign keys never block the cleanup.
  await db.query(`DELETE FROM untch_approval_action_refs WHERE account_id = $1`, [own.accountId]);
  await db.query(
    `DELETE FROM untch_approval_action_nonces WHERE approval_request_id IN
       (SELECT approval_request_id FROM untch_approval_requests WHERE account_id = $1)`,
    [own.accountId],
  );
  await db.query(`DELETE FROM untch_approval_deliveries WHERE account_id = $1`, [own.accountId]);
  await db.query(`DELETE FROM untch_approval_decisions WHERE account_id = $1`, [own.accountId]);
  await db.query(
    `DELETE FROM untch_approval_outbox WHERE approval_request_id IN
       (SELECT approval_request_id FROM untch_approval_requests WHERE account_id = $1)`,
    [own.accountId],
  );
  await db.query(`DELETE FROM untch_budget_reservations WHERE account_id = $1`, [own.accountId]);
  await db.query(`DELETE FROM untch_approval_requests WHERE account_id = $1`, [own.accountId]);
  await db.query(`DELETE FROM untch_x402_payment_attempts WHERE service_call_id IN
       (SELECT service_call_id FROM untch_x402_service_calls WHERE account_id = $1)`, [own.accountId]);
  await db.query(`DELETE FROM untch_x402_service_calls WHERE account_id = $1`, [own.accountId]);
  await db.query(`DELETE FROM untch_channel_bindings WHERE account_id = $1`, [own.accountId]);
  await db.query(`DELETE FROM untch_accounts WHERE account_id = $1`, [own.accountId]);
}

/**
 * Read the delivery for ONE binding, by name.
 *
 * The replacement for `rows[0]`. A test that means "the Discord DM delivery" says which binding it
 * means, so the assertion cannot be satisfied by a different row that happens to sort first.
 */
export async function deliveryFor(
  db: OwnershipQuery,
  approvalRequestId: string,
  channelBindingId: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM untch_approval_deliveries
      WHERE approval_request_id = $1 AND channel_binding_id = $2`,
    [approvalRequestId, channelBindingId],
  );
  if (rows.length > 1) {
    throw new Error(
      `expected at most one delivery for (${approvalRequestId}, ${channelBindingId}) and found ${rows.length}; ` +
        "a duplicate request/binding pair is a product defect, not a fixture problem",
    );
  }
  return rows[0] ?? null;
}

/** Every delivery for a request, ordered by binding so the sequence is stable to assert against. */
export async function deliveriesForRequest(
  db: OwnershipQuery,
  approvalRequestId: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM untch_approval_deliveries
      WHERE approval_request_id = $1 ORDER BY channel_binding_id`,
    [approvalRequestId],
  );
  return rows;
}
