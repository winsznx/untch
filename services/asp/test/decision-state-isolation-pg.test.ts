import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { keccak256, toHex } from "viem";
import {
  PgAccountStore,
  createPool,
  decisionStateCounts,
  newWalletBindingId,
  type Pool,
} from "@untch/consumer-core";
import { PgPolicyRepo, PolicyProvider, type StoredPolicy } from "@untch/policy-store";
import { ledgerPartitionKey } from "@untch/policy-engine";
import { hashCanonicalJson } from "@untch/canon";
import { findOwnedService } from "@untch/owned-work";
import { handlePublicPreflight, type PublicPreflightDeps } from "../src/public-dto/preflight";
import { mintAccountSession } from "../src/consumer/account-auth";
import { InMemoryIntentStore } from "../src/ledger-state";
import {
  ExecutionDependencyLeakError,
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
    ): Promise<Record<string, unknown>> => {
      const result = await handlePublicPreflight(
        body,
        `Bearer ${token}`,
        { ...publicDeps, evidenceTx: mode === "commit" ? committing : rollingBack },
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
      const first = [
        await run(request("4.00"), "rollback"),
        await run(request("6.00"), "rollback"),
        await run(request("9.00"), "rollback"),
      ].map((b) => b.decision);
      const second = [
        await run(request("4.00"), "rollback"),
        await run(request("6.00"), "rollback"),
        await run(request("9.00"), "rollback"),
      ].map((b) => b.decision);

      assert.deepEqual(second, first);
      assert.deepEqual(first, ["APPROVED", "ESCALATED_THRESHOLD", "BLOCKED_PER_CALL_CAP"]);
      assert.deepEqual(await counts(), { recentIntents: 0, rateTicks: 0, replayMarkers: 0, serviceCalls: 0, activeReserved: "0", settledSpend: "0" });
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
      assert.deepEqual(body.routeExecution, {
        routeExecutionProfile: "decision_only",
        providerExecutionReachable: false,
        paymentExecutionReachable: false,
        deliveryExecutionReachable: false,
      });
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
      assert.deepEqual(routeReachability("/consumer/execute"), {
        routeExecutionProfile: "provider_execution",
        providerExecutionReachable: true,
        paymentExecutionReachable: true,
        deliveryExecutionReachable: true,
      });
      // An unclassified route reports as unclassified rather than defaulting to the safe-sounding value.
      assert.equal(routeReachability("/not/classified"), null);
    });
  },
);
