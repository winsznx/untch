import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Postgres pool + a forward-only migration runner, mirroring receipt-writer/policy-store. Migrations
 * live in ../migrations as ordered `NNN_name.sql` files; each is applied once and recorded in the
 * SHARED `schema_migrations` table (so filenames are globally unique across packages — this package
 * owns 003). No down-migrations; every file is idempotent (IF NOT EXISTS), so a partial run re-runs safely.
 */

const { Pool } = pg;
export type Pool = pg.Pool;

/**
 * Resolved WHEN A MIGRATION RUNS, never at import — the same fix as consumer-core's.
 *
 * A module-scope `fileURLToPath(import.meta.url)` executes on import, so any bundle that merely wants
 * `createPool` drags a filesystem call into startup. On Workers that is fatal before the first
 * request, and a wrangler dry run does not catch it because bundling never runs module scope.
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

/** Distinct advisory-lock key (§27) so concurrent boots serialize schema creation without racing. */
const MIGRATION_LOCK_KEY = 4021_1027;

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

    const files = readdirSync(migrationsDir())
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied: string[] = [];
    for (const file of files) {
      const { rowCount } = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [
        file,
      ]);
      if (rowCount && rowCount > 0) continue;

      const sql = readFileSync(join(migrationsDir(), file), "utf8");
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
