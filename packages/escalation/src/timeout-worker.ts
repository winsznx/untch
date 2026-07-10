import { ChannelRegistry } from "./channel";
import { loadStorageConfig } from "./config";
import { createPool, runMigrations } from "./db";
import { PgEscalationsRepo } from "./repo-pg";
import { EscalationService } from "./service";
import { createRedis, createTimeoutQueue, createTimeoutWorker } from "./queue";

/**
 * The escalation timeout worker: `pnpm --filter @untch/escalation timeout-worker`.
 *
 * Consumes delayed jobs from the shared Redis and fires §7.2 timeout → EXPIRED → default DENY (I2). Runs
 * a periodic safety sweep too, so a job lost to a Redis restart still resolves — the fail-closed default
 * never depends on a single delivery. `expire` and `sweepExpired` need only the repo; this worker
 * registers no channels and binds no handle (it never accepts an approval, only enforces the deadline).
 */
async function main(): Promise<void> {
  const cfg = loadStorageConfig();
  const pool = createPool(cfg.databaseUrl);
  await runMigrations(pool);

  const repo = new PgEscalationsRepo(pool);
  const service = new EscalationService({
    repo,
    registry: new ChannelRegistry(),
    binding: () => false,
    defaultTimeoutMin: cfg.defaultTimeoutMin,
    maxTimeoutMin: cfg.maxTimeoutMin,
  });

  const connection = createRedis(cfg.redisUrl);
  createTimeoutQueue(connection); // ensure the queue exists
  const worker = createTimeoutWorker(connection, async (job) => {
    const expired = await service.expire(job.data.escalationId);
    console.log(`[escalation] timeout ${job.data.escalationId}: ${expired ? "EXPIRED (default DENY)" : "no-op (already resolved / not due)"}`);
  });

  const sweep = setInterval(() => {
    service.sweepExpired().then(
      (n) => n > 0 && console.log(`[escalation] safety sweep expired ${n} overdue escalation(s)`),
      (err) => console.error("[escalation] sweep error", err),
    );
  }, 30_000);

  console.log("[escalation] timeout worker started (shared Redis; 30s safety sweep)");

  const shutdown = async (): Promise<void> => {
    clearInterval(sweep);
    await worker.close();
    await connection.quit();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[escalation] timeout worker failed: ${(err as Error).message}`);
  process.exit(1);
});
