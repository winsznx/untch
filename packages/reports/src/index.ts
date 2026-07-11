/**
 * @untch/reports — PRD §11 report tools: `generate_dispute_packet` and `reconcile_agent_spend`.
 *
 * Deterministic, NO-LLM (I1) aggregation over the durable receipt / ledger / escalation history that
 * policy-engine, proof-engine, the receipt writer, and the escalation service already produce. Each
 * tool assembles a real evidence artifact, hashes it (RFC 8785 JCS via @untch/canon), and anchors it
 * on-chain by REUSING UntchReceipts.anchorAudit (§10.3 AuditAnchored) — see README for the decision.
 *
 * Public surface:
 *   • Assembly (pure): assembleDisputePacket / hashDisputePacket, assembleReconcileReport /
 *     hashReconcileReport, parsePeriod.
 *   • Data source: ReportDataSource + PgReportDataSource (prod) + MemoryReportDataSource (tests/proofs).
 *   • Anchoring: AuditAnchorer (real anchorAudit tx + raw-RPC AuditAnchored verification), ReportAnchorer.
 *   • Config + code decoders.
 */

export type {
  ReceiptRow,
  LedgerRow,
  EscalationRow,
  ReportDataSource,
} from "./datasource";
export { PgReportDataSource } from "./datasource-pg";
export { MemoryReportDataSource } from "./datasource-memory";

export {
  assembleDisputePacket,
  hashDisputePacket,
  AMOUNT_DECIMALS,
  type DisputePacket,
  type DecisionSection,
  type VerifyResultEntry,
  type EscalationEntry,
  type TimelineEvent,
  type AssembleDisputeOptions,
} from "./dispute";

export {
  assembleReconcileReport,
  hashReconcileReport,
  type ReconcileReport,
  type TokenTotal,
  type AssembleReconcileOptions,
} from "./reconcile";

export { parsePeriod, PeriodParseError, type Period, type PeriodKind } from "./period";

export {
  AuditAnchorer,
  type AuditAnchorerOptions,
  type AuditAnchorResult,
  type ReportAnchorer,
} from "./anchor";

export {
  AUDIT_ANCHOR_CHAIN,
  AUDIT_RECEIPTS_CONTRACT,
  DEFAULT_RPC_URL,
  loadAnchorConfig,
  MissingEnvError,
  type AnchorConfig,
} from "./config";

export {
  decisionName,
  decisionCategory,
  verifyName,
  APPROVED_CODE,
  BLOCKED_CODES,
  ESCALATED_CODES,
  type DecisionCategory,
} from "./codes";
