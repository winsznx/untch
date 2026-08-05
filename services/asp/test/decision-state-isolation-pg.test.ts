import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { keccak256, toHex } from "viem";
import {
  PgAccountStore,
  PgServiceCallStore,
  createPool,
  finalizeSettlement,
  decisionStateCounts,
  newWalletBindingId,
  type Pool,
} from "@untch/consumer-core";
import { PgPolicyRepo, PolicyProvider, type StoredPolicy } from "@untch/policy-store";
import { ledgerPartitionKey } from "@untch/policy-engine";
import { hashCanonicalJson } from "@untch/canon";
import { findOwnedService } from "@untch/owned-work";
import { handlePublicPreflight, type PublicPreflightDeps } from "../src/public-dto/preflight";
import { parseVerifiedPaymentAuthorization } from "../src/consumer/payment-authorization";
import { mintAccountSession } from "../src/consumer/account-auth";
import { InMemoryIntentStore } from "../src/ledger-state";
import {
  APPROVAL_PATH_READY,
  ExecutionDependencyLeakError,
  escalationRefusedForUnreadyPath,
  narrowToDecisionOnly,
  routeReachability,
  type DecisionOnlyDeps,
} from "../src/route-profiles";

/**
 * A ROLLED-BACK VALIDATION MUST NOT CHANGE A LATER DECISION.
 *
 * WHAT HAPPENED, IN PRODUCTION, ON 2026-08-03
 *
 * The always-rollback validation route ran a 4.00 decision. It rolled back every database write
 * perfectly. Minutes later a genuine 4.00 request returned BLOCKED_DUPLICATE, because the engine had
 * committed the duplicate marker, the daily spend and the rate tick into a PROCESS SINGLETON —
 * outside any transaction, where no rollback could reach it. Had that been the paid call, 0.05 USDT0
 * would have bought the system's own rehearsal blocking the real thing.
 *
 * It is the same defect as the escalation leak one layer down. That one was "a rolled-back validation
 * must not message a human". This is "a rolled-back validation must not change a later decision".
 *
 * Every test below drives the REAL `handlePublicPreflight` against a REAL Postgres, through a
 * transaction the test controls — committing where production commits and rolling back where
 * validation rolls back. Nothing is simulated: the same mapper, resolver, policy loader, canonicaliser,
 * evaluator, assembler and constraints run in both cases.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_decision_isolation";
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..", "..", "packages");

const WALLET: Address = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const SECRET = "decision-state-isolation-test-secret";
const POLICY_ID = "778001";
/**
 * ONE deadline for the whole suite, not `Date.now() + 1h` per request.
 *
 * The intent hash commits the deadline at second resolution. A per-call deadline meant two requests
 * with the same idempotency key were identical only when they happened to land inside one second —
 * true on a fast local machine, false on CI, where the "same key, same identity" assertion failed on
 * a boundary crossing. The deadline is an input the caller controls, so holding it fixed is what
 * makes "the same request" mean the same bytes.
 */
const FIXED_DEADLINE = new Date(Date.now() + 6 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");

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
    for (const f of names) {
      if (f.endsWith(".sql")) files.push({ name: f, sql: readFileSync(join(dir, f), "utf8") });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The ruleset. `duplicates` keys on the same tuple production uses, and the TTL is long enough that
 * a duplicate inside one test run is a real duplicate rather than a timing accident.
 */
function rules(): StoredPolicy["rules"] {
  return {
    budgets: { daily: 100, token: "USDT0" },
    perCallCap: 8.0,
    onPerCallCapExceeded: "BLOCK",
    escalateAbove: 5.0,
    categories: { allow: [], deny: [] },
    recipients: { allow: [], deny: [] },
    agents: { allowWorkerIds: [], denyWorkerIds: [] },
    duplicates: { ttlMin: 60, keys: ["provider", "capability", "amount", "recipient"] },
    cooldowns: { sameServiceMin: 0 },
    rateLimit: { callsPerHour: 60 },
    expiry: "2027-12-31T00:00:00Z",
  } as unknown as StoredPolicy["rules"];
}

describe(
  "a rolled-back validation cannot change a later decision",
  { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" },
  () => {
    let pool: Pool;
    let accounts: PgAccountStore;
    let publicDeps: PublicPreflightDeps;
    let decisionDeps: DecisionOnlyDeps;
    let accountId: string;
    let token: string;
    const partitionKey = ledgerPartitionKey(POLICY_ID);

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

      accounts = new PgAccountStore(pool);
      const account = await accounts.createAccount({ by: "test" });
      accountId = account.accountId;
      const bindingId = newWalletBindingId();
      await accounts.linkWallet({
        bindingId,
        accountId,
        chainKind: "evm",
        address: WALLET,
        role: "primary",
        proofKind: "siwe",
        proofRef: "test-nonce",
        verifiedAt: "2026-08-03T00:00:00.000Z",
        walletProvider: "okx-agentic-wallet",
        scopes: ["identity", "policy-authority"],
        by: "siwe",
      });
      await accounts.setPrimaryWallet({ accountId, bindingId, by: "test" });

      const repo = new PgPolicyRepo(pool as never);
      await repo.insert({
        id: POLICY_ID,
        owner: WALLET,
        agentId: WALLET,
        version: 1,
        status: "ACTIVE",
        policyHash: hashCanonicalJson(rules() as unknown as Record<string, unknown>),
        expiry: Math.floor(Date.parse("2027-12-31T00:00:00Z") / 1000),
        onchainRef: { chainId: 196, txHash: keccak256(toHex("isolation-test")), blockNumber: 1 },
        rules: rules(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as StoredPolicy);
      await accounts.linkPolicy({ accountId, policyId: POLICY_ID, linkedBy: "registered", by: "test" });
      await accounts.setDefaultPolicy({ accountId, policyId: POLICY_ID, by: "test" });

      token = mintAccountSession({
        secret: SECRET,
        accountId,
        address: WALLET,
        bindingId,
        scopes: ["identity", "policy-authority"],
        nowMs: Date.now(),
      }).token;

      publicDeps = {
        accounts,
        policies: new PolicyProvider(repo),
        ownedService: (p, c) => findOwnedService(p, c),
        network: { token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", symbol: "USDT0", decimals: 6 },
        sessionSecret: SECRET,
        executionEnabled: true, // The global flag is ON, exactly as production has it.
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

    /** A transaction that COMMITS — what the paid route does. */
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

    /** A transaction that ALWAYS rolls back — what the validation route does. */
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

    let seq = 0;
    /**
     * Readiness passed explicitly, for the cases whose subject is the CLOSED gate.
     *
     * `APPROVAL_PATH_READY` is true in this build. The refusal it replaced is the fallback an operator
     * has if the path ever has to be shut again, and a fallback nothing exercises is one that has
     * quietly stopped working — so those cases keep running, against a path told it is closed.
     */
    const CLOSED = { approvalPathReady: false } as const;

    const request = (amount: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
      provider: "untch",
      capability: "owned_work.demo",
      task: `isolation test ${amount}`,
      maxSpend: amount,
      currency: "USDT0",
      deadline: FIXED_DEADLINE,
      idempotencyKey: `iso-${amount}-${++seq}`,
      ...over,
    });

    const run = async (
      body: Record<string, unknown>,
      mode: "commit" | "rollback",
      over: Partial<PublicPreflightDeps> = {},
    ): Promise<Record<string, unknown>> => {
      const result = await handlePublicPreflight(
        body,
        `Bearer ${token}`,
        { ...publicDeps, evidenceTx: mode === "commit" ? committing : rollingBack, ...over },
        decisionDeps,
      );
      const bodyOut = result.body as Record<string, unknown>;
      if (process.env.ISO_DEBUG && bodyOut.outcome === "DECISION_EVIDENCE_INCOMPLETE") {
        console.error("[iso-debug]", bodyOut.message);
      }
      return bodyOut;
    };

    const counts = async () => {
      const client = await pool.connect();
      try {
        return await decisionStateCounts(client as never, partitionKey);
      } finally {
        client.release();
      }
    };

    // ── validation changes nothing ────────────────────────────────────────────

    test("a rolled-back validation creates no duplicate marker, no rate tick, no budget, no recent intent", async () => {
      const before = await counts();
      const body = await run(request("4.00"), "rollback");

      assert.equal(body.outcome, "APPROVED_AUTOMATIC", "the decision itself is real");
      assert.equal((body.decisionState as Record<string, unknown>).effectsApplied, true, "effects WERE proposed and written…");

      const after = await counts();
      // …and then rolled back with the transaction that wrote them.
      assert.deepEqual(after, before, "a rolled-back validation leaves the decision state untouched");
      assert.equal(after.recentIntents, 0);
      assert.equal(after.rateTicks, 0);
      assert.equal(after.replayMarkers, 0);
      assert.equal(after.activeReserved, "0");
      assert.equal(after.settledSpend, "0");
    });

    test("validation does not mutate a process singleton — there is no longer one to mutate", async () => {
      // The engine's window now comes from Postgres inside the caller's transaction. The only way to
      // observe state is to read the tables, and they are empty after a rollback. A singleton would
      // have survived it, which is exactly how the production defect went unnoticed.
      const after = await counts();
      assert.deepEqual(after, { recentIntents: 0, rateTicks: 0, replayMarkers: 0, serviceCalls: 0, activeReserved: "0", settledSpend: "0" });
    });

    /** THE REGRESSION. This is the exact sequence that failed in production. */
    test("an immediate readiness evaluation after a validation is NOT blocked", async () => {
      const validation = await run(request("4.00"), "rollback");
      assert.equal(validation.outcome, "APPROVED_AUTOMATIC");

      const readiness = await run(request("4.00"), "rollback");
      assert.equal(
        readiness.outcome,
        "APPROVED_AUTOMATIC",
        "the readiness capture must see the world as the validation found it",
      );
      assert.notEqual(readiness.decision, "BLOCKED_DUPLICATE", "this is the production defect, reproduced");
    });

    test("the boundary proof run twice produces identical decisions", async () => {
      /**
       * Run against the CLOSED gate, which is what keeps this test about the ENGINE.
       *
       * With the path open a 6.00 continues into the escalated branch, and on this bundle — which has
       * no service-call store — that refuses for a completely different reason. The verdict would then
       * be absent from the body and this would be measuring the writer rather than determinism. The
       * closed gate surfaces the engine's verdict on `decisionOutcome`, which is the value under test.
       */
      const verdict = (b: Record<string, unknown>): unknown => b.decision ?? b.decisionOutcome;
      const first = [
        await run(request("4.00"), "rollback", CLOSED),
        await run(request("6.00"), "rollback", CLOSED),
        await run(request("9.00"), "rollback", CLOSED),
      ].map(verdict);
      const second = [
        await run(request("4.00"), "rollback", CLOSED),
        await run(request("6.00"), "rollback", CLOSED),
        await run(request("9.00"), "rollback", CLOSED),
      ].map(verdict);

      assert.deepEqual(second, first);
      assert.deepEqual(first, ["APPROVED", "ESCALATED_THRESHOLD", "BLOCKED_PER_CALL_CAP"]);
      assert.deepEqual(await counts(), { recentIntents: 0, rateTicks: 0, replayMarkers: 0, serviceCalls: 0, activeReserved: "0", settledSpend: "0" });
    });

    /**
     * THE OTHER HALF OF ACTIVATION.
     *
     * The closed gate is proven above. This is what replaces it: with the path open, an escalated
     * decision no longer refuses — it raises a PROVISIONAL request against the service call that
     * bought it, and stays unactionable until an authority confirms the fee settled.
     *
     * `preflight-escalation-pg` proves the WRITER in isolation. This drives the real handler, which is
     * the path activation actually opened, and the one nothing exercised end to end before now.
     */
    describe("with the path open, an escalated decision raises a provisional request", () => {
      const PAYER = "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64";
      const PAY_TO = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
      const TOKEN_ADDR = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
      let openSeq = 0;

      const authFor = (nonce: string) =>
        parseVerifiedPaymentAuthorization(
          Buffer.from(
            JSON.stringify({
              x402Version: 1,
              accepted: { scheme: "exact", network: "eip155:196", asset: TOKEN_ADDR, amount: "50000", payTo: PAY_TO },
              payload: {
                signature: "0xsignaturethatmustnevertravel",
                authorization: {
                  from: PAYER,
                  to: PAY_TO,
                  value: "50000",
                  validAfter: "0",
                  validBefore: "99999999999",
                  nonce,
                },
              },
            }),
            "utf8",
          ).toString("base64"),
          { chainId: 196 },
        );

      const escalate = async (idempotencyKey: string): Promise<{ body: Record<string, unknown>; nonce: string }> => {
        openSeq += 1;
        const nonce = `0xopen${String(openSeq).padStart(4, "0")}${"f".repeat(51)}`;
        const auth = authFor(nonce);
        assert.ok(auth);
        const result = await handlePublicPreflight(
          request("6.00", { idempotencyKey }),
          `Bearer ${token}`,
          { ...publicDeps, evidenceTx: committing, serviceCalls: new PgServiceCallStore(pool) },
          decisionDeps,
          auth,
        );
        return { body: result.body as Record<string, unknown>, nonce };
      };

      const one = async (sql: string, params: readonly unknown[] = []): Promise<number> => {
        const { rows } = await pool.query<{ n: string }>(sql, params as never);
        return Number(rows[0]!.n);
      };

      test("it creates the service call, the attempt and one PROVISIONAL request, and reserves nothing", async () => {
        const reservationsBefore = await one(`SELECT count(*)::text n FROM untch_budget_reservations`);
        const { body, nonce } = await escalate("open-escalated");

        assert.notEqual(body.outcome, "APPROVAL_PATH_NOT_READY", "the gate is open in this build");
        assert.equal(body.decision ?? body.decisionOutcome, "ESCALATED_THRESHOLD");

        const requests = await one(
          `SELECT count(*)::text n FROM untch_approval_requests WHERE state = 'PROVISIONAL' AND amount = '6.00'`,
        );
        assert.equal(requests, 1, "exactly one provisional request");

        const attempts = await one(
          `SELECT count(*)::text n FROM untch_x402_payment_attempts WHERE authorization_nonce = $1`,
          [nonce],
        );
        assert.equal(attempts, 1, "the attempt is bound to the exact nonce that paid");

        assert.equal(
          await one(`SELECT count(*)::text n FROM untch_budget_reservations`),
          reservationsBefore,
          "a request nobody has answered reserves nothing",
        );
      });

      /**
       * The window that makes the whole model safe: it is raised, it is not actionable, and nobody has
       * been told. Enqueuing before the fee is confirmed would promise a human something that might
       * never have been paid for.
       */
      test("nothing is enqueued and nothing is deliverable before settlement is confirmed", async () => {
        await escalate("open-no-outbox");
        const { rows } = await pool.query<{ approval_request_id: string }>(
          `SELECT approval_request_id FROM untch_approval_requests WHERE state = 'PROVISIONAL' ORDER BY created_at DESC LIMIT 1`,
        );
        const id = rows[0]!.approval_request_id;
        assert.equal(
          await one(`SELECT count(*)::text n FROM untch_approval_outbox WHERE approval_request_id = $1`, [id]),
          0,
          "no outbox event before the fee is confirmed",
        );
        assert.equal(
          await one(`SELECT count(*)::text n FROM untch_approval_deliveries WHERE approval_request_id = $1`, [id]),
          0,
          "and nothing deliverable",
        );
      });

      test("authoritative confirmation moves it to PENDING and enqueues exactly one event", async () => {
        const { nonce } = await escalate("open-activation");
        const { rows } = await pool.query<{ approval_request_id: string; service_call_id: string }>(
          `SELECT approval_request_id, service_call_id FROM untch_approval_requests
            WHERE state = 'PROVISIONAL' ORDER BY created_at DESC LIMIT 1`,
        );
        const { approval_request_id: id, service_call_id: callId } = rows[0]!;

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const outcome = await finalizeSettlement(client as never, {
            serviceCallId: callId,
            evidence: {
              kind: "CONFIRMED",
              source: "facilitator_settle_status",
              transactionHash: `0xtxopen${openSeq}`,
              paymentId: null,
              terms: {
                authorizationNonce: nonce,
                payer: PAYER,
                token: TOKEN_ADDR,
                amount: "50000",
                payTo: PAY_TO,
                chain: "eip155:196",
              },
            },
          });
          await client.query("COMMIT");
          assert.equal(outcome.outcome, "ACTIVATED");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }

        const { rows: after } = await pool.query<{ state: string }>(
          `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`,
          [id],
        );
        assert.equal(after[0]!.state, "PENDING", "confirmed settlement is what makes it answerable");
        assert.equal(
          await one(
            `SELECT count(*)::text n FROM untch_approval_outbox WHERE approval_request_id = $1 AND name = 'approval.request.ready.v1'`,
            [id],
          ),
          1,
          "exactly one event, so one message reaches one human",
        );
      });
    });

    test("a blocked decision proposes no effects at all", async () => {
      const body = await run(request("9.00"), "commit");
      assert.equal(body.decision, "BLOCKED_PER_CALL_CAP");
      assert.equal((body.decisionState as Record<string, unknown>).effectsApplied, false);
      const after = await counts();
      assert.equal(after.recentIntents, 0, "a blocked intent is not a duplicate later requests are measured against");
      assert.equal(after.activeReserved, "0", "a blocked intent reserves nothing");
    });

    // ── production DOES commit ────────────────────────────────────────────────

    test("a committed approval records the duplicate marker, a RESERVATION, the tick and the replay marker", async () => {
      const body = await run(request("4.00"), "commit");
      assert.equal(body.outcome, "APPROVED_AUTOMATIC");

      const after = await counts();
      assert.equal(after.recentIntents, 1);
      assert.equal(after.rateTicks, 1);
      assert.equal(after.replayMarkers, 1);
      // The approval RESERVED 4.00. It did not spend it: no provider ran and nothing settled.
      assert.equal(Number(after.activeReserved), 4, "authority reserved");
      assert.equal(Number(after.settledSpend), 0, "and nothing settled");
    });

    test("a second committed intent for the same tuple is blocked, per policy", async () => {
      const body = await run(request("4.00"), "commit");
      assert.equal(body.decision, "BLOCKED_DUPLICATE", "the duplicate rule now has real, durable state to read");
      const after = await counts();
      assert.equal(after.recentIntents, 1, "and the blocked one added nothing");
    });

    test("committed duplicate state survives a process restart — it is not in this process", async () => {
      // A second pool is a second client with its own memory. The state is in Postgres, so it sees
      // exactly what the first one committed. The singleton could not have done this.
      const other = createPool(ownDatabaseUrl());
      try {
        const client = await other.connect();
        try {
          const state = await decisionStateCounts(client as never, partitionKey);
          assert.equal(state.recentIntents, 1);
          assert.equal(state.replayMarkers, 1);
        } finally {
          client.release();
        }
      } finally {
        await other.end();
      }
    });

    test("two ASP instances observe the same duplicate state", async () => {
      // A genuinely separate dependency graph — its own pool, its own intent store, its own provider.
      const otherPool = createPool(ownDatabaseUrl());
      try {
        const otherRepo = new PgPolicyRepo(otherPool as never);
        const otherDecisionDeps = narrowToDecisionOnly({
          policyProvider: new PolicyProvider(otherRepo),
          intentStore: new InMemoryIntentStore(),
          scoreDataSource: null,
        });
        const otherCommitting = async <T,>(fn: (tx: never) => Promise<T>): Promise<T> => {
          const client = await otherPool.connect();
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

        const result = await handlePublicPreflight(
          request("4.00"),
          `Bearer ${token}`,
          { ...publicDeps, accounts: new PgAccountStore(otherPool), policies: new PolicyProvider(otherRepo), evidenceTx: otherCommitting },
          otherDecisionDeps,
        );
        assert.equal(
          (result.body as Record<string, unknown>).decision,
          "BLOCKED_DUPLICATE",
          "instance B must see the duplicate instance A committed",
        );
      } finally {
        await otherPool.end();
      }
    });

    test("concurrent identical requests cannot both commit", async () => {
      // Same idempotency key ⇒ same nonce ⇒ same intent hash. The advisory lock serialises them and
      // the replay-marker PRIMARY KEY is the backstop if the lock were ever removed.
      const shared = request("3.00", { idempotencyKey: "iso-concurrent-fixed" });
      const [a, b] = await Promise.all([
        run({ ...shared }, "commit").catch((e: Error) => ({ error: e.message })),
        run({ ...shared }, "commit").catch((e: Error) => ({ error: e.message })),
      ]);

      const outcomes = [a, b].map((x) => (x as Record<string, unknown>).outcome ?? "REFUSED");
      const approved = outcomes.filter((o) => o === "APPROVED_AUTOMATIC").length;
      assert.equal(approved, 1, `exactly one may commit; got ${JSON.stringify(outcomes)}`);

      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ n: string }>(
          "SELECT count(*)::text n FROM untch_decision_replay_markers WHERE partition_key = $1 AND intent_hash = $2",
          [partitionKey, (a as Record<string, unknown>).intentHash ?? (b as Record<string, unknown>).intentHash],
        );
        assert.equal(rows[0]!.n, "1", "one committed decision per (partition, intentHash)");
      } finally {
        client.release();
      }
    });

    test("the same idempotency key resolves to one intent identity", async () => {
      const key = "iso-idempotent-identity";
      const first = await run(request("2.00", { idempotencyKey: key }), "rollback");
      const second = await run(request("2.00", { idempotencyKey: key }), "rollback");
      assert.equal(second.intentHash, first.intentHash, "one logical request, one intent hash");
      const ev1 = first.evidence as Record<string, unknown>;
      const ev2 = second.evidence as Record<string, unknown>;
      assert.equal(ev2.quoteDigest, ev1.quoteDigest, "and one quote digest");
    });

    test("a different idempotency key produces a distinct identity for the same terms", async () => {
      const a = await run(request("2.00", { idempotencyKey: "iso-nonce-a" }), "rollback");
      const b = await run(request("2.00", { idempotencyKey: "iso-nonce-b" }), "rollback");
      assert.notEqual(b.intentHash, a.intentHash);
      assert.notEqual(
        (b.evidence as Record<string, unknown>).quoteDigest,
        (a.evidence as Record<string, unknown>).quoteDigest,
      );
    });

    test("rollback removes EVERY decision effect, not merely the evidence row", async () => {
      const before = await counts();
      const client = await pool.connect();
      let evidenceRows = 0;
      try {
        const { rows } = await client.query<{ n: string }>("SELECT count(*)::text n FROM untch_decision_evidence");
        evidenceRows = Number(rows[0]!.n);
      } finally {
        client.release();
      }

      await run(request("4.50"), "rollback");

      const after = await counts();
      assert.deepEqual(after, before);
      const client2 = await pool.connect();
      try {
        const { rows } = await client2.query<{ n: string }>("SELECT count(*)::text n FROM untch_decision_evidence");
        assert.equal(Number(rows[0]!.n), evidenceRows, "and the evidence row went with it");
      } finally {
        client2.release();
      }
    });

    // ── the route profile ─────────────────────────────────────────────────────

    test("the decision route reports that it cannot reach an executor, while the global flag is ON", async () => {
      assert.equal(publicDeps.executionEnabled, true, "the global flag is true in this suite, as in production");
      const body = await run(request("4.00"), "rollback");
      const re = body.routeExecution as Record<string, unknown>;
      assert.equal(re.routeExecutionProfile, "decision_only");
      assert.equal(re.providerExecutionReachable, false);
      assert.equal(re.paymentExecutionReachable, false);
      assert.equal(re.deliveryExecutionReachable, false);
      assert.equal(re.providerDeliveryExecutionReachable, false);
      assert.equal(re.directChannelGatewayReachable, false);
    });

    test("a decision_only bundle carrying an executor is refused at runtime, by name", async () => {
      assert.throws(
        () =>
          narrowToDecisionOnly({
            policyProvider: publicDeps.policies as never,
            intentStore: new InMemoryIntentStore(),
            // The exact dependency whose presence caused the escalation leak.
            escalationGateway: { onEscalated: async () => undefined },
          } as never),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionDependencyLeakError);
          assert.deepEqual(err.leaked, ["escalationGateway"]);
          return true;
        },
      );
    });

    test("a provider_execution route still declares full reach, so the profile is not vacuous", () => {
      const pe = routeReachability("/consumer/execute")!;
      assert.equal(pe.routeExecutionProfile, "provider_execution");
      assert.equal(pe.providerExecutionReachable, true);
      assert.equal(pe.paymentExecutionReachable, true);
      assert.equal(pe.providerDeliveryExecutionReachable, true);
      // The alias tracks provider delivery exactly, never a widened OR.
      assert.equal(pe.deliveryExecutionReachable, pe.providerDeliveryExecutionReachable);
      // An unclassified route reports as unclassified rather than defaulting to the safe-sounding value.
      assert.equal(routeReachability("/not/classified"), null);
    });

    /**
     * AN ESCALATION THAT CANNOT REACH A HUMAN MUST NOT BE SOLD.
     *
     * PR #65 moved the account route onto an inline decision transaction wired with `DecisionOnlyDeps`,
     * which correctly cannot name a channel gateway — and in doing so removed the only call site that
     * created an escalation. So an `ESCALATED_THRESHOLD` decision on the paid V3 account path recorded
     * evidence and reached nobody.
     *
     * Returning 200 would take 0.05 USDT0 for a promise the service cannot keep. The gate refuses from
     * inside the transaction, so the request stays eligible for the moment the approval path exists.
     *
     * THE PATH IS NOW OPEN, AND THIS BLOCK STILL RUNS.
     *
     * `APPROVAL_PATH_READY` is true in this build, so every case below passes readiness explicitly as
     * false. That is not a workaround for a stale test: the refusal is the fallback an operator has if
     * the path ever has to be closed again, and a fallback nothing exercises is one that has quietly
     * stopped working. Deleting these would have traded a proven behaviour for an assumed one.
     */
    describe("an escalated account-path decision refuses rather than charging, when the path is closed", () => {
      test("6.00 evaluates to ESCALATED_THRESHOLD and is refused with APPROVAL_PATH_NOT_READY", async () => {
        const body = await run(request("6.00", { idempotencyKey: "gate-escalated" }), "commit", CLOSED);
        assert.equal(body.outcome, "APPROVAL_PATH_NOT_READY");
        assert.equal(body.decisionOutcome, "ESCALATED_THRESHOLD", "the engine still decided, and says so");
        assert.equal(body.approvalPathAvailable, false);
        assert.equal(body.servicePaymentSettled, false);
        assert.equal(body.paymentConsumed, false);
        assert.equal(body.retryable, true);
        assert.equal(body.retryAfterApprovalPathActivation, true);
        assert.equal(body.humanNotified, false, "it must never imply somebody was told");
        assert.equal(body.decisionPersisted, false);
      });

      /**
       * The status and the headers carry meaning the body cannot. 503 is what keeps the x402
       * middleware from settling, since it only settles on 2xx, so asserting the body alone would
       * leave the actual payment safety untested.
       */
      test("it answers 503 with a backoff hint and is never cached", async () => {
        const result = await handlePublicPreflight(
          request("6.00", { idempotencyKey: "gate-escalated-headers" }),
          `Bearer ${token}`,
          { ...publicDeps, evidenceTx: committing, ...CLOSED },
          decisionDeps,
        );
        assert.equal(result.status, 503, "non-2xx is what stops x402 from settling");
        assert.equal(result.headers?.["Retry-After"], "300");
        assert.equal(result.headers?.["Cache-Control"], "no-store");
      });

    const tableCount = async (t: string): Promise<number> => {
      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text n FROM ${t}`);
        return Number(rows[0]!.n);
      } finally {
        client.release();
      }
    };

      test("the refusal commits no durable state at all", async () => {
        const before = await counts();
        const beforeRequests = await tableCount("untch_approval_requests");
        const beforeTables: Record<string, number> = {};
        for (const t of ["untch_decision_evidence", "untch_budget_reservations", "escalations"]) {
          beforeTables[t] = await tableCount(t);
        }
        const body = await run(request("6.00", { idempotencyKey: "gate-no-state" }), "commit", CLOSED);
        assert.equal(body.outcome, "APPROVAL_PATH_NOT_READY");

        const after = await counts();
        assert.deepEqual(after, before, "no replay marker, recent intent, rate tick, cooldown or reservation");

        // Deltas, not absolutes: earlier tests in this suite legitimately committed rows, and the
        // claim here is that the REFUSAL adds nothing, not that the database is empty.
        for (const table of ["untch_decision_evidence", "untch_budget_reservations", "escalations"]) {
          assert.equal(await tableCount(table), beforeTables[table], `${table} unchanged by a refused escalation`);
        }
        /**
         * A DELTA, now that the suite legitimately raises requests through the open path above. The
         * claim was never "the table is empty" — it is that a REFUSED escalation adds nothing to it.
         */
        assert.equal(
          await tableCount("untch_approval_requests"),
          beforeRequests,
          "a refused escalation creates no approval object",
        );
      });

      test("the same request stays eligible immediately afterwards", async () => {
        // The whole reason the gate rolls back: an outage must not poison the duplicate window for a
        // request the caller will legitimately retry once approval works.
        const before = await counts();
        const first = await run(request("6.00", { idempotencyKey: "gate-retryable" }), "commit", CLOSED);
        const second = await run(request("6.00", { idempotencyKey: "gate-retryable" }), "commit", CLOSED);
        assert.equal(first.outcome, "APPROVAL_PATH_NOT_READY");
        assert.equal(second.outcome, "APPROVAL_PATH_NOT_READY");
        assert.equal(second.decisionOutcome, "ESCALATED_THRESHOLD", "not BLOCKED_DUPLICATE");
        assert.deepEqual(await counts(), before, "two refusals leave the window exactly as they found it");
      });

      test("an approved decision is unaffected and still commits", async () => {
        // A fresh amount, so this is not a duplicate of anything earlier in the suite.
        const before = await counts();
        const body = await run(request("3.25", { idempotencyKey: "gate-approved-unchanged" }), "commit", CLOSED);
        assert.equal(body.outcome, "APPROVED_AUTOMATIC", "the gate is for escalations only");
        assert.equal((body.budget as Record<string, unknown>).economicClassification, "RESERVED_AUTHORITY_NOT_SPEND");
        const after = await counts();
        assert.equal(after.replayMarkers, before.replayMarkers + 1, "the approved path still records its decision");
        assert.equal(Number(after.activeReserved), Number(before.activeReserved) + 3.25);
      });

      test("a blocked decision keeps its existing truthful semantics", async () => {
        const body = await run(request("9.50", { idempotencyKey: "gate-blocked-unchanged" }), "commit", CLOSED);
        assert.equal(body.outcome, "BLOCKED");
        assert.equal(body.decision, "BLOCKED_PER_CALL_CAP");
        assert.notEqual(body.outcome, "APPROVAL_PATH_NOT_READY", "the gate is for escalations only");
      });

      /**
       * The manifest now advertises persistence, and must still advertise nothing else. The fields
       * that stay false are the ones a reader could mistake for permission to move money.
       */
      test("the manifest advertises exactly what activation turned on, and nothing more", () => {
        const r = routeReachability("/preflight_payment")!;
        assert.equal(APPROVAL_PATH_READY, true, "this build has the approval path activated");
        assert.equal(r.approvalStatePersistenceReachable, true);
        assert.equal(r.approvalNotificationEnqueueReachable, true);
        /** The route ENQUEUES. The Discord call happens in the worker, after commit. */
        assert.equal(r.directChannelGatewayReachable, false);
        assert.equal(r.providerExecutionReachable, false);
        assert.equal(r.paymentExecutionReachable, false);
        // The deprecated alias means provider delivery ONLY, never the OR with notification delivery.
        assert.equal(r.deliveryExecutionReachable, r.providerDeliveryExecutionReachable);
        assert.equal(r.providerDeliveryExecutionReachable, false);
      });

      /**
       * The gate as a pure function, so both states stay proven whatever the constant currently is.
       */
      test("the gate refuses an escalation only while the path is closed", () => {
        for (const decision of ["ESCALATED_THRESHOLD", "ESCALATED_VENDOR_RISK"]) {
          assert.equal(escalationRefusedForUnreadyPath(false, decision), true, `closed must refuse ${decision}`);
          assert.equal(escalationRefusedForUnreadyPath(true, decision), false, `open must allow ${decision}`);
        }
        for (const decision of ["APPROVED_AUTOMATIC", "BLOCKED_PER_CALL_CAP"]) {
          assert.equal(escalationRefusedForUnreadyPath(false, decision), false, "the gate is for escalations only");
          assert.equal(escalationRefusedForUnreadyPath(true, decision), false);
        }
      });
    });
  },
);
