/**
 * @untch/receipt-writer — PRD §7.4 receipt writer.
 *
 * Public surface:
 *   • Seller side (enqueue only): ReceiptEnqueuer, getReceiptStatus, PgReceiptsRepo, createPool,
 *     runMigrations, createRedis/createTickQueue, loadStorageConfig.
 *   • Worker side (anchoring): startWorker, loadWorkerConfig, ViemChainAnchor, the state machine.
 *   • Testing / reuse: InMemoryReceiptsRepo, Batcher, flushOnce/reconcileOnce, draftFromDecision.
 */

export * from "./types";
export {
  draftFromDecision,
  draftFromVerify,
  decisionToUint8,
  amountBaseUnits,
  DECISION_NA,
  type VerifyReceiptContext,
  type VerifyIntentProvenance,
} from "./mapping";
export {
  loadStorageConfig,
  loadWorkerConfig,
  MissingEnvError,
  RECEIPTS_CONTRACT_DEFAULT,
  X_LAYER_TESTNET_ID,
  X_LAYER_MAINNET_ID,
  xLayerTestnet,
  type StorageConfig,
  type EnqueueConfig,
  type WorkerConfig,
} from "./config";
export { createPool, runMigrations, type Pool } from "./db";
export { type ReceiptsRepo, type ClaimedBatch } from "./repo";
export { PgReceiptsRepo } from "./repo-pg";
export { InMemoryReceiptsRepo } from "./repo-memory";
export { ViemChainAnchor, type ChainAnchor, type Inclusion } from "./chain";
export { UNTCH_RECEIPTS_ABI, OP_KIND } from "./abi";
export { Batcher, type Scheduler, type FlushReason, type BatcherOptions } from "./batcher";
export {
  flushOnce,
  reconcileOnce,
  type AnchorerDeps,
  type FlushOutcome,
} from "./anchorer";
export { ReceiptEnqueuer } from "./enqueue";
export { getReceiptStatus, isReceiptId } from "./status";
export { createRedis, createTickQueue, createTickWorker, TICK_QUEUE, type TickJob } from "./queue";
export { startWorker, type RunningWorker } from "./worker";
