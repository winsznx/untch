import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Postgres pool + the forward-only migration runner, deliberately the SAME shape as
 * @untch/receipt-writer's and @untch/policy-store's db.ts — this package targets the SAME Railway
 * instance (no second database), so `007_consumer_pack.sql` lands in the shared `schema_migrations`
 * history after trust-bureau's 006. Filenames are globally unique across packages, so the runners
 * coexist.
 */

const { Pool } = pg;
export type Pool = pg.Pool;

/**
 * Resolved WHEN A MIGRATION RUNS, never at import.
 *
 * This was a module-scope constant, which meant `fileURLToPath(import.meta.url)` executed on import —
 * including in a Cloudflare Worker that only ever wanted `createPool` and `readSchemaState`, and never
 * intended to run a migration at all. The Worker died at startup validation with
 * `The "path" argument must be of type string` before serving a single request.
 *
 * The wrangler dry run did not catch it, because bundling never executes module scope. Only a real
 * deploy did. Making it lazy leaves Node behaviour identical and removes the import-time filesystem
 * call from every consumer of this module.
 */
const migrationsDir = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function createPool(databaseUrl: string): Pool {
  const needsSsl = /[?&]sslmode=require/.test(databaseUrl) || process.env.PGSSL === "1";
  return new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

/**
 * Intentionally the SAME advisory-lock key the other three packages use. All four migrate the same
 * database and the same `schema_migrations` table, and the seller boots several wirings at once, so
 * sharing the key serializes every migrator across packages AND processes.
 */
const MIGRATION_LOCK_KEY = 4021_1003;

/** The table migration 011 creates. Named once so the readiness probe and the store cannot disagree. */
const PROOF_GATE_TABLE = "consumer_solana_proof_gate";

export interface SchemaState {
  /** Highest applied migration filename, or null when nothing has been applied. */
  readonly migrationVersion: string | null;
  /** Whether migration 011's table actually exists, checked rather than inferred from the history. */
  readonly proofGateTablePresent: boolean;
  /** Whether the partial unique index that enforces one live gate per intent exists. */
  readonly proofGateLiveIndexPresent: boolean;
}

/**
 * What the database ACTUALLY has, for the readiness gate and the deployment-info endpoint.
 *
 * Deliberately checks the objects rather than trusting `schema_migrations`. A history row says a
 * migration was recorded as applied; it does not say the table survived. The gate that decides whether
 * Solana spending may be armed needs the stronger statement, and the two can diverge after a manual
 * intervention, a restore, or a partially rolled-back deployment.
 */
export async function readSchemaState(pool: Pool): Promise<SchemaState> {
  const history = await pool.query<{ name: string }>(
    `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`,
  );

  const table = await pool.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`public.${PROOF_GATE_TABLE}`],
  );

  const index = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = $1 AND indexname = $2
     ) AS present`,
    [PROOF_GATE_TABLE, `${PROOF_GATE_TABLE}_live_intent`],
  );

  return {
    migrationVersion: history.rows[0]?.name ?? null,
    proofGateTablePresent: table.rows[0]?.present === true,
    proofGateLiveIndexPresent: index.rows[0]?.present === true,
  };
}

export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    const dir = migrationsDir();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied: string[] = [];
    for (const file of files) {
      const { rowCount } = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (rowCount && rowCount > 0) continue;

      const sql = readFileSync(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
          [file],
        );
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    client.release();
  }
}
