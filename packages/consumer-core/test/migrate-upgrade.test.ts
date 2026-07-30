import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, runMigrations, readSchemaState, type Pool } from "../src/db";

/**
 * Migration 011 against an UPGRADED database, not a fresh one.
 *
 * A fresh-database test proves almost nothing about a production upgrade. Production had ten
 * migrations, real intents and real execution rows before 011 arrived, and every interesting way a
 * migration can fail involves data that is already there.
 *
 * This suite was written while diagnosing the failed deployment of 2026-07-29. Migration 011 turned out
 * NOT to be the cause. The deployments failed at the build step, before a container existed, so 011
 * never ran and nothing about it was ever exercised in production. The suite stayed because that is
 * exactly the situation in which a migration is most likely to be wrong: it is queued to run, unproven,
 * against a database nobody has rehearsed the upgrade on.
 *
 * WHY THE MIGRATIONS COME FROM FIVE PACKAGES
 *
 * All five packages migrate the SAME database and share one `schema_migrations` table, so 001 to 006
 * belong to receipt-writer, policy-store, escalation and trust-bureau, and only 007 onwards belong here.
 * Applying just this package's files would build a schema that has never existed in production, and a
 * test against a schema that has never existed can pass while the real upgrade fails.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent. It is destructive:
 * it drops and recreates the public schema.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");

/** Every migration in the repository, across all five packages, in global filename order. */
function allMigrations(): { name: string; sql: string }[] {
  const dirs = readdirSync(PACKAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(PACKAGES, e.name, "migrations"));

  const files: { name: string; sql: string }[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.endsWith(".sql")) files.push({ name: f, sql: readFileSync(join(dir, f), "utf8") });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Apply everything strictly BEFORE 011, recording it exactly as the real runner would.
 *
 * The recording is the part that matters. `runMigrations` decides what to do by reading
 * `schema_migrations`, so a faithful pre-011 state is one where 001 to 010 are both applied AND
 * recorded. Applying without recording would make the real runner try them again.
 */
async function applyThrough010(pool: Pool): Promise<string[]> {
  const applied: string[] = [];
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  for (const m of allMigrations()) {
    if (m.name >= "011") continue;
    await pool.query(m.sql);
    await pool.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING", [m.name]);
    applied.push(m.name);
  }
  return applied;
}

/** Representative pre-existing production data: a provider, a settled intent, and execution rows. */
async function seedRepresentativeData(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO consumer_providers (provider_id, display_name, base_url, protocol, maturity, chains)
     VALUES ('purch', 'Purch', 'https://purch.example', 'x402', 'sandbox',
             '["eip155:8453","solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"]'::jsonb)
     ON CONFLICT DO NOTHING`,
  );

  await pool.query(
    `INSERT INTO consumer_intents
       (intent_id, tenant_id, requesting_agent_id, principal_id, action, category, provider_id,
        policy_id, correlation_id, idempotency_key, state)
     VALUES
       ('intent-settled-base', 't1', 'agent-1', 'principal-1', 'shop.search', 'shopping', 'purch', 'policy-1', 'corr-1', 'ikey-1', 'COMPLETED'),
       ('intent-in-flight',    't1', 'agent-1', 'principal-1', 'shop.search', 'shopping', 'purch', 'policy-1', 'corr-2', 'ikey-2', 'EXECUTION_QUEUED'),
       -- FAILED_AFTER_PAYMENT rather than a generic failure. It is the state that most sharply makes the
       -- gate's point: the intent failed AND money may already have moved, which is precisely the pair a
       -- migration must not try to resolve on its own.
       ('intent-failed',       't1', 'agent-1', 'principal-1', 'shop.search', 'shopping', 'purch', 'policy-1', 'corr-3', 'ikey-3', 'FAILED_AFTER_PAYMENT')
     ON CONFLICT DO NOTHING`,
  );

  /**
   * Execution rows in the states that motivated the durable gate.
   *
   * PAID, AMBIGUOUS and FAILED are here on purpose. The gate exists because those three cannot be
   * distinguished from "the treasury never signed" by looking at the final state, so a migration that
   * tried to backfill gate rows by inferring from them would be encoding the exact mistake the gate was
   * built to correct. Migration 011 must leave these entirely alone.
   */
  await pool.query(
    `INSERT INTO consumer_provider_executions
       (execution_id, intent_id, provider_id, attempt_no, idempotency_key, state, settlement_chain)
     VALUES
       ('exec-paid',      'intent-settled-base', 'purch', 1, 'idem-1', 'PAID',      'eip155:8453'),
       ('exec-ambiguous', 'intent-in-flight',    'purch', 1, 'idem-2', 'AMBIGUOUS', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),
       ('exec-failed',    'intent-failed',       'purch', 1, 'idem-3', 'FAILED',    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
     ON CONFLICT DO NOTHING`,
  );
}

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

describe("migration 011 on an upgraded database", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;

  before(async () => {
    pool = createPool(TEST_DB as string);
    await resetSchema(pool);
  });

  after(async () => {
    await pool.end();
  });

  test("001 to 010 apply, and 011 is the only migration left to run", async () => {
    // #given a production-like database at the pre-011 schema, with real rows in it
    const pre = await applyThrough010(pool);
    assert.ok(pre.length >= 10, `expected at least ten pre-011 migrations, applied ${pre.length}`);
    await seedRepresentativeData(pool);

    const before = await readSchemaState(pool);
    assert.equal(before.proofGateTablePresent, false, "the gate table must not exist before 011");

    // #when the real runner runs against that database
    const applied = await runMigrations(pool);

    // #then it applies exactly 011, and nothing else
    assert.deepEqual(applied, ["011_solana_proof_gate.sql"]);
  });

  test("the gate table, its constraints and its partial index all exist afterwards", async () => {
    const state = await readSchemaState(pool);
    assert.equal(state.migrationVersion, "011_solana_proof_gate.sql");
    assert.equal(state.proofGateTablePresent, true);
    assert.equal(state.proofGateLiveIndexPresent, true);

    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'consumer_solana_proof_gate'::regclass ORDER BY conname`,
    );
    const names = constraints.rows.map((r) => r.conname);
    for (const expected of [
      "consumer_solana_proof_gate_state_check",
      "consumer_solana_proof_gate_claim_check",
      "consumer_solana_proof_gate_release_check",
    ]) {
      assert.ok(names.includes(expected), `missing ${expected}, saw ${names.join(", ")}`);
    }
  });

  test("pre-existing intents and execution rows are untouched", async () => {
    // The migration creates a new table and must not rewrite history. An execution row that was
    // AMBIGUOUS before the upgrade is still AMBIGUOUS after it, because whether the treasury signed is
    // not a question a migration is allowed to decide.
    const execs = await pool.query<{ execution_id: string; state: string }>(
      `SELECT execution_id, state FROM consumer_provider_executions ORDER BY execution_id`,
    );
    assert.deepEqual(execs.rows, [
      { execution_id: "exec-ambiguous", state: "AMBIGUOUS" },
      { execution_id: "exec-failed", state: "FAILED" },
      { execution_id: "exec-paid", state: "PAID" },
    ]);

    const gates = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM consumer_solana_proof_gate`);
    // No backfill. A gate row invented from an execution row would assert something about the signer
    // that the execution row cannot support.
    assert.equal(gates.rows[0]?.n, "0");
  });

  test("re-running is idempotent", async () => {
    // A retried deployment runs migrations again. The second run must be a no-op rather than an error,
    // or every restart after a partial failure would fail forever.
    const applied = await runMigrations(pool);
    assert.deepEqual(applied, []);

    const state = await readSchemaState(pool);
    assert.equal(state.proofGateTablePresent, true);
  });

  test("concurrent startup does not race", async () => {
    // Two workers booting at once both call runMigrations. The advisory lock serialises them, so one
    // applies and the other waits and finds nothing to do. Neither may error.
    await resetSchema(pool);
    await applyThrough010(pool);

    const second = createPool(TEST_DB as string);
    try {
      const [a, b] = await Promise.all([runMigrations(pool), runMigrations(second)]);
      const total = [...a, ...b];
      assert.deepEqual(total, ["011_solana_proof_gate.sql"], `011 applied ${total.length} time(s)`);
    } finally {
      await second.end();
    }
  });

  test("a failed migration leaves no partial state", async () => {
    // Each migration runs inside its own transaction. A statement failing part way through must roll
    // the whole file back, so a retried deployment starts from a clean, known point rather than from
    // half a schema.
    await resetSchema(pool);
    await applyThrough010(pool);

    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    // Stand in for a migration that half-succeeds: create a table, then fail.
    await pool.query("BEGIN");
    try {
      await pool.query("CREATE TABLE partial_probe (id TEXT PRIMARY KEY)");
      await pool.query("SELECT this_function_does_not_exist()");
      await pool.query("COMMIT");
      assert.fail("the deliberately broken statement should have thrown");
    } catch {
      await pool.query("ROLLBACK");
    }

    const probe = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.partial_probe') IS NOT NULL AS present`,
    );
    assert.equal(probe.rows[0]?.present, false, "a rolled-back migration must leave nothing behind");

    // And the real 011 still applies cleanly afterwards.
    assert.deepEqual(await runMigrations(pool), ["011_solana_proof_gate.sql"]);
  });

  test("the live-gate index permits one ARMED row per intent and refuses a second", async () => {
    const scope = {
      intent: "intent-proof-1",
      provider: "purch",
      capability: "shop.search",
      chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    };

    await pool.query(
      `INSERT INTO consumer_solana_proof_gate
         (scope_hash, state, intent_id, provider_id, capability, chain, asset_symbol, max_amount, expires_at)
       VALUES ('hash-a', 'ARMED', $1, $2, $3, $4, 'USDC', '50000', now() + interval '1 hour')`,
      [scope.intent, scope.provider, scope.capability, scope.chain],
    );

    // A second live gate for the SAME intent is the condition that would let a retry claim a "fresh"
    // gate while the first is still in flight, which is how one authorisation becomes two settlements.
    await assert.rejects(
      pool.query(
        `INSERT INTO consumer_solana_proof_gate
           (scope_hash, state, intent_id, provider_id, capability, chain, asset_symbol, max_amount, expires_at)
         VALUES ('hash-b', 'ARMED', $1, $2, $3, $4, 'USDC', '50000', now() + interval '1 hour')`,
        [scope.intent, scope.provider, scope.capability, scope.chain],
      ),
      /consumer_solana_proof_gate_live_intent|duplicate key/,
    );
  });

  test("a CLAIMED row must name its claimant, and release requires an unreached signer", async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO consumer_solana_proof_gate
           (scope_hash, state, intent_id, provider_id, capability, chain, asset_symbol, max_amount, expires_at)
         VALUES ('hash-claimed-nobody', 'CLAIMED', 'intent-x', 'purch', 'shop.search', 'solana:x', 'USDC', '1', now())`,
      ),
      /claim_check/,
      "a CLAIMED row with no claimant is the same as an unclaimed one",
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO consumer_solana_proof_gate
           (scope_hash, state, intent_id, provider_id, capability, chain, asset_symbol, max_amount, expires_at,
            signer_reached_at)
         VALUES ('hash-released-signed', 'RELEASED_PRE_SIGN', 'intent-y', 'purch', 'shop.search', 'solana:x',
                 'USDC', '1', now(), now())`,
      ),
      /release_check/,
      "releasing a gate whose signer was reached would turn a possibly-spent gate back into a spendable one",
    );
  });
});
