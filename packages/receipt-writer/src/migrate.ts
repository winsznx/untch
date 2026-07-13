import { loadStorageConfig } from "./config";
import { createPool, runMigrations } from "./db";

/** Standalone migration runner: `pnpm --filter @untch/receipt-writer migrate`. Idempotent. */
async function main(): Promise<void> {
  const { databaseUrl } = loadStorageConfig();
  const pool = createPool(databaseUrl);
  try {
    const applied = await runMigrations(pool);
    console.log(
      applied.length > 0
        ? `[receipt-writer] applied migrations: ${applied.join(", ")}`
        : "[receipt-writer] migrations already up to date",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[receipt-writer] migrate failed: ${(err as Error).message}`);
  process.exit(1);
});
