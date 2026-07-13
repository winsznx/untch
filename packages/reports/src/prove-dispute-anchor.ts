import { assembleDisputePacket, hashDisputePacket } from "./dispute";
import { MemoryReportDataSource } from "./datasource-memory";
import { AuditAnchorer } from "./anchor";
import { AUDIT_ANCHOR_CHAIN, AUDIT_RECEIPTS_CONTRACT, DEFAULT_RPC_URL } from "./config";
import { realDecision, realVerify } from "./prove-helpers";
import type { EscalationRow } from "./datasource";
import type { Address, Hex } from "viem";

/**
 * One-shot REAL end-to-end §11 proof for `generate_dispute_packet`, self-contained (no seller, no DB):
 *
 *   1. Produce a REAL DECISION receipt by running the REAL @untch/policy-engine (asserted APPROVED) and
 *      a REAL VERIFY receipt by running the REAL @untch/proof-engine T0 (asserted VERIFY_PASSED), both
 *      turned into on-chain receipt payloads by the REAL @untch/receipt-writer mapping.
 *   2. Seed a data source with those real rows + a real resolved escalation, all bound to ONE intent.
 *   3. Assemble the dispute packet over the real history, then HASH it (RFC 8785 JCS).
 *   4. Anchor the hash on the deployed UntchReceipts via a REAL writer-signed `anchorAudit` transaction
 *      (§10.3 AuditAnchored) — no mocked settlement.
 *   5. INDEPENDENTLY verify the AuditAnchored event via raw eth_getLogs — decoded client-side, matched
 *      on reportHash+agentId+period where reportHash is RECOMPUTED from the packet, NOT taken from the
 *      anchor call's return.
 *
 * Needs: WRITER_PRIVATE_KEY (an authorized UntchReceipts writer). RPC_URL / RECEIPTS_CONTRACT default to
 * X Layer testnet + the deployed §10.3 contract.
 * Run: WRITER_PRIVATE_KEY=0x… pnpm --filter @untch/reports prove:dispute-anchor
 */

const ASSEMBLED_AT = "2026-07-11T12:00:00.000Z";

function dayBucketSeconds(iso: string): bigint {
  const ms = Date.parse(iso);
  return BigInt(Math.floor(Math.floor(ms / 86_400_000) * 86_400_000 / 1000));
}

async function main(): Promise<void> {
  const writerKey = process.env.WRITER_PRIVATE_KEY?.trim();
  if (!writerKey || !/^0x[0-9a-fA-F]{64}$/.test(writerKey)) {
    throw new Error("WRITER_PRIVATE_KEY (0x 32-byte) is required");
  }
  const rpcUrl = process.env.RPC_URL?.trim() || DEFAULT_RPC_URL;
  const contract = (process.env.RECEIPTS_CONTRACT?.trim() as Address | undefined) ?? AUDIT_RECEIPTS_CONTRACT;

  // 1–2. REAL decision + REAL verify, bound to one intent, plus a real resolved escalation.
  const dec = realDecision({
    tag: "dispute-demo",
    expected: "APPROVED",
    createdAt: "2026-07-11T10:00:00.000Z",
  });
  const intentHash = dec.receipt.intentHash;
  const ver = realVerify({
    tag: "dispute-demo",
    intentHash,
    criteria: { requiredFields: ["symbol", "price"] },
    delivery: { payload: { symbol: "OKB", price: 42.5 } },
    expectedFinal: "VERIFY_PASSED",
    createdAt: "2026-07-11T10:05:00.000Z",
  });
  const escalation: EscalationRow = {
    intentId: intentHash,
    status: "APPROVED",
    createdAt: "2026-07-11T10:02:00.000Z",
    resolvedAt: "2026-07-11T10:03:00.000Z",
    codeExpiresAt: "2026-07-11T10:32:00.000Z",
  };

  const ds = new MemoryReportDataSource();
  ds.addReceipt(dec.receipt).addReceipt(ver.receipt);
  if (dec.ledger) ds.addLedger(dec.ledger);
  ds.addEscalation(escalation);

  const [receipts, ledger, escalations] = await Promise.all([
    ds.receiptsForIntent(intentHash),
    ds.ledgerForIntent(intentHash),
    ds.escalationsForIntent(intentHash),
  ]);

  // 3. Assemble + hash.
  const packet = assembleDisputePacket(intentHash, receipts, ledger, escalations, { assembledAt: ASSEMBLED_AT });
  const reportHash = hashDisputePacket(packet);
  const agentId: Hex = packet.subject.agentId!;
  const period = dayBucketSeconds(receipts[0]!.createdAt);

  console.log(`[prove] chain    : ${AUDIT_ANCHOR_CHAIN.name} (${AUDIT_ANCHOR_CHAIN.id})`);
  console.log(`[prove] contract : ${contract}`);
  console.log(`[prove] intent   : ${intentHash}`);
  console.log(`[prove] packet   : decision=${packet.decision.outcome} verify=${packet.verification.results[0]?.result} escalation=${packet.escalation.records[0]?.status}`);
  console.log(`[prove]   completeness: hasDecision=${packet.completeness.hasDecision} hasVerification=${packet.completeness.hasVerification} hasEscalation=${packet.completeness.hasEscalation}`);
  console.log(`[prove] reportHash: ${reportHash}`);
  console.log(`[prove] agentId  : ${agentId}   period=${period}`);

  // 4. REAL anchor.
  const anchorer = new AuditAnchorer({ chain: AUDIT_ANCHOR_CHAIN, rpcUrl, contract, writerPrivateKey: writerKey as Hex });
  console.log(`[prove] writer   : ${anchorer.writerAddress}`);
  console.log(`[prove] anchoring anchorAudit(reportHash, agentId, period=${period}) …`);
  const anchored = await anchorer.anchor(reportHash, agentId, period);
  console.log(`[prove] anchor tx: ${anchored.txHash} (block ${anchored.blockNumber})`);

  // 5. INDEPENDENT raw-RPC verification — reportHash RECOMPUTED from the packet, not from anchor().
  const recomputed = hashDisputePacket(packet);
  if (recomputed.toLowerCase() !== reportHash.toLowerCase()) throw new Error("packet hash is not reproducible");
  console.log(`[prove] verifying AuditAnchored via raw eth_getLogs (independent of this script) …`);
  const matchTx = await anchorer.verifyAnchored(
    { reportHash: recomputed, agentId, period },
    anchored.blockNumber,
    anchored.txHash,
  );
  if (!matchTx) throw new Error(`AuditAnchored(reportHash=${reportHash}) NOT found on-chain`);

  console.log("");
  console.log("RESULT: PASS — real dispute packet assembled from real policy/proof/receipt/escalation history, hashed, and anchored on UntchReceipts.anchorAudit (AuditAnchored).");
  console.log(`reportHash : ${reportHash}`);
  console.log(`agentId    : ${agentId}   period: ${period}`);
  console.log(`anchor tx  : ${matchTx}`);
  console.log(`explorer   : https://www.oklink.com/x-layer-testnet/tx/${matchTx}`);
  console.log(`verified   : raw eth_getLogs decoded AuditAnchored and matched reportHash+agentId+period`);
}

main().catch((err) => {
  console.error(`[prove] FAIL: ${(err as Error).message}`);
  process.exit(1);
});
