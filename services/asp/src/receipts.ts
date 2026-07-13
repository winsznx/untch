import {
  createPool,
  createRedis,
  createTickQueue,
  getReceiptStatus,
  isReceiptId,
  PgReceiptsRepo,
  ReceiptEnqueuer,
  runMigrations,
  type ReceiptStatusView,
} from "@untch/receipt-writer";
import type { Hex } from "viem";

/**
 * Optional receipt-writer wiring for the seller (§7.4). When DATABASE_URL + REDIS_URL are present
 * (the Railway production deploy), preflight_payment enqueues a durable receipt and returns a real
 * {receiptId, status}. When they are absent (local dev, unit tests), this stays null and the seller
 * keeps returning receiptRef: null — an honest "no receipt store configured", never a fabricated ref.
 *
 * The seller only ever ENQUEUES + reads status; it never holds the writer key or touches the chain.
 */
export interface ReceiptWiring {
  readonly enqueuer: ReceiptEnqueuer;
  status(receiptId: string): Promise<ReceiptStatusView | null | "invalid">;
  close(): Promise<void>;
}

export async function initReceiptWiring(): Promise<ReceiptWiring | null> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!databaseUrl || !redisUrl) {
    console.log(
      "[asp] receipt writer NOT wired (DATABASE_URL / REDIS_URL unset) — receiptRef will be null.",
    );
    return null;
  }

  const pool = createPool(databaseUrl);
  const applied = await runMigrations(pool);
  if (applied.length > 0) console.log(`[asp] receipt-writer migrations applied: ${applied.join(", ")}`);

  const repo = new PgReceiptsRepo(pool);
  const redis = createRedis(redisUrl);
  const tickQueue = createTickQueue(redis);
  const enqueuer = new ReceiptEnqueuer(repo, tickQueue, (err) =>
    console.error("[asp] receipt tick signal failed (receipt is still durable):", err),
  );

  console.log("[asp] receipt writer wired — preflight_payment will enqueue durable receipts.");

  return {
    enqueuer,
    async status(receiptId: string) {
      if (!isReceiptId(receiptId)) return "invalid";
      return getReceiptStatus(repo, receiptId as Hex);
    },
    async close() {
      await tickQueue.close();
      await redis.quit();
      await pool.end();
    },
  };
}
