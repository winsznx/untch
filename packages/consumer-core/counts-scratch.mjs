/**
 * Every table in `public`, counted.
 *
 * A spot-check of the few tables I happen to remember cannot prove a deployment changed nothing — a
 * write to the next one would pass. The caller diffs two runs of this.
 */
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });

const { rows: tables } = await pool.query(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
);

const counts = {};
for (const { tablename } of tables) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM public."${tablename}"`);
  counts[tablename] = rows[0].n;
}

const { rows: mig } = await pool.query(
  "SELECT count(*)::int AS n, max(name) AS head FROM public.schema_migrations",
);

console.log(
  JSON.stringify({ migrations: mig[0], total: Object.values(counts).reduce((a, b) => a + b, 0), counts }),
);
await pool.end();
