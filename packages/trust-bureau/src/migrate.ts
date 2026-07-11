import { createPool, runMigrations } from "./db";

/** Standalone migration runner: `pnpm --filter @untch/trust-bureau migrate`. Idempotent. Needs
 *  DATABASE_URL (the shared instance). */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("[trust-bureau] DATABASE_URL is required to migrate");
    process.exit(1);
  }
  const pool = createPool(databaseUrl);
  try {
    const applied = await runMigrations(pool);
    console.log(
      applied.length > 0
        ? `[trust-bureau] applied migrations: ${applied.join(", ")}`
        : "[trust-bureau] migrations already up to date",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[trust-bureau] migrate failed: ${(err as Error).message}`);
  process.exit(1);
});
