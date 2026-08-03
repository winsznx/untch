import type { Hex } from "viem";
import type { Pool } from "@untch/receipt-writer";
import type {
  EscalationRow,
  LedgerRow,
  ReceiptRow,
  ReportDataSource,
} from "./datasource";

/**
 * Postgres-backed `ReportDataSource` reading the SHARED instance's `receipts` / `ledger_entries` /
 * `escalations` tables — the durable outputs the policy engine (DECISION receipts), proof engine
 * (VERIFY receipts), receipt writer (anchor tx/block on each row), and escalation service already
 * write. All reads are plain scoped SELECTs; the reports never re-run any engine (I1). Escalation →
 * intent attribution is `escalations.intent_id = receipts.intent_hash`, the SAME join the Bureau uses.
 */
export class PgReportDataSource implements ReportDataSource {
  constructor(private readonly pool: Pool) {}

  async receiptsForIntent(intentHash: Hex): Promise<readonly ReceiptRow[]> {
    const res = await this.pool.query<ReceiptSqlRow>(
      `${RECEIPT_SELECT} WHERE intent_hash = $1 ORDER BY created_at, receipt_id`,
      [intentHash.toLowerCase()],
    );
    return res.rows.map(mapReceipt);
  }

  async ledgerForIntent(intentHash: Hex): Promise<readonly LedgerRow[]> {
    const res = await this.pool.query<LedgerSqlRow>(
      `${LEDGER_SELECT}
         WHERE l.receipt_id IN (SELECT receipt_id FROM receipts_business WHERE intent_hash = $1)
         ORDER BY l.created_at, l.id`,
      [intentHash.toLowerCase()],
    );
    return res.rows.map(mapLedger);
  }

  async escalationsForIntent(intentHash: Hex): Promise<readonly EscalationRow[]> {
    const res = await this.pool.query<EscalationSqlRow>(
      `SELECT intent_id, status, created_at, resolved_at, code_expires_at
         FROM escalations_business WHERE intent_id = $1 ORDER BY created_at`,
      [intentHash.toLowerCase()],
    );
    return res.rows.map(mapEscalation);
  }

  async receiptsForAgentPeriod(
    agentId: Hex,
    fromIso: string,
    toIso: string,
  ): Promise<readonly ReceiptRow[]> {
    const res = await this.pool.query<ReceiptSqlRow>(
      `${RECEIPT_SELECT}
         WHERE agent_id = $1 AND created_at >= $2 AND created_at < $3
         ORDER BY created_at, receipt_id`,
      [agentId.toLowerCase(), fromIso, toIso],
    );
    return res.rows.map(mapReceipt);
  }

  async ledgerForAgentPeriod(
    agentId: Hex,
    fromIso: string,
    toIso: string,
  ): Promise<readonly LedgerRow[]> {
    const res = await this.pool.query<LedgerSqlRow>(
      `${LEDGER_SELECT}
         WHERE l.agent_id = $1 AND l.created_at >= $2 AND l.created_at < $3
         ORDER BY l.created_at, l.id`,
      [agentId.toLowerCase(), fromIso, toIso],
    );
    return res.rows.map(mapLedger);
  }

  async escalationsForAgentPeriod(
    agentId: Hex,
    fromIso: string,
    toIso: string,
  ): Promise<readonly EscalationRow[]> {
    const res = await this.pool.query<EscalationSqlRow>(
      `SELECT e.intent_id, e.status, e.created_at, e.resolved_at, e.code_expires_at
         FROM escalations_business e
        WHERE e.created_at >= $2 AND e.created_at < $3
          AND EXISTS (SELECT 1 FROM receipts_business r WHERE r.intent_hash = e.intent_id AND r.agent_id = $1)
        ORDER BY e.created_at`,
      [agentId.toLowerCase(), fromIso, toIso],
    );
    return res.rows.map(mapEscalation);
  }
}

/*
 * Reports read `receipts_business`, not `receipts`.
 *
 * A dispute packet and a reconciliation are the accounting surface: what they list is what somebody
 * treats as having happened. Migration 022 annotates rows that exist but did not happen — the three
 * receipts a rolled-back validation enqueued on 2026-08-02 — and the view applies that annotation.
 *
 * The view is the mechanism rather than a NOT EXISTS clause added to each query below, because the
 * next query added to this file would not have one. The unfiltered table is still reachable through
 * `receipts_audit`, which carries the annotation alongside the row.
 */
const RECEIPT_SELECT = `
  SELECT receipt_id, kind, status, intent_hash, policy_id, policy_hash, agent_id, vendor_id,
         amount, token, category, pay_type, task_hash, decision, verify_result, proof_tier,
         metadata_hash, provenance, batch_id, tx_hash, block_number, created_at
    FROM receipts_business`;

/** Same rule as `RECEIPT_SELECT`: a SPEND nobody funded must not reach a total somebody reads. */
const LEDGER_SELECT = `
  SELECT l.receipt_id, l.agent_id, l.type, l.amount, l.token, l.counterparty, l.day_key,
         l.category_key, l.vendor_key, l.created_at
    FROM ledger_entries_business l`;

interface ReceiptSqlRow {
  receipt_id: string;
  kind: string;
  status: string;
  intent_hash: string;
  policy_id: string;
  policy_hash: string;
  agent_id: string;
  vendor_id: string;
  amount: string;
  token: string;
  category: string;
  pay_type: number;
  task_hash: string;
  decision: number;
  verify_result: number;
  proof_tier: number;
  metadata_hash: string;
  provenance: string | null;
  batch_id: string | null;
  tx_hash: string | null;
  block_number: string | null;
  created_at: Date;
}

interface LedgerSqlRow {
  receipt_id: string;
  agent_id: string;
  type: string;
  amount: string;
  token: string;
  counterparty: string | null;
  day_key: string;
  category_key: string | null;
  vendor_key: string | null;
  created_at: Date;
}

interface EscalationSqlRow {
  intent_id: string;
  status: string;
  created_at: Date;
  resolved_at: Date | null;
  code_expires_at: Date;
}

function mapReceipt(r: ReceiptSqlRow): ReceiptRow {
  return {
    receiptId: r.receipt_id as Hex,
    kind: r.kind === "VERIFY" ? "VERIFY" : "DECISION",
    status: r.status,
    intentHash: r.intent_hash as Hex,
    policyId: r.policy_id,
    policyHash: r.policy_hash as Hex,
    agentId: r.agent_id as Hex,
    vendorId: r.vendor_id as Hex,
    amount: r.amount,
    token: r.token,
    category: r.category as Hex,
    payType: r.pay_type,
    taskHash: r.task_hash as Hex,
    decision: r.decision,
    verifyResult: r.verify_result,
    proofTier: r.proof_tier,
    metadataHash: r.metadata_hash as Hex,
    provenance:
      r.provenance === "store-committed" || r.provenance === "caller-supplied" ? r.provenance : null,
    batchId: r.batch_id !== null ? Number(r.batch_id) : null,
    txHash: (r.tx_hash as Hex | null) ?? null,
    blockNumber: r.block_number !== null ? Number(r.block_number) : null,
    createdAt: r.created_at.toISOString(),
  };
}

function mapLedger(r: LedgerSqlRow): LedgerRow {
  return {
    receiptId: r.receipt_id as Hex,
    agentId: r.agent_id as Hex,
    type: r.type === "SPEND" || r.type === "AUTHORITY_RESERVED" || r.type === "BLOCK_SAVED" || r.type === "FEE_UNTCH" || r.type === "REFUND"
      ? r.type
      : "SPEND",
    amount: r.amount,
    token: r.token,
    counterparty: r.counterparty,
    dayKey: r.day_key,
    categoryKey: r.category_key,
    vendorKey: r.vendor_key,
    createdAt: r.created_at.toISOString(),
  };
}

function mapEscalation(r: EscalationSqlRow): EscalationRow {
  return {
    intentId: r.intent_id,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    codeExpiresAt: r.code_expires_at.toISOString(),
  };
}
