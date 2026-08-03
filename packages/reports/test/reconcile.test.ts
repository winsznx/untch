import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleReconcileReport, hashReconcileReport } from "../src/reconcile";
import { parsePeriod } from "../src/period";
import {
  AGENT,
  APPROVED,
  ASSEMBLED_AT,
  BLOCKED_BUDGET,
  BLOCKED_DUPLICATE,
  ESCALATED_THRESHOLD,
  intentOf,
  mkEscalation,
  mkLedger,
  mkReceipt,
  mkVerify,
} from "./helpers";

const DAY = parsePeriod("2026-07-11");
const IN_DAY = "2026-07-11T09:00:00.000Z";

/**
 * reconcile_agent_spend assembly — spend totals from moved money (ledger SPEND), blocked-waste from
 * BLOCKED_* attempts only, escalated exposure reported SEPARATELY, honest empty report when there is
 * no history in the period.
 */

test("settled spend and reserved authority are separate; blocked-waste = BLOCKED_* only", () => {
  // Two APPROVED decisions. Under the corrected model these are AUTHORITY_RESERVED — permission
  // granted, nothing settled — so `spend` is empty and `reservedAuthority` carries the 1.0. Reporting
  // them as spend is what let this report describe granted authority as money that had moved.
  const iApp1 = intentOf("app1");
  const iApp2 = intentOf("app2");
  const iBlk1 = intentOf("blk1");
  const iBlk2 = intentOf("blk2");
  const iEsc = intentOf("esc");

  const decApp1 = mkReceipt({ intentHash: iApp1, decision: APPROVED, createdAt: IN_DAY });
  const decApp2 = mkReceipt({ intentHash: iApp2, decision: APPROVED, createdAt: IN_DAY });
  const decBlk1 = mkReceipt({ intentHash: iBlk1, decision: BLOCKED_BUDGET, createdAt: IN_DAY });
  const decBlk2 = mkReceipt({ intentHash: iBlk2, decision: BLOCKED_DUPLICATE, createdAt: IN_DAY });
  const decEsc = mkReceipt({ intentHash: iEsc, decision: ESCALATED_THRESHOLD, createdAt: IN_DAY });
  const verify = mkVerify({ intentHash: iApp1, verifyResult: 1, createdAt: IN_DAY });

  const ledger = [
    mkLedger({ receiptId: decApp1.receiptId, type: "AUTHORITY_RESERVED", createdAt: IN_DAY }),
    mkLedger({ receiptId: decApp2.receiptId, type: "AUTHORITY_RESERVED", createdAt: IN_DAY }),
    mkLedger({ receiptId: decBlk1.receiptId, type: "BLOCK_SAVED", createdAt: IN_DAY }),
    mkLedger({ receiptId: decBlk2.receiptId, type: "BLOCK_SAVED", createdAt: IN_DAY }),
    mkLedger({ receiptId: decEsc.receiptId, type: "BLOCK_SAVED", createdAt: IN_DAY }),
  ];
  const esc = mkEscalation({ intentId: iEsc, status: "DENIED", createdAt: IN_DAY });

  const report = assembleReconcileReport(
    AGENT,
    DAY,
    [decApp1, decApp2, decBlk1, decBlk2, decEsc, verify],
    ledger,
    [esc],
    { assembledAt: ASSEMBLED_AT },
  );

  // No money moved: an approved preflight decision settles nothing.
  assert.equal(report.spend.settledCount, 0, "an approved DECISION is not settled spend");
  assert.deepEqual(report.spend.totals, []);

  // The same 1.0 appears as authority that was granted and has not settled.
  assert.equal(report.reservedAuthority.approvedCount, 2);
  assert.equal(report.reservedAuthority.totals.length, 1);
  assert.equal(report.reservedAuthority.totals[0]!.totalBaseUnits, "1000000");
  assert.equal(report.reservedAuthority.totals[0]!.totalDisplay, "1");

  assert.equal(report.blockedWaste.blockedCount, 2, "only BLOCKED_* count as waste");
  assert.equal(report.blockedWaste.totals[0]!.totalBaseUnits, "1000000");

  assert.equal(report.escalatedExposure.escalatedCount, 1, "escalated is separate, not folded into waste");
  assert.equal(report.escalatedExposure.totals[0]!.totalBaseUnits, "500000");

  assert.equal(report.verifications.total, 1);
  assert.equal(report.verifications.passed, 1);

  assert.equal(report.escalations.total, 1);
  assert.equal(report.escalations.byResolution[0]!.status, "DENIED");

  // Decision breakdown covers exactly the 5 DECISION receipts.
  const total = report.decisionBreakdown.reduce((s, d) => s + d.count, 0);
  assert.equal(total, 5);

  assert.equal(report.receipts.total, 6);
  assert.equal(report.receipts.decisionCount, 5);
  assert.equal(report.receipts.verifyCount, 1);
});

test("HONEST-EMPTY: no history in the period → all-zero totals, explicitly labeled", () => {
  const report = assembleReconcileReport(AGENT, DAY, [], [], [], { assembledAt: ASSEMBLED_AT });

  assert.equal(report.spend.settledCount, 0);
  assert.deepEqual(report.spend.totals, []);
  assert.equal(report.reservedAuthority.approvedCount, 0);
  assert.equal(report.blockedWaste.blockedCount, 0);
  assert.equal(report.escalatedExposure.escalatedCount, 0);
  assert.equal(report.receipts.total, 0);
  assert.ok(
    report.completeness.notes.some((n) => n.includes("honest empty report")),
    "an empty report is labeled honest-empty, not padded",
  );
  const h = hashReconcileReport(report);
  assert.match(h, /^0x[0-9a-f]{64}$/);
});

test("period fields + on-chain periodCode are carried onto the report", () => {
  const report = assembleReconcileReport(AGENT, DAY, [], [], [], { assembledAt: ASSEMBLED_AT });
  assert.equal(report.period.kind, "day");
  assert.equal(report.period.label, "2026-07-11");
  assert.equal(report.period.fromIso, "2026-07-11T00:00:00.000Z");
  assert.equal(report.period.periodCode, DAY.periodCode.toString());
});

test("hash is deterministic and sensitive to spend changes", () => {
  const i = intentOf("h1");
  const dec = mkReceipt({ intentHash: i, decision: APPROVED, createdAt: IN_DAY });
  const led = mkLedger({ receiptId: dec.receiptId, type: "SPEND", createdAt: IN_DAY });
  const r1 = assembleReconcileReport(AGENT, DAY, [dec], [led], [], { assembledAt: ASSEMBLED_AT });
  const r2 = assembleReconcileReport(AGENT, DAY, [dec], [led], [], { assembledAt: ASSEMBLED_AT });
  assert.equal(hashReconcileReport(r1), hashReconcileReport(r2));

  const led2 = mkLedger({ receiptId: dec.receiptId, type: "SPEND", amount: "750000", createdAt: IN_DAY });
  const r3 = assembleReconcileReport(AGENT, DAY, [dec], [led, led2], [], { assembledAt: ASSEMBLED_AT });
  assert.notEqual(hashReconcileReport(r1), hashReconcileReport(r3));
});
