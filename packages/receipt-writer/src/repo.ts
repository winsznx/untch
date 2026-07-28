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

  /**
   * Operator re-drive: return a DEGRADED_UNANCHORED batch to PENDING so the anchorer picks it up.
   *
   * DEGRADED_UNANCHORED is terminal for the AUTOMATIC anchorer, and that is correct — a batch that has
   * burned its retry budget must stop consuming the loop, and the durable ledger stays authoritative
   * either way. But "the automation gave up" is not "this can never be anchored". The retries are
   * exhausted precisely when something outside the process is wrong — an RPC outage, a contract pause,
   * or, in the case this was written for, a signer with no gas. Once that is fixed the receipt is
   * still perfectly valid and still deserves its anchor.
   *
   * This re-drives the SAME batch with the SAME receiptId. It never mints a replacement receipt: a
   * new id would break every reference already handed out and would quietly assert that the original
   * decision did not happen.
   *
   * Deliberately NOT called from any loop. An operator runs it after fixing the cause, because
   * automatic re-drive would just re-burn the budget against a condition nothing has changed.
   *
   * Returns false when the batch does not exist or is not DEGRADED_UNANCHORED — re-driving a
   * CONFIRMED batch would double-anchor it.
   */
  redriveDegraded(batchId: number): Promise<boolean>;

  batchesByStatus(status: BatchStatus): Promise<BatchRow[]>;
  receiptsForBatch(batchId: number): Promise<ReceiptOnchain[]>;

  /** Minimal status slice for a single receipt (the eventual §11 get_ledger, one-receipt scope). */
  statusOf(receiptId: Hex): Promise<ReceiptStatusView | null>;

  countReceiptsByStatus(status: ReceiptStatus): Promise<number>;
}
