import type { Address, Hex } from "viem";

/**
 * PRD §7.4 receipt-writer domain types. The on-chain shape is UntchReceipts.Receipt (§10.3); these
 * are its off-chain, Postgres-backed mirror plus the state-machine status the row moves through.
 */

/** §7.4 status ladder. QUEUED→BATCHED→SUBMITTED→CONFIRMED is the happy path; DEGRADED_UNANCHORED is
 *  the retries-exhausted terminal-ish state (the ledger is still durable; the batch can be re-driven). */
export type ReceiptStatus =
  | "QUEUED"
  | "BATCHED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "DEGRADED_UNANCHORED";

/** Batch-level state (internal bookkeeping table). */
export type BatchStatus = "PENDING" | "SUBMITTED" | "CONFIRMED" | "DEGRADED_UNANCHORED";

/** The §10.3 receipt payload minus `schemaVersion` (the contract stamps that). Field order matches
 *  UntchReceipts.Receipt so it maps 1:1 to `logReceipts`. `receiptId` is caller-supplied. */
export interface ReceiptOnchain {
  readonly receiptId: Hex;
  readonly policyId: bigint;
  readonly policyHash: Hex;
  readonly agentId: Hex;
  readonly vendorId: Hex;
  readonly amount: bigint;
  readonly token: Address;
  readonly category: Hex;
  readonly payType: number;
  readonly intentHash: Hex;
  readonly taskHash: Hex;
  readonly decision: number;
  readonly verifyResult: number;
  readonly proofTier: number;
  readonly metadataHash: Hex;
}

/** A ledger entry written at decision time — authoritative regardless of chain state (§8). */
export interface LedgerEntryInput {
  readonly agentId: Hex;
  readonly type: "SPEND" | "BLOCK_SAVED" | "FEE_UNTCH" | "REFUND";
  /** base units, as a decimal string (NUMERIC in Postgres; avoids bigint/JSON friction). */
  readonly amount: string;
  readonly token: Address;
  readonly counterparty: Address | null;
  readonly dayKey: string;
  readonly categoryKey: string | null;
  readonly vendorKey: string | null;
}

/** Everything needed to durably enqueue one receipt: the on-chain payload + the ledger entry it
 *  produces. Written together in one Postgres transaction. */
export interface ReceiptDraft {
  readonly onchain: ReceiptOnchain;
  readonly ledger: LedgerEntryInput;
}

/** What a status poll returns (a minimal slice of the eventual §11 get_ledger tool). */
export interface ReceiptStatusView {
  readonly receiptId: Hex;
  readonly status: ReceiptStatus;
  readonly batchId: number | null;
  readonly txHash: Hex | null;
  readonly blockNumber: number | null;
  readonly onchainBatchId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A batch as the reconcile watcher sees it. */
export interface BatchRow {
  readonly id: number;
  readonly status: BatchStatus;
  readonly receiptCount: number;
  readonly txHash: Hex | null;
  readonly onchainBatchId: number | null;
  readonly attempts: number;
}

/** The immediate, non-blocking response the seller returns from preflight_payment. */
export interface EnqueueResult {
  readonly receiptId: Hex;
  readonly status: "QUEUED";
}
