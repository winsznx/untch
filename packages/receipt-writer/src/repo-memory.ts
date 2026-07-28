import type { Hex } from "viem";
import type { ClaimedBatch, ReceiptsRepo } from "./repo";
import type {
  BatchRow,
  BatchStatus,
  LedgerEntryInput,
  ReceiptDraft,
  ReceiptOnchain,
  ReceiptStatus,
  ReceiptStatusView,
} from "./types";

/**
 * In-memory `ReceiptsRepo` for hermetic tests — same transition semantics as `PgReceiptsRepo`, no
 * database. Lets the batching/retry/reorg state machine be tested with `node --test` and nothing else
 * running. NOT for production (no durability across process restart — that is exactly what Postgres
 * provides and this deliberately does not).
 */

interface StoredReceipt {
  onchain: ReceiptOnchain;
  status: ReceiptStatus;
  batchId: number | null;
  txHash: Hex | null;
  blockNumber: number | null;
  createdAt: number;
}

interface StoredBatch {
  id: number;
  status: BatchStatus;
  receiptCount: number;
  txHash: Hex | null;
  onchainBatchId: number | null;
  attempts: number;
}

export class InMemoryReceiptsRepo implements ReceiptsRepo {
  private readonly receipts = new Map<Hex, StoredReceipt>();
  private readonly batches = new Map<number, StoredBatch>();
  private seq = 0;
  private batchSeq = 0;
  readonly ledger: LedgerEntryInput[] = [];

  async insertDraft(draft: ReceiptDraft): Promise<void> {
    if (this.receipts.has(draft.onchain.receiptId)) return;
    this.receipts.set(draft.onchain.receiptId, {
      onchain: draft.onchain,
      status: "QUEUED",
      batchId: null,
      txHash: null,
      blockNumber: null,
      createdAt: this.seq++,
    });
    // A VERIFY receipt has no ledger entry (moves no money); only DECISION receipts do.
    if (draft.ledger) this.ledger.push(draft.ledger);
  }

  async claimQueuedBatch(limit: number): Promise<ClaimedBatch | null> {
    const queued = [...this.receipts.values()]
      .filter((r) => r.status === "QUEUED")
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
    if (queued.length === 0) return null;

    const batchId = ++this.batchSeq;
    this.batches.set(batchId, {
      id: batchId,
      status: "PENDING",
      receiptCount: queued.length,
      txHash: null,
      onchainBatchId: null,
      attempts: 0,
    });
    for (const r of queued) {
      r.status = "BATCHED";
      r.batchId = batchId;
    }
    return { batchId, receipts: queued.map((r) => r.onchain) };
  }

  async markSubmitted(batchId: number, txHash: Hex): Promise<void> {
    const b = this.batches.get(batchId);
    if (b) {
      b.status = "SUBMITTED";
      b.txHash = txHash;
    }
    for (const r of this.receipts.values()) {
      if (r.batchId === batchId) {
        r.status = "SUBMITTED";
        r.txHash = txHash;
      }
    }
  }

  async markConfirmed(
    batchId: number,
    onchainBatchId: number | null,
    blockNumber: number,
  ): Promise<void> {
    const b = this.batches.get(batchId);
    if (b) {
      b.status = "CONFIRMED";
      b.onchainBatchId = onchainBatchId;
    }
    for (const r of this.receipts.values()) {
      if (r.batchId === batchId) {
        r.status = "CONFIRMED";
        r.blockNumber = blockNumber;
      }
    }
  }

  async recordBatchError(batchId: number, _message: string): Promise<void> {
    const b = this.batches.get(batchId);
    if (b) b.attempts += 1;
  }

  async redriveDegraded(batchId: number): Promise<boolean> {
    const b = this.batches.get(batchId);
    if (!b || b.status !== "DEGRADED_UNANCHORED") return false;
    b.status = "PENDING";
    b.attempts = 0;
    for (const r of this.receipts.values()) {
      if (r.batchId === batchId) r.status = "BATCHED";
    }
    return true;
  }

  async markDegraded(batchId: number): Promise<void> {
    const b = this.batches.get(batchId);
    if (b) b.status = "DEGRADED_UNANCHORED";
    for (const r of this.receipts.values()) {
      if (r.batchId === batchId) r.status = "DEGRADED_UNANCHORED";
    }
  }

  async batchesByStatus(status: BatchStatus): Promise<BatchRow[]> {
    return [...this.batches.values()]
      .filter((b) => b.status === status)
      .map((b) => ({
        id: b.id,
        status: b.status,
        receiptCount: b.receiptCount,
        txHash: b.txHash,
        onchainBatchId: b.onchainBatchId,
        attempts: b.attempts,
      }));
  }

  async receiptsForBatch(batchId: number): Promise<ReceiptOnchain[]> {
    return [...this.receipts.values()]
      .filter((r) => r.batchId === batchId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => r.onchain);
  }

  async statusOf(receiptId: Hex): Promise<ReceiptStatusView | null> {
    const r = this.receipts.get(receiptId);
    if (!r) return null;
    const b = r.batchId === null ? null : this.batches.get(r.batchId);
    return {
      receiptId,
      status: r.status,
      batchId: r.batchId,
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      onchainBatchId: b?.onchainBatchId ?? null,
      createdAt: String(r.createdAt),
      updatedAt: String(r.createdAt),
    };
  }

  async countReceiptsByStatus(status: ReceiptStatus): Promise<number> {
    let n = 0;
    for (const r of this.receipts.values()) if (r.status === status) n++;
    return n;
  }
}
