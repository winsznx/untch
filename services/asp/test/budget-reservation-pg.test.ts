import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { keccak256, toHex } from "viem";
import {
  PgAccountStore,
  budgetExposure,
  consumeReservation,
  createPool,
  decisionStateCounts,
  expireStaleReservations,
  getReservation,
  newWalletBindingId,
  recordSettledSpend,
  releaseReservation,
  reservationForIntent,
  type Pool,
} from "@untch/consumer-core";
import { PgPolicyRepo, PolicyProvider, type StoredPolicy } from "@untch/policy-store";
import { ledgerPartitionKey, utcDayKey } from "@untch/policy-engine";
import { hashCanonicalJson } from "@untch/canon";
import { findOwnedService } from "@untch/owned-work";
import { handlePublicPreflight, type PublicPreflightDeps } from "../src/public-dto/preflight";
import { mintAccountSession } from "../src/consumer/account-auth";
import { InMemoryIntentStore } from "../src/ledger-state";
import { narrowToDecisionOnly, type DecisionOnlyDeps } from "../src/route-profiles";

/**
 * AUTHORITY RESERVED IS NOT MONEY SPENT.
 *
 * WHAT WAS WRONG
 *
 * An APPROVED preflight added the governed amount to a counter called `spentTodayByAgent`, and every
 * surface downstream read that noun literally: the ledger wrote a `SPEND` row, the reconcile report
 * called those rows "money that actually moved", and the dashboard rendered their sum under a tile
 * reading "Spent" with a budget meter beneath it.
 *
 * `/preflight_payment` is decision_only. It judges a proposed spend and executes nothing. So a 4.00
 * approval was permission granted, and calling it spend made an authorisation look like a completed
 * payment at four layers of the product.
 *
 * WHY NOT SIMPLY STOP COUNTING IT
 *
 * Because two agents could then each be approved against the same remaining budget — neither approval
 * visible to the other until money moved, and money may never move. The capacity has to be visible
 * without being called spend. That is a reservation, and a reservation needs a lifecycle a counter
 * cannot express: consumed at settlement, released on expiry, failure, supersession or cancellation.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_budget_reservations";
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..", "..", "packages");

const WALLET: Address = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const SECRET = "budget-reservation-test-secret";
const POLICY_ID = "881001";
const PARTITION = ledgerPartitionKey(POLICY_ID);
/**
 * A second policy with a deliberately small daily budget.
 *
 * The over-authorisation tests need a ceiling they can actually reach; every other test needs
 * headroom so it is testing the reservation lifecycle rather than accidentally testing the budget.
 * Two policies keeps those independent — the first version used one, and later tests started failing
 * because earlier ones had legitimately consumed the ceiling.
 */
const TIGHT_POLICY_ID = "881002";
const TIGHT_PARTITION = ledgerPartitionKey(TIGHT_POLICY_ID);
const FUTURE = "2027-06-01T00:00:00.000Z";

function ownDatabaseUrl(): string {
  const url = new URL(TEST_DB as string);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

function allMigrations(): { name: string; sql: string }[] {
  const files: { name: string; sql: string }[] = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PACKAGES, entry.name, "migrations");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) if (f.endsWith(".sql")) files.push({ name: f, sql: readFileSync(join(dir, f), "utf8") });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Headroom, so the lifecycle tests are not competing with each other for capacity. */
function rules(daily = 1000): StoredPolicy["rules"] {
  return {
    budgets: { daily, token: "USDT0" },
    perCallCap: 8.0,
    onPerCallCapExceeded: "BLOCK",
    escalateAbove: 5.0,
    categories: { allow: [], deny: [] },
    recipients: { allow: [], deny: [] },
    agents: { allowWorkerIds: [], denyWorkerIds: [] },
    duplicates: { ttlMin: 0, keys: ["taskHash", "endpoint", "paramsHash"] },
    cooldowns: { sameServiceMin: 0 },
    rateLimit: { callsPerHour: 100 },
    expiry: "2027-12-31T00:00:00Z",
  } as unknown as StoredPolicy["rules"];
}

describe(
  "an approved decision reserves authority; it does not spend money",
  { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" },
  () => {
    let pool: Pool;
    let publicDeps: PublicPreflightDeps;
    let decisionDeps: DecisionOnlyDeps;
    let accountId: string;
    let token: string;

    before(async () => {
      const admin = createPool(TEST_DB!);
      try {
        await admin.query(`CREATE DATABASE ${OWN_DATABASE}`).catch((err: unknown) => {
          if ((err as { code?: string }).code !== "42P04") throw err;
        });
      } finally {
        await admin.end();
      }
      pool = createPool(ownDatabaseUrl());
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await pool.query("CREATE SCHEMA public");
      for (const m of allMigrations()) await pool.query(m.sql);

      const accounts = new PgAccountStore(pool);
      accountId = (await accounts.createAccount({ by: "test" })).accountId;
      const bindingId = newWalletBindingId();
      await accounts.linkWallet({
        bindingId, accountId, chainKind: "evm", address: WALLET, role: "primary", proofKind: "siwe",
        proofRef: "t", verifiedAt: "2026-08-03T00:00:00.000Z", walletProvider: "okx-agentic-wallet",
        scopes: ["identity", "policy-authority"], by: "siwe",
      });
      await accounts.setPrimaryWallet({ accountId, bindingId, by: "test" });

      const repo = new PgPolicyRepo(pool as never);
      for (const [id, daily] of [[POLICY_ID, 1000], [TIGHT_POLICY_ID, 6]] as const) {
        await repo.insert({
          id, owner: WALLET, agentId: WALLET, version: 1, status: "ACTIVE",
          policyHash: hashCanonicalJson(rules(daily) as unknown as Record<string, unknown>),
          expiry: Math.floor(Date.parse("2027-12-31T00:00:00Z") / 1000),
          onchainRef: { chainId: 196, txHash: keccak256(toHex(`res-test-${id}`)), blockNumber: 1 },
          rules: rules(daily), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as unknown as StoredPolicy);
        await accounts.linkPolicy({ accountId, policyId: id, linkedBy: "registered", by: "test" });
      }
      await accounts.setDefaultPolicy({ accountId, policyId: POLICY_ID, by: "test" });

      token = mintAccountSession({
        secret: SECRET, accountId, address: WALLET, bindingId,
        scopes: ["identity", "policy-authority"], nowMs: Date.now(),
      }).token;

      publicDeps = {
        accounts,
        policies: new PolicyProvider(repo),
        ownedService: (p, c) => findOwnedService(p, c),
        network: { token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", symbol: "USDT0", decimals: 6 },
        sessionSecret: SECRET,
        executionEnabled: true,
        chainId: 196,
        registry: "0x0000000000000000000000000000000000000000",
        evidenceTx: null,
      };
      decisionDeps = narrowToDecisionOnly({
        policyProvider: new PolicyProvider(repo),
        intentStore: new InMemoryIntentStore(),
        scoreDataSource: null,
      });
    });

    after(async () => {
      await pool.end();
    });

    const committing = async <T,>(fn: (tx: never) => Promise<T>): Promise<T> => {
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
    const rollingBack = async <T,>(fn: (tx: never) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await fn(client as never);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    };
    const tx = async <T,>(fn: (t: never) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        return await fn(client as never);
      } finally {
        client.release();
      }
    };

    let seq = 0;
    const run = async (amount: string, mode: "commit" | "rollback", key?: string, policyId?: string) => {
      const result = await handlePublicPreflight(
        {
          provider: "untch", capability: "owned_work.demo", task: `reservation test ${amount} ${key ?? ++seq}`,
          maxSpend: amount, currency: "USDT0", deadline: FUTURE,
          idempotencyKey: key ?? `res-${amount}-${seq}`,
          ...(policyId ? { policyId } : {}),
        },
        `Bearer ${token}`,
        { ...publicDeps, evidenceTx: mode === "commit" ? committing : rollingBack },
        decisionDeps,
      );
      return result.body as Record<string, unknown>;
    };

    const exposure = (partition = PARTITION) =>
      tx((t) => budgetExposure(t, partition, utcDayKey(Date.now()), new Date().toISOString()));
    const counts = () => tx((t) => decisionStateCounts(t, PARTITION));

    // ── an approval reserves ─────────────────────────────────────────────────

    test("an approved 4.00 creates exactly one ACTIVE reservation and no settled spend", async () => {
      const body = await run("4.00", "commit", "res-first");
      assert.equal(body.outcome, "APPROVED_AUTOMATIC");

      const budget = body.budget as Record<string, unknown>;
      assert.equal(budget.economicClassification, "RESERVED_AUTHORITY_NOT_SPEND");
      assert.equal(budget.proposedReservation, "4.00");
      assert.equal(budget.settledGovernedSpend, 0);
      assert.ok(typeof budget.reservationId === "string");

      const e = await exposure();
      assert.equal(e.reservedActiveToday, 4, "authority reserved");
      assert.equal(e.settledToday, 0, "and nothing settled");
      assert.equal(e.effectiveToday, 4);

      const c = await counts();
      assert.equal(c.activeReserved, "4.000000000000000000");
      assert.equal(c.settledSpend, "0");

      const r = await tx((t) => getReservation(t, budget.reservationId as string));
      assert.ok(r);
      assert.equal(r.status, "ACTIVE");
      assert.equal(Number(r.amount), 4);
      assert.equal(r.accountId, accountId);
      assert.equal(r.consumedAt, null);
    });

    test("the reservation counts toward effective usage, so a second agent sees it", async () => {
      const e = await exposure();
      assert.equal(e.effectiveToday, 4, "the first approval is visible before any money moves");
    });

    test("a blocked decision reserves nothing", async () => {
      const body = await run("9.00", "commit");
      assert.equal(body.decision, "BLOCKED_PER_CALL_CAP");
      assert.equal((body.budget as Record<string, unknown>).economicClassification, "NO_AUTHORITY_GRANTED");
      assert.equal((body.budget as Record<string, unknown>).reservationId, null);
      assert.equal((await exposure()).reservedActiveToday, 4, "unchanged");
    });

    test("an escalated decision does not silently reserve executable authority", async () => {
      const before = await exposure();
      const body = await run("6.00", "commit");
      /**
       * The escalation safety gate now refuses this before it is served, because nothing on the
       * account path can reach a human yet. The engine verdict moves to `decisionOutcome`, and the
       * property this test exists for holds either way: a request awaiting human authority reserves
       * nothing. It was true when the decision was returned, and it is true when it is refused.
       */
      assert.equal(body.outcome, "APPROVAL_PATH_NOT_READY");
      assert.equal(body.decisionOutcome, "ESCALATED_THRESHOLD");
      assert.equal(body.servicePaymentSettled, false, "and no fee is taken for an outcome it cannot deliver");
      assert.deepEqual(await exposure(), before, "no budget is held for a request no human will see");
    });

    test("concurrent approvals cannot exceed the daily limit", async () => {
      /**
       * A 6.00 daily budget on its own policy, and two concurrent 4.00 requests.
       *
       * The amounts matter: 4.00 is below `escalateAbove` (5.00), so both would APPROVE and both would
       * RESERVE. 4 + 4 = 8 > 6, so exactly one must survive. An earlier version of this test used 6.00
       * and proved nothing — both escalated, and an escalated decision reserves nothing, so neither
       * could contend for capacity with the other.
       */
      const [a, b] = await Promise.all([
        run("4.00", "commit", "res-conc-a", TIGHT_POLICY_ID),
        run("4.00", "commit", "res-conc-b", TIGHT_POLICY_ID),
      ]);
      const outcomes = [a, b].map((x) => x.decision);
      assert.equal(
        outcomes.filter((o) => o === "APPROVED").length, 1,
        `exactly one may be approved against a shared budget: ${JSON.stringify(outcomes)}`,
      );
      assert.equal(
        outcomes.filter((o) => o === "BLOCKED_BUDGET").length, 1,
        "the other is refused by the budget rule, not by luck or by ordering",
      );

      const e = await exposure(TIGHT_PARTITION);
      assert.equal(e.reservedActiveToday, 4, "one hold, not two");
      assert.equal(e.settledToday, 0, "and still nothing spent");
    });

    test("the budget trace separates settled, reserved, proposed and effective", async () => {
      // Against the tight policy, whose ceiling is reachable.
      const e = await exposure(TIGHT_PARTITION);
      const body = await run("4.00", "rollback", "res-trace", TIGHT_POLICY_ID);
      const trace = (body.ruleTrace as Record<string, unknown>[]).find((r) => r.rule === "budget.daily");
      assert.ok(trace, "budget.daily ran");
      assert.equal(trace.settled, "0.00", "nothing has settled");
      assert.equal(trace.reservedActive, e.reservedActiveToday.toFixed(2), "authority held, reported separately");
      assert.equal(trace.proposedReservation, "4.00");
      assert.equal(trace.limit, "6.00");
      assert.equal(
        trace.effectiveAfter,
        (e.effectiveToday + 4).toFixed(2),
        "effective usage is settled + reserved + proposed, and the trace shows all three",
      );
    });

    // ── rollback ─────────────────────────────────────────────────────────────

    test("a rolled-back validation leaves no reservation", async () => {
      const before = await exposure();
      const body = await run("1.00", "rollback");
      assert.equal(body.outcome, "APPROVED_AUTOMATIC");
      assert.equal((body.budget as Record<string, unknown>).economicClassification, "RESERVED_AUTHORITY_NOT_SPEND");
      const after = await exposure();
      assert.deepEqual(after, before, "the hold was written and rolled back with the transaction");
    });

    // ── consumption ──────────────────────────────────────────────────────────

    test("a reservation is consumed once, at the settlement point, and settles the spend", async () => {
      const before = await exposure();
      const body = await run("1.00", "commit", "res-consume");
      const reservationId = (body.budget as Record<string, unknown>).reservationId as string;
      const intentHash = body.intentHash as Hex;
      const quoteDigest = (body.evidence as Record<string, unknown>).quoteDigest as Hex;
      const requesterRef = (body.evidence as Record<string, unknown>).requesterPrincipalRef as string;

      const args = {
        reservationId, accountId, intentHash, quoteDigest,
        requesterPrincipalRef: requesterRef, policyId: POLICY_ID, amount: "1.00",
        executionRef: "exec_1", settlementRef: "0xsettle", nowIso: new Date().toISOString(),
      };

      const first = await committing(async (t) => {
        const out = await consumeReservation(t, args);
        if (out.consumed) await recordSettledSpend(t, PARTITION, utcDayKey(Date.now()), "1.00");
        return out;
      });
      assert.equal(first.consumed, true);

      const e = await exposure();
      /**
       * The hold was created by this test's own run and then consumed, so reserved returns to where it
       * started while settled goes up by the same amount. That is the whole shape of the model:
       * capacity moves from reserved to settled, and only the settled column is money.
       */
      assert.equal(e.reservedActiveToday, before.reservedActiveToday, "the consumed hold stopped counting as reserved");
      assert.equal(e.settledToday, before.settledToday + 1, "money moved, and only now is it spend");
      assert.equal(e.effectiveToday, before.effectiveToday + 1, "effective usage rose by the settled amount");

      // A retry must not consume it twice, or double-count the settlement.
      const second = await committing((t) => consumeReservation(t, args));
      assert.equal(second.consumed, false);
      assert.equal(second.reason, "RESERVATION_CONSUMED");
    });

    test("another account cannot consume this account's reservation", async () => {
      const body = await run("1.00", "commit", "res-cross-account");
      const reservationId = (body.budget as Record<string, unknown>).reservationId as string;
      const out = await committing((t) =>
        consumeReservation(t, {
          reservationId, accountId: "acct_intruder", intentHash: body.intentHash as Hex,
          quoteDigest: (body.evidence as Record<string, unknown>).quoteDigest as Hex,
          requesterPrincipalRef: (body.evidence as Record<string, unknown>).requesterPrincipalRef as string,
          policyId: POLICY_ID, amount: "1.00", executionRef: "e", settlementRef: null,
          nowIso: new Date().toISOString(),
        }),
      );
      assert.equal(out.consumed, false);
      assert.equal(out.reason, "RESERVATION_BELONGS_TO_ANOTHER_ACCOUNT");
    });

    test("a 6.00 reservation cannot fund a 6.50 execution", async () => {
      const body = await run("1.00", "commit", "res-amount-bind");
      const reservationId = (body.budget as Record<string, unknown>).reservationId as string;
      const out = await committing((t) =>
        consumeReservation(t, {
          reservationId, accountId, intentHash: body.intentHash as Hex,
          quoteDigest: (body.evidence as Record<string, unknown>).quoteDigest as Hex,
          requesterPrincipalRef: (body.evidence as Record<string, unknown>).requesterPrincipalRef as string,
          policyId: POLICY_ID,
          amount: "1.50", // more than was authorised
          executionRef: "e", settlementRef: null, nowIso: new Date().toISOString(),
        }),
      );
      assert.equal(out.consumed, false);
      assert.equal(out.reason, "AMOUNT_MISMATCH");
    });

    test("a different intent cannot use this reservation", async () => {
      const body = await run("1.00", "commit", "res-intent-bind");
      const reservationId = (body.budget as Record<string, unknown>).reservationId as string;
      const out = await committing((t) =>
        consumeReservation(t, {
          reservationId, accountId,
          intentHash: `0x${"ab".repeat(32)}` as Hex,
          quoteDigest: (body.evidence as Record<string, unknown>).quoteDigest as Hex,
          requesterPrincipalRef: (body.evidence as Record<string, unknown>).requesterPrincipalRef as string,
          policyId: POLICY_ID, amount: "1.00", executionRef: "e", settlementRef: null,
          nowIso: new Date().toISOString(),
        }),
      );
      assert.equal(out.consumed, false);
      assert.equal(out.reason, "INTENT_MISMATCH");
    });

    test("a policy substitution is refused even though the ruleset hash is identical", async () => {
      const body = await run("1.00", "commit", "res-policy-bind");
      const reservationId = (body.budget as Record<string, unknown>).reservationId as string;
      const out = await committing((t) =>
        consumeReservation(t, {
          reservationId, accountId, intentHash: body.intentHash as Hex,
          quoteDigest: (body.evidence as Record<string, unknown>).quoteDigest as Hex,
          requesterPrincipalRef: (body.evidence as Record<string, unknown>).requesterPrincipalRef as string,
          policyId: "999999", // same owner, same rules, different policy
          amount: "1.00", executionRef: "e", settlementRef: null, nowIso: new Date().toISOString(),
        }),
      );
      assert.equal(out.consumed, false);
      assert.equal(out.reason, "POLICY_MISMATCH");
    });

    // ── release ──────────────────────────────────────────────────────────────

    test("a released reservation stops counting toward exposure and keeps its history", async () => {
      const body = await run("1.00", "commit", "res-release");
      const reservationId = (body.budget as Record<string, unknown>).reservationId as string;
      const before = await exposure();

      const released = await committing((t) =>
        releaseReservation(t, {
          reservationId, reason: "EXECUTION_FAILED_BEFORE_PAYMENT", nowIso: new Date().toISOString(),
        }),
      );
      assert.equal(released, true);

      const after = await exposure();
      assert.equal(after.reservedActiveToday, before.reservedActiveToday - 1, "capacity came back");

      const r = await tx((t) => getReservation(t, reservationId));
      assert.equal(r?.status, "RELEASED");
      assert.equal(r?.releaseReason, "EXECUTION_FAILED_BEFORE_PAYMENT");
      assert.ok(r?.releasedAt, "history retained, not deleted");
    });

    test("a released reservation cannot be released or consumed again", async () => {
      const body = await run("1.00", "commit", "res-release-twice");
      const reservationId = (body.budget as Record<string, unknown>).reservationId as string;
      const now = new Date().toISOString();
      assert.equal(await committing((t) => releaseReservation(t, { reservationId, reason: "USER_CANCELLED", nowIso: now })), true);
      assert.equal(await committing((t) => releaseReservation(t, { reservationId, reason: "USER_CANCELLED", nowIso: now })), false);

      const out = await committing((t) =>
        consumeReservation(t, {
          reservationId, accountId, intentHash: body.intentHash as Hex,
          quoteDigest: (body.evidence as Record<string, unknown>).quoteDigest as Hex,
          requesterPrincipalRef: (body.evidence as Record<string, unknown>).requesterPrincipalRef as string,
          policyId: POLICY_ID, amount: "1.00", executionRef: "e", settlementRef: null, nowIso: now,
        }),
      );
      assert.equal(out.consumed, false);
      assert.equal(out.reason, "RESERVATION_RELEASED");
    });

    test("a reservation row can never be deleted, and a terminal one cannot be reactivated", async () => {
      const body = await run("1.00", "commit", "res-permanence");
      const reservationId = (body.budget as Record<string, unknown>).reservationId as string;
      await committing((t) => releaseReservation(t, { reservationId, reason: "QUOTE_SUPERSEDED", status: "SUPERSEDED", nowIso: new Date().toISOString() }));

      await assert.rejects(
        () => pool.query("DELETE FROM untch_budget_reservations WHERE reservation_id = $1", [reservationId]),
        /rows are permanent/,
      );
      await assert.rejects(
        () => pool.query("UPDATE untch_budget_reservations SET status='ACTIVE' WHERE reservation_id = $1", [reservationId]),
        /cannot become ACTIVE|already SUPERSEDED/,
      );
      await assert.rejects(
        () => pool.query("UPDATE untch_budget_reservations SET amount = 99 WHERE reservation_id = $1", [reservationId]),
        /fixed at creation/,
      );
    });

    test("expiry releases the hold and stops it counting, even before a sweeper runs", async () => {
      // Written directly with a deadline already past — the handler refuses a past deadline, correctly.
      const past = new Date(Date.now() - 60_000).toISOString();
      await pool.query(
        `INSERT INTO untch_budget_reservations
           (reservation_id, account_id, policy_id, partition_key, decision_id, intent_id, intent_hash,
            quote_digest, requester_principal_ref, wallet_authority_ref, amount, asset, chain,
            recipient, provider, capability, day_key, status, expires_at)
         VALUES ('rsv_expired',$1,$2,$3,'dec_x','int_x',$4,$5,'ref','0xauth',2,'USDT0','eip155:196',
                 null,'untch','owned_work.demo',$6,'ACTIVE',$7)`,
        [accountId, POLICY_ID, PARTITION, `0x${"ee".repeat(32)}`, `0x${"ff".repeat(32)}`, utcDayKey(Date.now()), past],
      );

      const e = await exposure();
      assert.ok(!Number.isNaN(e.reservedActiveToday));
      const rows = await pool.query<{ n: string }>(
        `SELECT coalesce(sum(amount),0)::text n FROM untch_budget_reservations
          WHERE partition_key=$1 AND status='ACTIVE'`, [PARTITION]);
      assert.ok(
        Number(rows.rows[0]!.n) > e.reservedActiveToday,
        "the expired hold is still ACTIVE on the row but is already excluded from exposure",
      );

      const swept = await committing((t) => expireStaleReservations(t, new Date().toISOString()));
      assert.ok(swept >= 1);
      const r = await tx((t) => getReservation(t, "rsv_expired"));
      assert.equal(r?.status, "EXPIRED");
      assert.equal(r?.releaseReason, "AUTHORIZATION_EXPIRED");
    });

    // ── idempotency and cross-instance ───────────────────────────────────────

    test("one ACTIVE reservation per intent — a retry cannot reserve twice", async () => {
      const first = await run("1.00", "commit", "res-idempotent");
      assert.equal(first.outcome, "APPROVED_AUTOMATIC");
      const held = await tx((t) => reservationForIntent(t, PARTITION, first.intentHash as Hex));
      assert.ok(held, "the first call holds it");

      // Same idempotency key ⇒ same intent hash. The unique partial index refuses a second hold.
      const second = await run("1.00", "commit", "res-idempotent");
      assert.notEqual(second.outcome, "APPROVED_AUTOMATIC",
        "work authorised once must not reserve budget twice");
    });

    test("reservation state survives a restart and is visible to a second instance", async () => {
      const other = createPool(ownDatabaseUrl());
      try {
        const client = await other.connect();
        try {
          const e = await budgetExposure(client as never, PARTITION, utcDayKey(Date.now()), new Date().toISOString());
          assert.ok(e.reservedActiveToday > 0, "instance B sees instance A's holds");
          assert.ok(e.settledToday > 0, "and its settled spend");
        } finally {
          client.release();
        }
      } finally {
        await other.end();
      }
    });

    test("the x402 service fee is never part of the governed reservation", async () => {
      const body = await run("1.00", "rollback", "res-fee-separation");
      const budget = body.budget as Record<string, unknown>;
      // 0.05 is the fee for the preflight itself. It is Untch revenue and appears nowhere in the
      // governed numbers — the two are different economic facts and merging them would describe a
      // payment that did not occur.
      assert.equal(budget.proposedReservation, "1.00");
      assert.match(String(budget.note), /not money spent/);
      assert.match(String(budget.note), /x402 service fee/);
      assert.equal(JSON.stringify(budget).includes("0.05"), false, "the fee is not in the budget block");
    });
  },
);
