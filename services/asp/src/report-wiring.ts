import {
  AuditAnchorer,
  PgReportDataSource,
  AUDIT_ANCHOR_CHAIN,
  AUDIT_RECEIPTS_CONTRACT,
  DEFAULT_RPC_URL,
  type ReportAnchorer,
  type ReportDataSource,
} from "@untch/reports";
import { createPool, type Pool } from "@untch/receipt-writer";
import type { Address, Hex } from "viem";

/**
 * Optional §11 report-tool wiring for the seller. When DATABASE_URL is present (the Railway production
 * deploy), generate_dispute_packet / reconcile_agent_spend read the SHARED Postgres receipt / ledger /
 * escalation history (owned by receipt-writer + escalation — their migrations run via initReceiptWiring
 * / initEscalationWiring). When it is absent (local dev, unit tests), this stays null and the routes
 * 503 — an honest "no report store configured".
 *
 * ANCHORING posture (matches trust-bureau): the seller does NOT hold the writer key by default, so
 * per-call on-chain anchoring is OFF and the tool returns the assembled artifact + reportHash with
 * `anchor: null` (the reportHash is what the anchor job / prove scripts anchor). Set
 * REPORT_ANCHOR_WRITER_KEY (an authorized UntchReceipts writer) to DELIBERATELY enable per-call
 * anchoring on this instance — then the tool anchors via anchorAudit and returns the real tx.
 */
export interface ReportWiring {
  readonly dataSource: ReportDataSource;
  readonly anchorer: ReportAnchorer | null;
  close(): Promise<void>;
}

export async function initReportWiring(): Promise<ReportWiring | null> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.log("[asp] reports NOT wired (DATABASE_URL unset) — dispute/reconcile will 503.");
    return null;
  }

  const pool: Pool = createPool(databaseUrl);
  const dataSource = new PgReportDataSource(pool);

  let anchorer: ReportAnchorer | null = null;
  const writerKey = process.env.REPORT_ANCHOR_WRITER_KEY?.trim();
  if (writerKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(writerKey)) {
      throw new Error("REPORT_ANCHOR_WRITER_KEY is set but is not a valid 0x 32-byte private key");
    }
    const rpcUrl = process.env.RPC_URL?.trim() || DEFAULT_RPC_URL;
    const contract =
      (process.env.RECEIPTS_CONTRACT?.trim() as Address | undefined) ?? AUDIT_RECEIPTS_CONTRACT;
    anchorer = new AuditAnchorer({
      chain: AUDIT_ANCHOR_CHAIN,
      rpcUrl,
      contract,
      writerPrivateKey: writerKey as Hex,
    });
    console.log(
      `[asp] reports wired WITH per-call anchoring — anchorAudit on ${contract} (writer ${(anchorer as AuditAnchorer).writerAddress}).`,
    );
  } else {
    console.log(
      "[asp] reports wired (assembly only) — per-call anchoring OFF (REPORT_ANCHOR_WRITER_KEY unset); reportHash returned for the anchor job to anchor.",
    );
  }

  return {
    dataSource,
    anchorer,
    async close() {
      await pool.end();
    },
  };
}
