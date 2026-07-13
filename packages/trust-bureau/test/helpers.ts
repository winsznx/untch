import { keccak256, toHex, type Hex } from "viem";
import type { EscalationView, OrderRecord, VerifyRecord } from "../src/datasource";
import { APPROVED_CODE, BLOCKED_CODES, VERIFY_FAIL, VERIFY_PASS } from "../src/decision-codes";

/** Deterministic ids for tests — same derivation the real mapping uses (vendorId = keccak of host). */
export function vendorIdOf(host: string): Hex {
  return keccak256(toHex(`untch-vendor:${host}`));
}
export function agentIdOf(n: bigint): Hex {
  return toHex(n, { size: 32 });
}

let seq = 0;
function intentId(): Hex {
  return keccak256(toHex(`intent:${seq++}`));
}

const A_BLOCKED_CODE = [...BLOCKED_CODES][0]!;

export function approvedOrder(
  vendorId: Hex,
  agentId: Hex,
  opts: { at?: string; counterparty?: string } = {},
): OrderRecord {
  return {
    intentHash: intentId(),
    vendorId,
    agentId,
    decision: APPROVED_CODE,
    counterparty: opts.counterparty ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    createdAt: opts.at ?? new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  };
}

export function blockedOrder(vendorId: Hex, agentId: Hex, at?: string): OrderRecord {
  return {
    intentHash: intentId(),
    vendorId,
    agentId,
    decision: A_BLOCKED_CODE,
    counterparty: null,
    createdAt: at ?? new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  };
}

export function verify(
  vendorId: Hex,
  agentId: Hex,
  result: number,
  provenance: VerifyRecord["provenance"],
  at?: string,
): VerifyRecord {
  return {
    intentHash: intentId(),
    vendorId,
    agentId,
    verifyResult: result,
    provenance,
    createdAt: at ?? new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  };
}

export function passVerify(vendorId: Hex, agentId: Hex, p: VerifyRecord["provenance"] = "store-committed"): VerifyRecord {
  return verify(vendorId, agentId, VERIFY_PASS, p);
}
export function failVerify(vendorId: Hex, agentId: Hex, p: VerifyRecord["provenance"] = "store-committed"): VerifyRecord {
  return verify(vendorId, agentId, VERIFY_FAIL, p);
}

export function escalation(
  intentId: string,
  status: string,
  opts: { createdAt?: string; resolvedAt?: string | null; codeExpiresAt?: string } = {},
): EscalationView {
  const created = opts.createdAt ?? new Date(1_700_000_000_000).toISOString();
  return {
    intentId,
    status,
    createdAt: created,
    resolvedAt: opts.resolvedAt ?? null,
    codeExpiresAt: opts.codeExpiresAt ?? new Date(1_700_000_000_000 + 30 * 60_000).toISOString(),
  };
}
