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

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

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

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied: string[] = [];
    for (const file of files) {
      const { rowCount } = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (rowCount && rowCount > 0) continue;

      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
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
