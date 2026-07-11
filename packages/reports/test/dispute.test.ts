import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleDisputePacket, hashDisputePacket } from "../src/dispute";
import {
  AGENT,
  APPROVED,
  ASSEMBLED_AT,
  BLOCKED_BUDGET,
  intentOf,
  mkEscalation,
  mkLedger,
  mkReceipt,
  mkVerify,
} from "./helpers";

/**
 * generate_dispute_packet assembly — RIGHT data included, RIGHT data excluded. The load-bearing
 * honesty test is `honest-sparse`: an intent with no verify_delivery call must NOT fabricate a tier
 * result — it must honestly show none exist.
 */

test("full history: decision + verify + escalation + anchors + timeline all assembled", () => {
  const intent = intentOf("full");
  const decision = mkReceipt({
    intentHash: intent,
    decision: APPROVED,
    createdAt: "2026-07-11T10:00:00.000Z",
    txHash: ("0x" + "aa".repeat(32)) as `0x${string}`,
    blockNumber: 500,
  });
  const verify = mkVerify({
    intentHash: intent,
    verifyResult: 1, // real T0 PASS
    proofTier: 0,
    createdAt: "2026-07-11T10:05:00.000Z",
    txHash: ("0x" + "bb".repeat(32)) as `0x${string}`,
    blockNumber: 501,
  });
  const ledger = mkLedger({ receiptId: decision.receiptId, type: "SPEND", createdAt: "2026-07-11T10:00:00.000Z" });
  const esc = mkEscalation({
    intentId: intent,
    status: "APPROVED",
    createdAt: "2026-07-11T10:02:00.000Z",
    resolvedAt: "2026-07-11T10:03:00.000Z",
  });

  const packet = assembleDisputePacket(intent, [decision, verify], [ledger], [esc], { assembledAt: ASSEMBLED_AT });

  assert.equal(packet.decision.present, true);
  assert.equal(packet.decision.outcome, "APPROVED");
  assert.equal(packet.decision.category, "APPROVED");
  assert.deepEqual(packet.decision.anchor, {
    txHash: "0x" + "aa".repeat(32),
    blockNumber: 500,
    batchId: 1,
    status: "CONFIRMED",
  });
  assert.equal(packet.decision.amountDisplay, "0.5");

  assert.equal(packet.verification.present, true);
  assert.equal(packet.verification.results.length, 1);
  assert.equal(packet.verification.results[0]!.result, "VERIFY_PASSED");
  assert.equal(packet.verification.results[0]!.proofTier, 0);
  assert.equal(packet.verification.results[0]!.provenance, "store-committed");

  assert.equal(packet.escalation.present, true);
  assert.equal(packet.escalation.records[0]!.status, "APPROVED");

  assert.equal(packet.receipts.length, 2);
  assert.equal(packet.ledger.length, 1);
  assert.equal(packet.ledger[0]!.type, "SPEND");

  assert.equal(packet.completeness.hasDecision, true);
  assert.equal(packet.completeness.hasVerification, true);
  assert.equal(packet.completeness.hasEscalation, true);
  assert.equal(packet.completeness.hasAnchoredReceipt, true);

  // Timeline is chronological across all sources.
  const ts = packet.timeline.map((e) => e.ts);
  assert.deepEqual(ts, [...ts].sort());
  assert.ok(packet.timeline.some((e) => e.event.startsWith("DECISION")));
  assert.ok(packet.timeline.some((e) => e.event.startsWith("VERIFY")));
  assert.ok(packet.timeline.some((e) => e.event.startsWith("ESCALATION")));
});

test("HONEST-SPARSE: an intent with no verify_delivery call shows NO tier results (not fabricated)", () => {
  const intent = intentOf("sparse");
  const decision = mkReceipt({ intentHash: intent, decision: BLOCKED_BUDGET });

  const packet = assembleDisputePacket(intent, [decision], [], [], { assembledAt: ASSEMBLED_AT });

  assert.equal(packet.decision.present, true);
  assert.equal(packet.decision.outcome, "BLOCKED_BUDGET");
  assert.equal(packet.decision.category, "BLOCKED");
  // The whole point: NO verification section is fabricated.
  assert.equal(packet.verification.present, false);
  assert.deepEqual(packet.verification.results, []);
  assert.equal(packet.completeness.hasVerification, false);
  assert.ok(
    packet.completeness.notes.some((n) => n.includes("No verify_delivery call was made")),
    "the packet honestly states no verify happened",
  );
  // And no escalation is invented either.
  assert.equal(packet.escalation.present, false);
});

test("EMPTY history: an intent with zero receipts is an honest empty record, still hashable", () => {
  const intent = intentOf("empty");
  const packet = assembleDisputePacket(intent, [], [], [], { assembledAt: ASSEMBLED_AT });

  assert.equal(packet.decision.present, false);
  assert.equal(packet.decision.outcome, null);
  assert.equal(packet.verification.present, false);
  assert.equal(packet.receipts.length, 0);
  assert.equal(packet.completeness.receiptCount, 0);
  assert.ok(packet.completeness.notes.some((n) => n.includes("no history was found")));
  // A sparse packet still produces a real, non-zero reportHash (it commits to "we looked, found nothing").
  const h = hashDisputePacket(packet);
  assert.match(h, /^0x[0-9a-f]{64}$/);
  assert.notEqual(h, "0x" + "00".repeat(32));
});

test("unanchored receipt: anchor is null and the gap is noted (not hidden)", () => {
  const intent = intentOf("queued");
  const decision = mkReceipt({ intentHash: intent, decision: APPROVED, status: "QUEUED", txHash: null, blockNumber: null, batchId: null });

  const packet = assembleDisputePacket(intent, [decision], [], [], { assembledAt: ASSEMBLED_AT });

  assert.equal(packet.decision.anchor, null);
  assert.equal(packet.completeness.hasAnchoredReceipt, false);
  assert.ok(packet.completeness.notes.some((n) => n.includes("not yet anchored")));
});

test("hash is deterministic for the same packet and changes when history changes", () => {
  const intent = intentOf("hash");
  const a = mkReceipt({ intentHash: intent, decision: APPROVED, receiptId: ("0x" + "11".repeat(32)) as `0x${string}`, createdAt: "2026-07-11T10:00:00.000Z", txHash: ("0x" + "22".repeat(32)) as `0x${string}`, blockNumber: 5 });
  const p1 = assembleDisputePacket(intent, [a], [], [], { assembledAt: ASSEMBLED_AT });
  const p2 = assembleDisputePacket(intent, [a], [], [], { assembledAt: ASSEMBLED_AT });
  assert.equal(hashDisputePacket(p1), hashDisputePacket(p2));

  const verify = mkVerify({ intentHash: intent, verifyResult: 2, receiptId: ("0x" + "33".repeat(32)) as `0x${string}`, createdAt: "2026-07-11T10:05:00.000Z", txHash: ("0x" + "44".repeat(32)) as `0x${string}`, blockNumber: 6 });
  const p3 = assembleDisputePacket(intent, [a, verify], [], [], { assembledAt: ASSEMBLED_AT });
  assert.notEqual(hashDisputePacket(p1), hashDisputePacket(p3), "adding a real verify result changes the hash");
});
