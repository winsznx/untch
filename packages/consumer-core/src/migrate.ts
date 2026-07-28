import { loadStorageConfig } from "./config";
import { createPool, runMigrations } from "./db";

/** Standalone migration runner: `pnpm --filter @untch/consumer-core migrate`. Idempotent. */
async function main(): Promise<void> {
  const { databaseUrl } = loadStorageConfig();
  const pool = createPool(databaseUrl);
  try {
    const applied = await runMigrations(pool);
    console.log(
      applied.length > 0
        ? `[consumer-core] applied migrations: ${applied.join(", ")}`
        : "[consumer-core] migrations already up to date",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[consumer-core] migrate failed: ${(err as Error).message}`);
  process.exit(1);
});
