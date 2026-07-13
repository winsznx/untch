import type { Hex } from "viem";
import type {
  BatchRow,
  BatchStatus,
  ReceiptDraft,
  ReceiptOnchain,
  ReceiptStatus,
  ReceiptStatusView,
} from "./types";

/** A batch just claimed out of the QUEUED pool, ready to submit on-chain. */
export interface ClaimedBatch {
  readonly batchId: number;
  readonly receipts: readonly ReceiptOnchain[];
}

/**
 * The durable store the state machine drives. Two implementations back it: `PgReceiptsRepo`
 * (production, real Postgres) and `InMemoryReceiptsRepo` (hermetic tests). The state machine only
 * ever touches this interface, so the batching/retry/reorg logic is tested with NO database.
 *
 * DURABILITY CONTRACT: `insertDraft` must persist the receipt (QUEUED) and its ledger entry together,
 * atomically, before returning. Everything after that (batching, submitting, confirming) only ever
 * moves an already-durable row between states — nothing is lost if the process dies mid-flight.
 */
export interface ReceiptsRepo {
  /** Durably persist one receipt (QUEUED) + its ledger entry in a single transaction. */
  insertDraft(draft: ReceiptDraft): Promise<void>;

  /** Atomically claim up to `limit` QUEUED receipts into a new PENDING batch (receipts → BATCHED).
   *  Returns null if nothing is queued. Concurrent callers never claim the same receipt. */
  claimQueuedBatch(limit: number): Promise<ClaimedBatch | null>;

  /** Batch + its receipts → SUBMITTED with this tx hash. Also used to overwrite the tx hash on a
   *  reorg-driven resubmit of an already-SUBMITTED batch. */
  markSubmitted(batchId: number, txHash: Hex): Promise<void>;

  /** Batch + its receipts → CONFIRMED at `blockNumber` (and the on-chain BatchLogged id, if known). */
  markConfirmed(batchId: number, onchainBatchId: number | null, blockNumber: number): Promise<void>;

  /** Record a failed attempt (increments `attempts`, stores the message). Does not change status. */
  recordBatchError(batchId: number, message: string): Promise<void>;

  /** Batch + its receipts → DEGRADED_UNANCHORED (retries exhausted). Rows are kept, never deleted. */
  markDegraded(batchId: number): Promise<void>;

  batchesByStatus(status: BatchStatus): Promise<BatchRow[]>;
  receiptsForBatch(batchId: number): Promise<ReceiptOnchain[]>;

  /** Minimal status slice for a single receipt (the eventual §11 get_ledger, one-receipt scope). */
  statusOf(receiptId: Hex): Promise<ReceiptStatusView | null>;

  countReceiptsByStatus(status: ReceiptStatus): Promise<number>;
}
