import { assembleReconcileReport, hashReconcileReport } from "./reconcile";
import { parsePeriod } from "./period";
import { MemoryReportDataSource } from "./datasource-memory";
import { AuditAnchorer } from "./anchor";
import { AUDIT_ANCHOR_CHAIN, AUDIT_RECEIPTS_CONTRACT, DEFAULT_RPC_URL } from "./config";
import { realDecision, realVerify } from "./prove-helpers";
import type { EscalationRow } from "./datasource";
import { toHex, type Address, type Hex } from "viem";

/**
 * One-shot REAL end-to-end §11 proof for `reconcile_agent_spend`, self-contained (no seller, no DB):
 *
 *   1. Produce REAL receipts for ONE agent over a period by running the REAL @untch/policy-engine
 *      (asserted APPROVED ×2, BLOCKED_BUDGET ×2, ESCALATED_THRESHOLD ×1) and the REAL @untch/proof-engine
 *      (asserted VERIFY_PASSED + VERIFY_FAILED), all mapped to on-chain payloads by receipt-writer.
 *   2. Seed a data source and read them back through the REAL period-window query.
 *   3. Assemble the reconciliation report (spend, blocked-waste, escalated exposure, breakdown,
 *      verifications), then HASH it (RFC 8785 JCS).
 *   4. Anchor the hash on the deployed UntchReceipts via a REAL writer-signed `anchorAudit` transaction
 *      (§10.3 AuditAnchored, period = the window start) — no mocked settlement.
 *   5. INDEPENDENTLY verify AuditAnchored via raw eth_getLogs, reportHash RECOMPUTED from the report.
 *
 * Needs: WRITER_PRIVATE_KEY (an authorized UntchReceipts writer). RPC_URL / RECEIPTS_CONTRACT default to
 * X Layer testnet + the deployed §10.3 contract.
 * Run: WRITER_PRIVATE_KEY=0x… pnpm --filter @untch/reports prove:reconcile-anchor
 */

const AGENT_ID: Hex = toHex(42n, { size: 32 }); // matches buildIntent's buyerAgentId (42)
const PERIOD = parsePeriod("2026-07-11");
const ASSEMBLED_AT = "2026-07-11T23:59:00.000Z";
const at = (hhmm: string) => `2026-07-11T${hhmm}:00.000Z`;

async function main(): Promise<void> {
  const writerKey = process.env.WRITER_PRIVATE_KEY?.trim();
  if (!writerKey || !/^0x[0-9a-fA-F]{64}$/.test(writerKey)) {
    throw new Error("WRITER_PRIVATE_KEY (0x 32-byte) is required");
  }
  const rpcUrl = process.env.RPC_URL?.trim() || DEFAULT_RPC_URL;
  const contract = (process.env.RECEIPTS_CONTRACT?.trim() as Address | undefined) ?? AUDIT_RECEIPTS_CONTRACT;

  const ds = new MemoryReportDataSource();

  // Two REAL approved spends (0.5 each moved).
  for (const [i, t] of [["a0", "09:00"], ["a1", "09:30"]].entries()) {
    const d = realDecision({ tag: t[0]!, expected: "APPROVED", intent: { nonce: BigInt(100 + i) }, createdAt: at(t[1]!) });
    ds.addReceipt(d.receipt);
    if (d.ledger) ds.addLedger(d.ledger);
  }
  // Two REAL blocked-budget attempts (0.5 each waste): daily 25, already spent 24.8 → 25.3 > 25.
  for (const [i, t] of [["b0", "10:00"], ["b1", "10:30"]].entries()) {
    const d = realDecision({
      tag: t[0]!,
      expected: "BLOCKED_BUDGET",
      policy: { budgets: { daily: 25, token: "USDT" } },
      ledger: { spentTodayByAgent: 24.8 },
      intent: { nonce: BigInt(200 + i) },
      createdAt: at(t[1]!),
    });
    ds.addReceipt(d.receipt);
    if (d.ledger) ds.addLedger(d.ledger);
  }
  // One REAL escalated-threshold attempt (0.5 held — NOT waste): escalateAbove 0.3 < amount 0.5.
  {
    const d = realDecision({
      tag: "e0",
      expected: "ESCALATED_THRESHOLD",
      policy: { escalateAbove: 0.3 },
      intent: { nonce: 300n },
      createdAt: at("11:00"),
    });
    ds.addReceipt(d.receipt);
    if (d.ledger) ds.addLedger(d.ledger);
    const esc: EscalationRow = {
      intentId: d.receipt.intentHash,
      status: "DENIED",
      createdAt: at("11:01"),
      resolvedAt: at("11:20"),
      codeExpiresAt: at("11:31"),
    };
    ds.addEscalation(esc);
  }
  // One REAL T0 PASS and one REAL T0 FAIL verification.
  {
    const dPass = realDecision({ tag: "v0", expected: "APPROVED", intent: { nonce: 400n }, createdAt: at("12:00") });
    ds.addReceipt(dPass.receipt);
    if (dPass.ledger) ds.addLedger(dPass.ledger);
    const vPass = realVerify({
      tag: "v0",
      intentHash: dPass.receipt.intentHash,
      criteria: { requiredFields: ["symbol", "price"] },
      delivery: { payload: { symbol: "OKB", price: 42.5 } },
      expectedFinal: "VERIFY_PASSED",
      createdAt: at("12:05"),
    });
    ds.addReceipt(vPass.receipt);

    const dFail = realDecision({ tag: "v1", expected: "APPROVED", intent: { nonce: 500n }, createdAt: at("13:00") });
    ds.addReceipt(dFail.receipt);
    if (dFail.ledger) ds.addLedger(dFail.ledger);
    const vFail = realVerify({
      tag: "v1",
      intentHash: dFail.receipt.intentHash,
      criteria: { requiredFields: ["symbol", "price"] },
      delivery: { payload: { symbol: "OKB" } }, // missing `price` → real T0 FAIL
      expectedFinal: "VERIFY_FAILED",
      createdAt: at("13:05"),
    });
    ds.addReceipt(vFail.receipt);
  }

  // 2. Read back through the REAL period-window query.
  const [receipts, ledger, escalations] = await Promise.all([
    ds.receiptsForAgentPeriod(AGENT_ID, PERIOD.fromIso, PERIOD.toIso),
    ds.ledgerForAgentPeriod(AGENT_ID, PERIOD.fromIso, PERIOD.toIso),
    ds.escalationsForAgentPeriod(AGENT_ID, PERIOD.fromIso, PERIOD.toIso),
  ]);

  // 3. Assemble + hash.
  const report = assembleReconcileReport(AGENT_ID, PERIOD, receipts, ledger, escalations, { assembledAt: ASSEMBLED_AT });
  const reportHash = hashReconcileReport(report);

  console.log(`[prove] chain    : ${AUDIT_ANCHOR_CHAIN.name} (${AUDIT_ANCHOR_CHAIN.id})`);
  console.log(`[prove] contract : ${contract}`);
  console.log(`[prove] agent    : ${AGENT_ID}   period=${PERIOD.label} (code ${PERIOD.periodCode})`);
  console.log(`[prove] spend    : approved=${report.spend.approvedCount} total=${report.spend.totals[0]?.totalDisplay ?? "0"}`);
  console.log(`[prove] blocked  : count=${report.blockedWaste.blockedCount} waste=${report.blockedWaste.totals[0]?.totalDisplay ?? "0"}`);
  console.log(`[prove] escalated: count=${report.escalatedExposure.escalatedCount} held=${report.escalatedExposure.totals[0]?.totalDisplay ?? "0"}`);
  console.log(`[prove] verifies : total=${report.verifications.total} pass=${report.verifications.passed} fail=${report.verifications.failed}`);
  console.log(`[prove] reportHash: ${reportHash}`);

  // 4. REAL anchor (period = window start).
  const anchorer = new AuditAnchorer({ chain: AUDIT_ANCHOR_CHAIN, rpcUrl, contract, writerPrivateKey: writerKey as Hex });
  console.log(`[prove] writer   : ${anchorer.writerAddress}`);
  console.log(`[prove] anchoring anchorAudit(reportHash, agentId, period=${PERIOD.periodCode}) …`);
  const anchored = await anchorer.anchor(reportHash, AGENT_ID, PERIOD.periodCode);
  console.log(`[prove] anchor tx: ${anchored.txHash} (block ${anchored.blockNumber})`);

  // 5. INDEPENDENT raw-RPC verification — reportHash RECOMPUTED from the report.
  const recomputed = hashReconcileReport(report);
  if (recomputed.toLowerCase() !== reportHash.toLowerCase()) throw new Error("report hash is not reproducible");
  console.log(`[prove] verifying AuditAnchored via raw eth_getLogs (independent of this script) …`);
  const matchTx = await anchorer.verifyAnchored(
    { reportHash: recomputed, agentId: AGENT_ID, period: PERIOD.periodCode },
    anchored.blockNumber,
    anchored.txHash,
  );
  if (!matchTx) throw new Error(`AuditAnchored(reportHash=${reportHash}) NOT found on-chain`);

  console.log("");
  console.log("RESULT: PASS — real reconciliation report assembled from real policy/proof/receipt/escalation history, hashed, and anchored on UntchReceipts.anchorAudit (AuditAnchored).");
  console.log(`reportHash : ${reportHash}`);
  console.log(`agentId    : ${AGENT_ID}   period: ${PERIOD.label} (code ${PERIOD.periodCode})`);
  console.log(`anchor tx  : ${matchTx}`);
  console.log(`explorer   : https://www.oklink.com/x-layer-testnet/tx/${matchTx}`);
  console.log(`verified   : raw eth_getLogs decoded AuditAnchored and matched reportHash+agentId+period`);
}

main().catch((err) => {
  console.error(`[prove] FAIL: ${(err as Error).message}`);
  process.exit(1);
});
