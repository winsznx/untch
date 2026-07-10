import { loadStorageConfig } from "./config";
import { createPool, runMigrations } from "./db";

/** Standalone migration runner: `pnpm --filter @untch/escalation migrate`. Idempotent; shared Postgres. */
async function main(): Promise<void> {
  const { databaseUrl } = loadStorageConfig();
  const pool = createPool(databaseUrl);
  try {
    const applied = await runMigrations(pool);
    console.log(
      applied.length > 0
        ? `[escalation] applied migrations: ${applied.join(", ")}`
        : "[escalation] migrations already up to date",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[escalation] migrate failed: ${(err as Error).message}`);
  process.exit(1);
});
