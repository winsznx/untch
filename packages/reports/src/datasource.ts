import type { Hex } from "viem";

/**
 * The read surface the report tools need over the SHARED Postgres — behind an interface so the whole
 * assembly is testable against an in-memory source seeded with REAL records (the same posture
 * receipt-writer / escalation / trust-bureau use). The assembly never touches SQL; it consumes these
 * plain records. Nothing here writes: reports are derived views over already-durable, already-anchored
 * history, not new facts, so there is no reports table to persist to (a report is deterministically
 * reproducible from these rows).
 */

/** A `receipts` row — DECISION or VERIFY — with its on-chain anchor fields. `amount` is base units as a
 *  decimal string (NUMERIC in Postgres). `createdAt` is ISO-8601 UTC. */
export interface ReceiptRow {
  readonly receiptId: Hex;
  readonly kind: "DECISION" | "VERIFY";
  readonly status: string;
  readonly intentHash: Hex;
  readonly policyId: string;
  readonly policyHash: Hex;
  readonly agentId: Hex;
  readonly vendorId: Hex;
  readonly amount: string;
  readonly token: string;
  /** keccak of the category string (§10.3 on-chain carries the hash, not the plaintext). */
  readonly category: Hex;
  readonly payType: number;
  readonly taskHash: Hex;
  readonly decision: number;
  readonly verifyResult: number;
  readonly proofTier: number;
  readonly metadataHash: Hex;
  readonly provenance: "store-committed" | "caller-supplied" | null;
  /** UntchReceipts batch id once anchored (null while QUEUED/unbatched). */
  readonly batchId: number | null;
  readonly txHash: Hex | null;
  readonly blockNumber: number | null;
  readonly createdAt: string;
}

/** A `ledger_entries` row — the authoritative money record (§8), written at decision time. */
export interface LedgerRow {
  readonly receiptId: Hex;
  readonly agentId: Hex;
  /** `AUTHORITY_RESERVED` is an approved decision: authority granted, no money moved. */
  readonly type: "SPEND" | "AUTHORITY_RESERVED" | "BLOCK_SAVED" | "FEE_UNTCH" | "REFUND";
  readonly amount: string;
  readonly token: string;
  readonly counterparty: string | null;
  readonly dayKey: string;
  readonly categoryKey: string | null;
  readonly vendorKey: string | null;
  readonly createdAt: string;
}

/** An `escalations` row (the escalation service's resolution history), joined to a subject via its
 *  intent. `intentId` is the intentHash (escalations.intent_id = receipts.intent_hash). */
export interface EscalationRow {
  readonly intentId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly codeExpiresAt: string;
}

/** Read surface for the two report tools. All reads are plain, scoped SELECTs. */
export interface ReportDataSource {
  /** All receipts (DECISION + VERIFY) for one intent, oldest first — the dispute packet's substrate. */
  receiptsForIntent(intentHash: Hex): Promise<readonly ReceiptRow[]>;
  /** Ledger entries produced by that intent's receipts. */
  ledgerForIntent(intentHash: Hex): Promise<readonly LedgerRow[]>;
  /** Escalations raised for that intent (its resolution history). */
  escalationsForIntent(intentHash: Hex): Promise<readonly EscalationRow[]>;

  /** All receipts for a buyer agent whose `created_at` falls in [fromIso, toIso). */
  receiptsForAgentPeriod(agentId: Hex, fromIso: string, toIso: string): Promise<readonly ReceiptRow[]>;
  /** All ledger entries for a buyer agent whose `created_at` falls in [fromIso, toIso). */
  ledgerForAgentPeriod(agentId: Hex, fromIso: string, toIso: string): Promise<readonly LedgerRow[]>;
  /** All escalations for a buyer agent whose `created_at` falls in [fromIso, toIso). */
  escalationsForAgentPeriod(
    agentId: Hex,
    fromIso: string,
    toIso: string,
  ): Promise<readonly EscalationRow[]>;
}
