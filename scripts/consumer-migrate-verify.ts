/**
 * Migration 007 verifier.
 *
 * Applies the Consumer Pack migration inside a transaction that is ROLLED BACK, then re-reads the
 * database to prove nothing changed. Postgres DDL is transactional, so this is a genuine dry run.
 *
 * Verifying against the REAL database rather than an empty one is deliberate: an empty database
 * cannot catch a collision with an existing table, an index name already taken, or a RULE that
 * conflicts with something migrations 001-006 created. Those are exactly the failures that matter,
 * and they only exist where the real schema does.
 *
 *   pnpm consumer:migrate:verify        dry run, rolls back, changes nothing
 *   pnpm consumer:migrate:verify --apply  applies for real (idempotent, forward-only)
 *
 * Reads DATABASE_URL from the environment. It never prints the connection string.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The root package.json declares no `pg`, and root scripts reach workspace libraries by path.
// Reusing consumer-core's own createPool also means this verifier exercises the EXACT connection
// path production uses, including its sslmode handling.
import { createPool } from "../packages/consumer-core/src/db";

const MIGRATION = "007_consumer_pack.sql";
const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "consumer-core",
  "migrations",
  MIGRATION,
);

/** The same advisory-lock key every Untch migrator takes, so this can never race a booting service. */
const MIGRATION_LOCK_KEY = 4021_1003;

const APPLY = process.argv.includes("--apply");

const ok = (s: string): void => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string): void => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const step = (s: string): void => console.log(`\n\x1b[1m${s}\x1b[0m`);

/**
 * Run a statement that is EXPECTED to fail, without poisoning the surrounding transaction.
 *
 * Postgres aborts the whole transaction on any error, so a negative probe ("this INSERT must be
 * rejected") would otherwise take every later check down with it. A SAVEPOINT scopes the damage:
 * the probe rolls back to the savepoint and the transaction carries on.
 *
 * Returns true when the statement was rejected — i.e. when the constraint being probed DID hold.
 */
async function expectRejected(
  c: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  label: string,
  sql: string,
): Promise<boolean> {
  await c.query(`SAVEPOINT ${label}`);
  try {
    await c.query(sql);
    await c.query(`RELEASE SAVEPOINT ${label}`);
    return false;
  } catch {
    await c.query(`ROLLBACK TO SAVEPOINT ${label}`);
    await c.query(`RELEASE SAVEPOINT ${label}`);
    return true;
  }
}

/** Tables migration 007 must create. */
const EXPECTED_TABLES = [
  "consumer_providers",
  "consumer_provider_capabilities",
  "consumer_provider_health",
  "consumer_pause_flags",
  "consumer_intents",
  "consumer_quotes",
  "consumer_approvals",
  "consumer_funding_receipts",
  "consumer_provider_executions",
  "consumer_delivery_evidence",
  "consumer_treasury_accounts",
  "consumer_treasury_balances",
  "consumer_provider_limits",
  "consumer_payment_capabilities",
  "consumer_ledger_accounts",
  "consumer_ledger_groups",
  "consumer_ledger_entries",
  "consumer_outbox",
  "consumer_webhook_endpoints",
  "consumer_webhook_deliveries",
  "consumer_idempotency_records",
];

/** The constraints that carry a money guarantee. If one is missing, the guarantee is not real. */
const EXPECTED_INDEXES = [
  // one funding receipt can never fund two intents, and one tx can never be counted twice
  "consumer_funding_tx_idx",
  // a provider execution can never be sent twice
  "consumer_exec_idem_idx",
  "consumer_exec_attempt_idx",
  // cross-tenant idempotency collision is impossible
  "consumer_intents_idem_idx",
  // at most one live payment capability per intent
  "consumer_capability_intent_idx",
  // each ledger group kind happens at most once per intent
  "consumer_ledger_group_once_idx",
  // per-intent monotonic, gapless event sequence
  "consumer_outbox_seq_idx",
  // reconciliation + status query support
  "consumer_intents_state_idx",
  "consumer_intents_review_idx",
  "consumer_exec_ambiguous_idx",
  "consumer_outbox_pending_idx",
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL is not set. Export it (never paste it into a command) and re-run.");
    process.exit(2);
  }

  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const pool = createPool(url);
  // One dedicated connection: the whole verification is a single transaction plus an advisory lock,
  // and both are connection-scoped. Taking a random pool member per query would silently break them.
  const client = (await pool.connect()) as unknown as Conn;

  try {
    console.log(`\n\x1b[1mMigration ${MIGRATION} — ${APPLY ? "APPLY" : "DRY RUN (rolls back)"}\x1b[0m`);

    // ── before ───────────────────────────────────────────────────────────────
    step("1. Existing state");
    const before = await snapshot(client);
    console.log(`  migrations applied : ${before.migrations.join(", ")}`);
    console.log(`  tables             : ${before.tables.length}`);
    console.log(`  rows (receipts/policies/ledger_entries/escalations): ${before.counts}`);
    if (before.migrations.includes(MIGRATION)) {
      ok(`${MIGRATION} is ALREADY applied — this run is a no-op check`);
    }

    // ── apply ────────────────────────────────────────────────────────────────
    step(`2. ${APPLY ? "Applying" : "Applying inside a transaction that will be rolled back"}`);
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query("BEGIN");
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
      const already = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [MIGRATION]);
      if (already.rowCount && already.rowCount > 0 && APPLY) {
        ok("already recorded in schema_migrations — nothing to do");
        await client.query("ROLLBACK");
        return;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
        [MIGRATION],
      );
      ok("migration SQL executed without error");

      // ── verify, still inside the transaction ───────────────────────────────
      step("3. Structure");
      let failures = 0;

      const tables = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'consumer_%'",
      );
      const got = new Set((tables.rows as { tablename: string }[]).map((r) => r.tablename));
      for (const t of EXPECTED_TABLES) {
        if (got.has(t)) ok(`table ${t}`);
        else {
          bad(`table ${t} MISSING`);
          failures += 1;
        }
      }

      step("4. Constraints that carry a money guarantee");
      const idx = await client.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'consumer_%'",
      );
      const gotIdx = new Set((idx.rows as { indexname: string }[]).map((r) => r.indexname));
      for (const i of EXPECTED_INDEXES) {
        if (gotIdx.has(i)) ok(`index ${i}`);
        else {
          bad(`index ${i} MISSING`);
          failures += 1;
        }
      }

      step("5. Append-only ledger");
      /**
       * The behavioural probes below INSERT rows. In dry-run mode the whole transaction rolls back
       * and they vanish; in --apply mode they would COMMIT.
       *
       * They did, once, on the first production apply — and the append-only RULE then correctly
       * refused to let them be deleted again, which is the control working exactly as designed and a
       * permanent reminder not to write test data down a path that commits. The artefact is one
       * inert row (token PROBE, chain eip155:1, group relabelled
       * `probe-migration-007-verification-artifact`) that no query for a real intent can return.
       *
       * Structural probes still run in both modes; only the ones that WRITE are dry-run-only.
       */
      const canProbeDestructively = !APPLY;
      if (!canProbeDestructively) {
        ok("skipping write-probes in --apply mode (they would commit); structure was verified above");
      }
      // The RULEs are the enforcement. Prove they EXIST and that they actually bite.
      const rules = await client.query(
        `SELECT rulename FROM pg_rules WHERE schemaname = 'public' AND tablename = 'consumer_ledger_entries'`,
      );
      const ruleNames = (rules.rows as { rulename: string }[]).map((r) => r.rulename);
      for (const r of ["consumer_ledger_entries_no_update", "consumer_ledger_entries_no_delete"]) {
        if (ruleNames.includes(r)) ok(`rule ${r}`);
        else {
          bad(`rule ${r} MISSING`);
          failures += 1;
        }
      }

      // Behavioural proof, not just presence: insert a row, try to mutate it, confirm it survives.
      if (canProbeDestructively) {
      await client.query(
        `INSERT INTO consumer_ledger_accounts (account_id, kind, chain, token, decimals, owner_ref)
         VALUES ('probe', 'SUSPENSE', 'eip155:1', 'PROBE', 6, 'probe')`,
      );
      await client.query(
        `INSERT INTO consumer_ledger_groups (group_id, kind, intent_id, chain, token)
         VALUES ('probe', 'ADJUSTMENT', 'probe', 'eip155:1', 'PROBE')`,
      );
      await client.query(
        `INSERT INTO consumer_ledger_entries (group_id, account_id, amount, token, chain, decimals, memo)
         VALUES ('probe', 'probe', 42, 'PROBE', 'eip155:1', 6, 'append-only probe')`,
      );
      await client.query("UPDATE consumer_ledger_entries SET amount = 99 WHERE group_id = 'probe'");
      const afterUpdate = await client.query(
        "SELECT amount FROM consumer_ledger_entries WHERE group_id = 'probe'",
      );
      const upd = afterUpdate.rows as { amount: unknown }[];
      if (upd.length === 1 && String(upd[0]?.amount) === "42") {
        ok("UPDATE on a ledger entry is silently discarded — the row is unchanged");
      } else {
        bad(`UPDATE was NOT blocked (amount is now ${String(upd[0]?.amount)})`);
        failures += 1;
      }
      await client.query("DELETE FROM consumer_ledger_entries WHERE group_id = 'probe'");
      const afterDelete = await client.query(
        "SELECT count(*)::int AS n FROM consumer_ledger_entries WHERE group_id = 'probe'",
      );
      if ((afterDelete.rows as { n: number }[])[0]?.n === 1) ok("DELETE on a ledger entry is silently discarded — the row survives");
      else {
        bad("DELETE was NOT blocked");
        failures += 1;
      }
      // The zero-amount CHECK. Probed under a savepoint so the expected failure does not abort
      // the transaction and take every later check with it.
      if (
        await expectRejected(
          client,
          "sp_zero_amount",
          `INSERT INTO consumer_ledger_entries (group_id, account_id, amount, token, chain, decimals)
           VALUES ('probe', 'probe', 0, 'PROBE', 'eip155:1', 6)`,
        )
      ) {
        ok("a zero-amount ledger entry is rejected by CHECK (amount <> 0)");
      } else {
        bad("a zero-amount ledger entry was ACCEPTED (CHECK amount <> 0 not enforced)");
        failures += 1;
      }

      }

      step("6. Tenant isolation");
      if (canProbeDestructively) {
      // Two tenants using the SAME idempotency key must both succeed.
      await client.query(
        `INSERT INTO consumer_idempotency_records (tenant_id, key, intent_id, action, request_hash)
         VALUES ('t1','shared','ci_a','x','h'), ('t2','shared','ci_b','x','h')`,
      );
      ok("two tenants may reuse one idempotency key (PK is (tenant_id, key))");
      if (
        await expectRejected(
          client,
          "sp_same_tenant_key",
          `INSERT INTO consumer_idempotency_records (tenant_id, key, intent_id, action, request_hash)
           VALUES ('t1','shared','ci_c','x','h')`,
        )
      ) {
        ok("the same tenant cannot reuse a key");
      } else {
        bad("the SAME tenant reused a key and it was accepted");
        failures += 1;
      }

      }

      step("7. Existing Untch data untouched (inside the transaction)");
      const during = await snapshot(client);
      if (during.counts === before.counts) ok(`row counts unchanged: ${during.counts}`);
      else {
        bad(`row counts CHANGED: ${before.counts} → ${during.counts}`);
        failures += 1;
      }
      for (const t of ["receipts", "policies", "ledger_entries", "escalations", "score_snapshots"]) {
        if (during.tables.includes(t)) ok(`pre-existing table ${t} still present`);
        else {
          bad(`pre-existing table ${t} DISAPPEARED`);
          failures += 1;
        }
      }

      if (failures > 0) {
        await client.query("ROLLBACK");
        console.error(`\n\x1b[31mFAILED: ${failures} check(s) did not pass. Rolled back.\x1b[0m`);
        process.exitCode = 1;
        return;
      }

      if (APPLY) {
        await client.query("COMMIT");
        console.log("\n\x1b[1m\x1b[32mAPPLIED and committed.\x1b[0m");
      } else {
        await client.query("ROLLBACK");
        console.log("\n\x1b[1mRolled back. Nothing was changed.\x1b[0m");
      }
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }

    // ── after: prove it, from outside the transaction ────────────────────────
    step("8. Post-run state");
    const after = await snapshot(client);
    console.log(`  migrations applied : ${after.migrations.join(", ")}`);
    console.log(`  tables             : ${after.tables.length}`);
    console.log(`  rows               : ${after.counts}`);
    if (!APPLY) {
      const consumerTables = after.tables.filter((t) => t.startsWith("consumer_"));
      if (consumerTables.length === 0) ok("no consumer_* table persisted — the dry run left nothing behind");
      else bad(`${consumerTables.length} consumer_* table(s) persisted after a rollback`);
      if (after.counts === before.counts) ok("existing Untch data intact");
      else bad("existing Untch data changed");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * A structural connection type.
 *
 * `Awaited<ReturnType<Pool["connect"]>>` resolves to `void` — `connect` is overloaded and TypeScript
 * picks the callback form. Declaring only what this script uses avoids depending on `pg`'s type
 * export from a directory that does not declare `pg` as a dependency.
 */
interface Conn {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  release(): void;
}

async function snapshot(
  c: Conn,
): Promise<{ migrations: string[]; tables: string[]; counts: string }> {
  const m = await c.query("SELECT name FROM schema_migrations ORDER BY name");
  const t = await c.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const n = await c.query(
    `SELECT (SELECT count(*) FROM receipts) a, (SELECT count(*) FROM policies) b,
            (SELECT count(*) FROM ledger_entries) c, (SELECT count(*) FROM escalations) d`,
  );
  const r = n.rows[0] as Record<string, string>;
  return {
    migrations: (m.rows as { name: string }[]).map((x) => x.name),
    tables: (t.rows as { tablename: string }[]).map((x) => x.tablename),
    counts: `${r.a}/${r.b}/${r.c}/${r.d}`,
  };
}

main().catch((err: unknown) => {
  console.error(`\nmigration verify failed: ${(err as Error).message}`);
  process.exit(1);
});
