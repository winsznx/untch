import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MemoryReportDataSource,
  type AuditAnchorResult,
  type ReportAnchorer,
} from "@untch/reports";
import { decisionToUint8 } from "@untch/receipt-writer";
import { keccak256, toHex, type Hex } from "viem";
import { handleGenerateDisputePacket, handleReconcileAgentSpend } from "../src/report-handlers";

/**
 * Handler-level tests for the two §11 report tools with the REAL assembly + an in-memory data source.
 * No network, no x402 (the payment gate is server-level). A recording fake anchorer asserts the ANCHOR
 * CALL carries the right reportHash/agentId/period and that its tx is surfaced verbatim.
 */

const AGENT = toHex(9n, { size: 32 });
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const POLICY_HASH = keccak256(toHex("p"));
const VENDOR = keccak256(toHex("untch-vendor:api.vendor.example"));
const APPROVED = decisionToUint8("APPROVED");
const BLOCKED_BUDGET = decisionToUint8("BLOCKED_BUDGET");

class RecordingAnchorer implements ReportAnchorer {
  public calls: { reportHash: Hex; agentId: Hex; period: bigint }[] = [];
  async anchor(reportHash: Hex, agentId: Hex, period: bigint): Promise<AuditAnchorResult> {
    this.calls.push({ reportHash, agentId, period });
    return { reportHash, agentId, period, txHash: ("0x" + "ab".repeat(32)) as Hex, blockNumber: 4242 };
  }
}

function decisionRow(intent: Hex, decision: number, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    receiptId: keccak256(toHex(`r:${intent}:${createdAt}`)),
    kind: "DECISION" as const,
    status: "CONFIRMED",
    intentHash: intent,
    policyId: "12",
    policyHash: POLICY_HASH,
    agentId: AGENT,
    vendorId: VENDOR,
    amount: "500000",
    token: TOKEN,
    category: keccak256(toHex("market-data")),
    payType: 0,
    taskHash: keccak256(toHex(`t:${intent}`)),
    decision,
    verifyResult: 0,
    proofTier: 0,
    metadataHash: keccak256(toHex(`m:${intent}`)),
    provenance: null,
    batchId: 1,
    txHash: ("0x" + "cd".repeat(32)) as Hex,
    blockNumber: 10,
    createdAt,
    ...extra,
  };
}

test("generate_dispute_packet: assembles the intent and anchors with agentId + day-bucket period", async () => {
  const intent = keccak256(toHex("dispute-intent"));
  const ds = new MemoryReportDataSource();
  ds.addReceipt(decisionRow(intent, APPROVED, "2026-07-11T10:00:00.000Z"));

  const anchorer = new RecordingAnchorer();
  const res = await handleGenerateDisputePacket({ intentRef: intent }, { dataSource: ds, anchorer });

  assert.equal(res.status, 200);
  const body = res.body as Record<string, any>;
  assert.equal(body.tool, "generate_dispute_packet");
  assert.equal(body.packet.decision.outcome, "APPROVED");
  assert.match(body.reportHash, /^0x[0-9a-f]{64}$/);

  // The anchor call used the packet's own agentId and the UTC day of the earliest receipt.
  assert.equal(anchorer.calls.length, 1);
  assert.equal(anchorer.calls[0]!.agentId.toLowerCase(), AGENT.toLowerCase());
  assert.equal(anchorer.calls[0]!.reportHash, body.reportHash);
  const expectedPeriod = BigInt(Math.floor(Date.parse("2026-07-11T00:00:00Z") / 1000));
  assert.equal(anchorer.calls[0]!.period, expectedPeriod);
  assert.equal(body.anchor.anchored, true);
  assert.equal(body.anchor.txHash, "0x" + "ab".repeat(32));
});

test("generate_dispute_packet: no writer wired → assembled + hashed but honest anchor:null", async () => {
  const intent = keccak256(toHex("no-writer"));
  const ds = new MemoryReportDataSource();
  ds.addReceipt(decisionRow(intent, APPROVED, "2026-07-11T10:00:00.000Z"));

  const res = await handleGenerateDisputePacket({ intentRef: intent }, { dataSource: ds, anchorer: null });
  const body = res.body as Record<string, any>;
  assert.equal(body.anchor.anchored, false);
  assert.equal(body.anchor.txHash, null);
  assert.match(body.reportHash, /^0x[0-9a-f]{64}$/);
  assert.ok(String(body.anchor.note).includes("reportHash"));
});

test("generate_dispute_packet: missing intentRef → 400", async () => {
  const ds = new MemoryReportDataSource();
  const res = await handleGenerateDisputePacket({}, { dataSource: ds, anchorer: null });
  assert.equal(res.status, 400);
  assert.equal((res.body as Record<string, unknown>).code, "INTENT_REF_REQUIRED");
});

test("reconcile_agent_spend: totals + anchors with the period code", async () => {
  const ds = new MemoryReportDataSource();
  const iApp = keccak256(toHex("recon-app"));
  const iBlk = keccak256(toHex("recon-blk"));
  const app = decisionRow(iApp, APPROVED, "2026-07-11T09:00:00.000Z");
  const blk = decisionRow(iBlk, BLOCKED_BUDGET, "2026-07-11T09:30:00.000Z");
  ds.addReceipt(app);
  ds.addReceipt(blk);
  ds.addLedger({
    receiptId: app.receiptId,
    agentId: AGENT,
    type: "SPEND",
    amount: "500000",
    token: TOKEN,
    counterparty: null,
    dayKey: "2026-07-11",
    categoryKey: "market-data",
    vendorKey: VENDOR,
    createdAt: "2026-07-11T09:00:00.000Z",
  });

  const anchorer = new RecordingAnchorer();
  const res = await handleReconcileAgentSpend({ agentId: "9", period: "2026-07-11" }, { dataSource: ds, anchorer });

  assert.equal(res.status, 200);
  const body = res.body as Record<string, any>;
  assert.equal(body.report.spend.totals[0].totalDisplay, "0.5");
  assert.equal(body.report.blockedWaste.blockedCount, 1);
  assert.equal(anchorer.calls[0]!.period, BigInt(Math.floor(Date.parse("2026-07-11T00:00:00Z") / 1000)));
  assert.equal(anchorer.calls[0]!.agentId.toLowerCase(), AGENT.toLowerCase());
  assert.equal(body.anchor.txHash, "0x" + "ab".repeat(32));
});

test("reconcile_agent_spend: bad period → 400 with the period error code", async () => {
  const ds = new MemoryReportDataSource();
  const res = await handleReconcileAgentSpend({ agentId: "9", period: "2026-13-99" }, { dataSource: ds, anchorer: null });
  assert.equal(res.status, 400);
  assert.ok(String((res.body as Record<string, unknown>).code).startsWith("PERIOD_"));
});

test("reconcile_agent_spend: missing agentId → 400", async () => {
  const ds = new MemoryReportDataSource();
  const res = await handleReconcileAgentSpend({ period: "2026-07-11" }, { dataSource: ds, anchorer: null });
  assert.equal(res.status, 400);
  assert.equal((res.body as Record<string, unknown>).code, "AGENT_ID_REQUIRED");
});
