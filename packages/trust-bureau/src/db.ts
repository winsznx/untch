import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Postgres pool + forward-only migration runner for the Bureau's own `score_snapshots` migration. Same
 * shape as @untch/receipt-writer's db.ts: migrations live in ../migrations as ordered `NNN_name.sql`,
 * each applied once and recorded in the SHARED `schema_migrations` table. This runner only reads THIS
 * package's dir; filenames are globally unique across packages (006 here) so the shared PK never
 * collides. Additive-only, every file idempotent (IF NOT EXISTS).
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

/** Distinct advisory-lock key from the other packages' runners so concurrent boots don't deadlock. */
const MIGRATION_LOCK_KEY = 4021_1012;

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
      const { rowCount } = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [
        file,
      ]);
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
