import type { Hex } from "viem";
import type {
  EscalationRow,
  LedgerRow,
  ReceiptRow,
  ReportDataSource,
} from "./datasource";

/**
 * In-memory `ReportDataSource` for hermetic tests and the anchor proofs. Seeded with REAL records —
 * the proofs drive genuine policy-engine / proof-engine outputs (via receipt-writer's `draftFrom*`)
 * into it, so an assembled report is genuinely derived, not fabricated. No database; not for production.
 */
export class MemoryReportDataSource implements ReportDataSource {
  private readonly receipts: ReceiptRow[] = [];
  private readonly ledger: LedgerRow[] = [];
  private readonly escalations: EscalationRow[] = [];

  addReceipt(r: ReceiptRow): this {
    this.receipts.push(r);
    return this;
  }
  addLedger(l: LedgerRow): this {
    this.ledger.push(l);
    return this;
  }
  addEscalation(e: EscalationRow): this {
    this.escalations.push(e);
    return this;
  }

  async receiptsForIntent(intentHash: Hex): Promise<readonly ReceiptRow[]> {
    return this.receipts
      .filter((r) => eq(r.intentHash, intentHash))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async ledgerForIntent(intentHash: Hex): Promise<readonly LedgerRow[]> {
    const ids = new Set(
      this.receipts.filter((r) => eq(r.intentHash, intentHash)).map((r) => r.receiptId.toLowerCase()),
    );
    return this.ledger
      .filter((l) => ids.has(l.receiptId.toLowerCase()))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async escalationsForIntent(intentHash: Hex): Promise<readonly EscalationRow[]> {
    return this.escalations
      .filter((e) => e.intentId.toLowerCase() === intentHash.toLowerCase())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async receiptsForAgentPeriod(
    agentId: Hex,
    fromIso: string,
    toIso: string,
  ): Promise<readonly ReceiptRow[]> {
    return this.receipts
      .filter((r) => eq(r.agentId, agentId) && inWindow(r.createdAt, fromIso, toIso))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async ledgerForAgentPeriod(
    agentId: Hex,
    fromIso: string,
    toIso: string,
  ): Promise<readonly LedgerRow[]> {
    return this.ledger
      .filter((l) => eq(l.agentId, agentId) && inWindow(l.createdAt, fromIso, toIso))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async escalationsForAgentPeriod(
    agentId: Hex,
    fromIso: string,
    toIso: string,
  ): Promise<readonly EscalationRow[]> {
    const agentIntents = new Set(
      this.receipts.filter((r) => eq(r.agentId, agentId)).map((r) => r.intentHash.toLowerCase()),
    );
    return this.escalations
      .filter((e) => agentIntents.has(e.intentId.toLowerCase()) && inWindow(e.createdAt, fromIso, toIso))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

function eq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
function inWindow(iso: string, fromIso: string, toIso: string): boolean {
  return iso >= fromIso && iso < toIso;
}
