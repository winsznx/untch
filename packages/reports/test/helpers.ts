import { keccak256, toHex, type Hex } from "viem";
import { decisionToUint8 } from "@untch/receipt-writer";
import type { EscalationRow, LedgerRow, ReceiptRow } from "../src/datasource";

/**
 * Test fixtures built with REAL decision codes (via receipt-writer's own `decisionToUint8`, so they are
 * exactly the on-chain values) and REAL 6-decimal base-unit amounts. The assembly under test does pure
 * arithmetic/selection over these, so a test that seeds real-shaped rows exercises the real path.
 */

export const AGENT = toHex(7n, { size: 32 });
export const AGENT2 = toHex(8n, { size: 32 });
export const VENDOR = keccak256(toHex("untch-vendor:api.vendor.example"));
export const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
export const POLICY_HASH = keccak256(toHex("policy"));

export const APPROVED = decisionToUint8("APPROVED");
export const BLOCKED_BUDGET = decisionToUint8("BLOCKED_BUDGET");
export const BLOCKED_DUPLICATE = decisionToUint8("BLOCKED_DUPLICATE");
export const ESCALATED_THRESHOLD = decisionToUint8("ESCALATED_THRESHOLD");

let seq = 0;
export function intentOf(tag: string): Hex {
  return keccak256(toHex(`intent:${tag}`));
}

export function mkReceipt(over: Partial<ReceiptRow> & { intentHash: Hex; decision?: number }): ReceiptRow {
  const idx = seq++;
  // Nullable fields use `in` so an explicit `null` override (e.g. an unanchored receipt) is honored
  // rather than swallowed by `??`.
  return {
    receiptId: over.receiptId ?? keccak256(toHex(`receipt:${idx}`)),
    kind: over.kind ?? "DECISION",
    status: over.status ?? "CONFIRMED",
    intentHash: over.intentHash,
    policyId: over.policyId ?? "12",
    policyHash: over.policyHash ?? POLICY_HASH,
    agentId: over.agentId ?? AGENT,
    vendorId: over.vendorId ?? VENDOR,
    amount: over.amount ?? "500000", // 0.5 USDT0 (6 decimals)
    token: over.token ?? TOKEN,
    category: over.category ?? keccak256(toHex("market-data")),
    payType: over.payType ?? 0,
    taskHash: over.taskHash ?? keccak256(toHex(`task:${idx}`)),
    decision: over.decision ?? APPROVED,
    verifyResult: over.verifyResult ?? 0,
    proofTier: over.proofTier ?? 0,
    metadataHash: over.metadataHash ?? keccak256(toHex(`meta:${idx}`)),
    provenance: "provenance" in over ? (over.provenance ?? null) : null,
    batchId: "batchId" in over ? (over.batchId ?? null) : 1,
    txHash: "txHash" in over ? (over.txHash ?? null) : keccak256(toHex(`tx:${idx}`)),
    blockNumber: "blockNumber" in over ? (over.blockNumber ?? null) : 100 + idx,
    createdAt: over.createdAt ?? new Date(1_700_000_000_000 + idx * 1000).toISOString(),
  };
}

export function mkVerify(over: Partial<ReceiptRow> & { intentHash: Hex; verifyResult: number }): ReceiptRow {
  return mkReceipt({ kind: "VERIFY", decision: 0, provenance: "store-committed", ...over });
}

export function mkLedger(over: Partial<LedgerRow> & { receiptId: Hex; type: LedgerRow["type"] }): LedgerRow {
  return {
    receiptId: over.receiptId,
    agentId: over.agentId ?? AGENT,
    type: over.type,
    amount: over.amount ?? "500000",
    token: over.token ?? TOKEN,
    counterparty: over.counterparty ?? "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    dayKey: over.dayKey ?? "2026-07-11",
    categoryKey: over.categoryKey ?? "market-data",
    vendorKey: over.vendorKey ?? VENDOR,
    createdAt: over.createdAt ?? new Date(1_700_000_000_000).toISOString(),
  };
}

export function mkEscalation(over: Partial<EscalationRow> & { intentId: string }): EscalationRow {
  return {
    intentId: over.intentId,
    status: over.status ?? "APPROVED",
    createdAt: over.createdAt ?? new Date(1_700_000_050_000).toISOString(),
    resolvedAt: over.resolvedAt ?? new Date(1_700_000_060_000).toISOString(),
    codeExpiresAt: over.codeExpiresAt ?? new Date(1_700_000_090_000).toISOString(),
  };
}

export const ASSEMBLED_AT = "2026-07-11T12:00:00.000Z";
