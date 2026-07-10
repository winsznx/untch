import type { Redis } from "ioredis";
import type { Worker } from "bullmq";
import { flushOnce, reconcileOnce, type AnchorerDeps } from "./anchorer";
import { Batcher } from "./batcher";
import { ViemChainAnchor } from "./chain";
import { loadWorkerConfig, type WorkerConfig } from "./config";
import { createPool, runMigrations, type Pool } from "./db";
import { createRedis, createTickWorker } from "./queue";
import { PgReceiptsRepo } from "./repo-pg";

/**
 * The receipt-writer WORKER process (a Railway service, `pnpm --filter @untch/receipt-writer worker`).
 * It holds the authorized writer key and is the only thing that talks to the chain. Boot order:
 *
 *   1. connect Postgres + run migrations (idempotent; safe if the seller already ran them)
 *   2. wire the §7.4 state machine (Batcher trigger → flushOnce anchor; reconcile sweep for
 *      confirm/reorg; safety sweep so a lost tick never strands a durable QUEUED row)
 *   3. consume BullMQ ticks → Batcher.notify
 *
 * Nothing here is authoritative: Postgres is. The worker only moves already-durable rows through
 * QUEUED → BATCHED → SUBMITTED → CONFIRMED (or DEGRADED_UNANCHORED). A crash restarts clean.
 */

function log(msg: string, meta?: Record<string, unknown>): void {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[receipt-writer] ${msg}${suffix}`);
}

/** A self-guarding interval that never overlaps its own runs. Returns a stop function. */
function loop(fn: () => Promise<void>, ms: number, onError: (e: unknown) => void): () => void {
  let running = false;
  const handle = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  }, ms);
  return () => clearInterval(handle);
}

export interface RunningWorker {
  readonly config: WorkerConfig;
  readonly writerAddress: string;
  stop(): Promise<void>;
}

export async function startWorker(config: WorkerConfig = loadWorkerConfig()): Promise<RunningWorker> {
  const pool: Pool = createPool(config.databaseUrl);
  const applied = await runMigrations(pool);
  if (applied.length > 0) log("migrations applied", { applied });

  const repo = new PgReceiptsRepo(pool);
  const chain = new ViemChainAnchor({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    contract: config.receiptsContract,
    writerPrivateKey: config.writerPrivateKey,
  });

  const anchorer: AnchorerDeps = {
    repo,
    chain,
    batchMaxSize: config.batchMaxSize,
    retryMax: config.retryMax,
    retryBackoffBaseMs: config.retryBackoffBaseMs,
    confirmDepth: config.confirmDepth,
    log,
  };

  const batcher = new Batcher({
    maxBatchSize: config.batchMaxSize,
    maxWaitMs: config.batchMaxWaitMs,
    flush: async (reason) => {
      const out = await flushOnce(anchorer);
      if (out.kind !== "empty") log(`flush (${reason})`, { outcome: out });
    },
    onError: (err) => log("batcher flush error", { error: String(err) }),
  });

  const redis: Redis = createRedis(config.redisUrl);
  const tickWorker: Worker = createTickWorker(redis, async () => {
    batcher.notify(1);
  });
  tickWorker.on("failed", (_job, err) => log("tick job failed", { error: err.message }));

  // Safety sweep: drain any QUEUED rows the tick path missed (e.g. ticks lost while the worker was
  // down). Bounded per sweep; the atomic claim makes this safe alongside the tick-driven flushes.
  const stopSweep = loop(
    async () => {
      for (let i = 0; i < 50; i++) {
        const out = await flushOnce(anchorer);
        if (out.kind === "empty") break;
      }
    },
    config.batchMaxWaitMs,
    (err) => log("safety sweep error", { error: String(err) }),
  );

  // Confirm / reorg watcher.
  const stopReconcile = loop(
    () => reconcileOnce(anchorer),
    config.reconcileIntervalMs,
    (err) => log("reconcile error", { error: String(err) }),
  );

  log("worker started", {
    writer: chain.writerAddress,
    contract: config.receiptsContract,
    chainId: config.chain.id,
    batchMaxSize: config.batchMaxSize,
    batchMaxWaitMs: config.batchMaxWaitMs,
    retryMax: config.retryMax,
    confirmDepth: config.confirmDepth,
  });

  const stop = async (): Promise<void> => {
    stopSweep();
    stopReconcile();
    await batcher.stop();
    await tickWorker.close();
    await redis.quit();
    await pool.end();
    log("worker stopped");
  };

  return { config, writerAddress: chain.writerAddress, stop };
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);
if (isMain) {
  startWorker()
    .then((w) => {
      const shutdown = (): void => {
        w.stop().finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error(`[receipt-writer] fatal: ${(err as Error).message}`);
      process.exit(1);
    });
}
