/**
 * The one place migrations are applied. Node only, never a Worker.
 *
 * Five packages own migration directories and all five target the SAME database and the SAME
 * `schema_migrations` table, sharing one advisory-lock key so they serialise across packages and
 * processes. Filenames are globally unique by convention, which is what lets one history hold them.
 *
 * This used to happen on server boot, in six wiring files. That was survivable on a single Railway
 * container and is not survivable on Workers, where a cold start is not a deployment and isolates
 * would race to ALTER the same table. Execution belongs here; the runtime only VERIFIES (see
 * `verifySchemaVersion`).
 *
 * Runs as the migrator role. The runtime role has no DDL rights and must not acquire any.
 *
 * CONNECTING TO SUPABASE: USE PGSSL=1, NOT `?sslmode=require`
 *
 * The packages' `createPool` sets `ssl: { rejectUnauthorized: false }` when it sees either. Against
 * Supabase only the environment variable works: pg 8.22 parses `sslmode=require` out of the
 * connection string and applies strict verification that overrides the ssl object, so the URL form
 * fails with SELF_SIGNED_CERT_IN_CHAIN. It worked on Railway because that chain verified.
 */
// Relative source imports, matching scripts/consumer-migrate-verify.ts: this runs the packages' OWN
// db.ts, so the migration path exercised here is the one that ships rather than a copy of it.
import { createPool as consumerPool, runMigrations as consumerMigrations } from "../packages/consumer-core/src/db";
import { createPool as policyPool, runMigrations as policyMigrations } from "../packages/policy-store/src/db";
import { createPool as receiptPool, runMigrations as receiptMigrations } from "../packages/receipt-writer/src/db";
import { createPool as bureauPool, runMigrations as bureauMigrations } from "../packages/trust-bureau/src/db";
import { createPool as escalationPool, runMigrations as escalationMigrations } from "../packages/escalation/src/db";

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("MIGRATE_DATABASE_URL (or DATABASE_URL) is required, and must be the MIGRATOR role");
  process.exit(1);
}

/**
 * Order matters only to the extent that a package's own files are ordered; the runners are idempotent
 * and skip anything already in `schema_migrations`, so a re-run is a no-op rather than a hazard.
 */
const RUNNERS = [
  ["policy-store", policyPool, policyMigrations],
  ["receipt-writer", receiptPool, receiptMigrations],
  ["trust-bureau", bureauPool, bureauMigrations],
  ["escalation", escalationPool, escalationMigrations],
  ["consumer-core", consumerPool, consumerMigrations],
] as const;

let total = 0;
for (const [name, makePool, run] of RUNNERS) {
  const pool = makePool(url);
  try {
    const applied = await run(pool as never);
    total += applied.length;
    console.log(`${name.padEnd(15)} applied ${applied.length}${applied.length ? `: ${applied.join(", ")}` : ""}`);
  } finally {
    await pool.end();
  }
}

const pool = consumerPool(url);
try {
  const { rows } = await pool.query<{ n: string; head: string }>(
    "SELECT count(*)::text AS n, max(name) AS head FROM schema_migrations",
  );
  console.log(`\napplied this run: ${total}`);
  console.log(`total in database: ${rows[0]?.n}  head: ${rows[0]?.head}`);
} finally {
  await pool.end();
}
