import type { Hex } from "viem";
import type { ScoreSnapshotRow, SubjectKind } from "./types";

/**
 * The read/write surface the Bureau needs over the shared Postgres — behind an interface so the whole
 * scoring engine is testable against an in-memory source with hand-built REAL records (the same posture
 * receipt-writer/escalation use: memory repo for hermetic tests + the anchor proof, Postgres in prod).
 * The feature math never touches SQL; it consumes these plain records.
 */

/** A DECISION receipt joined with its ledger counterparty — the substrate for order counts, out-of-
 *  policy rate, and the vendor's payout (counterparty) address. `createdAt` is ISO-8601. */
export interface OrderRecord {
  readonly intentHash: Hex;
  readonly vendorId: Hex;
  readonly agentId: Hex;
  /** receipts.decision uint8 (§10.3). APPROVED = a completed receipted order; BLOCKED_* = an attempt. */
  readonly decision: number;
  /** ledger_entries.counterparty for this receipt — the vendor payout address (null if absent). */
  readonly counterparty: string | null;
  readonly createdAt: string;
}

/** A VERIFY receipt — a real delivery-verification result, with its intent provenance. */
export interface VerifyRecord {
  readonly intentHash: Hex;
  readonly vendorId: Hex;
  readonly agentId: Hex;
  /** proof-engine VERIFY_RESULT_CODE (§10.3): 1=PASS 2=FAIL 3=SKIPPED_UNCOMMITTED 4=NOT_IMPLEMENTED. */
  readonly verifyResult: number;
  /** store-committed (authoritative) | caller-supplied (lower confidence) | null (pre-provenance row). */
  readonly provenance: "store-committed" | "caller-supplied" | null;
  readonly createdAt: string;
}

/** An escalation row, joined to a vendor/agent via its intent. Only the fields the Bureau reads. */
export interface EscalationView {
  readonly intentId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly codeExpiresAt: string;
}

export interface ScoreDataSource {
  /** All DECISION receipts for a vendor (any decision) — order count is the APPROVED subset. */
  vendorOrders(vendorId: Hex): Promise<readonly OrderRecord[]>;
  /** All VERIFY receipts for a vendor. */
  vendorVerifies(vendorId: Hex): Promise<readonly VerifyRecord[]>;
  /** Escalations whose intent's vendor is this vendor (join escalations.intent_id → receipts.vendor_id). */
  vendorEscalations(vendorId: Hex): Promise<readonly EscalationView[]>;

  /** All DECISION receipts for a buyer agent. */
  buyerOrders(agentId: Hex): Promise<readonly OrderRecord[]>;
  /** All VERIFY receipts for a buyer agent. */
  buyerVerifies(agentId: Hex): Promise<readonly VerifyRecord[]>;
  /** Escalations whose intent's agent is this buyer (join escalations.intent_id → receipts.agent_id). */
  buyerEscalations(agentId: Hex): Promise<readonly EscalationView[]>;

  /** Upsert the epoch snapshot for a subject (§8 score_snapshots). */
  saveSnapshot(row: ScoreSnapshotRow): Promise<void>;
  /** Stamp the anchored merkle root onto every snapshot in an epoch of a given subject kind. */
  setAnchoredRoot(kind: SubjectKind, epoch: number, root: Hex): Promise<void>;
  /** All snapshots for one subject kind + epoch (the leaves of the merkle tree to anchor). */
  snapshotsForEpoch(kind: SubjectKind, epoch: number): Promise<readonly ScoreSnapshotRow[]>;
}
