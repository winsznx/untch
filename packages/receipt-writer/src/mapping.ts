import { randomBytes } from "node:crypto";
import type { Decision, DecisionOutcome, SpendIntentInput } from "@untch/policy-engine";
import { keccak256, toHex, type Hex } from "viem";
import type { LedgerEntryInput, ReceiptDraft, ReceiptOnchain } from "./types";

/**
 * Turn a preflight_payment result — the intent that was evaluated + the engine's Decision — into the
 * §10.3 on-chain receipt payload AND the §8 ledger entry it produces. Pure and deterministic apart
 * from `receiptId`, which carries a random salt so two evaluations that happen to share an intent can
 * never collide on the same primary key.
 */

/**
 * Stable decision → uint8 code for the on-chain `decision` field. 1 = APPROVED is FROZEN — it is the
 * value already written on-chain by the deploy demo (untch-receipts deploy driver). New outcomes may
 * be appended with new numbers; existing numbers never change (an indexer keys on them).
 */
const DECISION_CODE: Record<DecisionOutcome, number> = {
  APPROVED: 1,
  REJECTED_MALFORMED: 15,
  BLOCKED_NO_ACTIVE_POLICY: 2,
  BLOCKED_FAIL_CLOSED: 3,
  BLOCKED_DUPLICATE: 4,
  BLOCKED_COOLDOWN: 5,
  BLOCKED_RECIPIENT: 6,
  BLOCKED_AGENT: 7,
  BLOCKED_CATEGORY: 8,
  BLOCKED_INTENT_BOUND: 9,
  BLOCKED_PER_CALL_CAP: 10,
  ESCALATED_PER_CALL_CAP: 11,
  BLOCKED_BUDGET: 12,
  BLOCKED_RATE: 13,
  ESCALATED_THRESHOLD: 14,
};

export function decisionToUint8(outcome: DecisionOutcome): number {
  return DECISION_CODE[outcome];
}

/** A2MCP (0) when there is no worker agent (workerAgentId == 0), else A2A (1). Mirrors §8.1. */
function payTypeOf(input: SpendIntentInput): number {
  return input.workerAgentId === 0n ? 0 : 1;
}

/** bytes32(uint256 buyerAgentId) — a NUMERIC identity id, right-aligned, NOT an address (§10.3
 *  judgment call 1). */
function agentIdBytes32(buyerAgentId: bigint): Hex {
  return toHex(buyerAgentId, { size: 32 });
}

/** §9: amount in base units of the intent's token, using the 6-decimal convention the engine itself
 *  uses to re-express display `amount`. Kept as a bigint for the on-chain `amount` and stringified
 *  for the NUMERIC ledger column. */
export function amountBaseUnits(displayAmount: number): bigint {
  return BigInt(Math.round(displayAmount * 1_000_000));
}

/** Vendor identity for the receipt: the canonical host of the service being paid. `endpoint` is
 *  already canonicalized upstream (`canonUrl`), so its host is a stable per-service id. Falls back to
 *  hashing the raw endpoint string if it is not URL-parseable. */
function vendorIdOf(endpoint: string): Hex {
  let key = endpoint;
  try {
    key = new URL(endpoint).host;
  } catch {
    /* not a URL — hash the raw string */
  }
  return keccak256(toHex(`untch-vendor:${key}`));
}

/** Hash of the (redacted) off-chain metadata this receipt stands for. On-chain carries hashes only
 *  (§10.3) — the redacted metadata object stays off-chain; this commits to it. */
function metadataHashOf(input: SpendIntentInput, decision: Decision): Hex {
  const redacted = JSON.stringify({
    intentHash: decision.intentHash,
    decision: decision.decision,
    evaluatedAt: decision.evaluatedAt,
    category: input.category,
    endpointHost: (() => {
      try {
        return new URL(input.endpoint).host;
      } catch {
        return null;
      }
    })(),
  });
  return keccak256(toHex(redacted));
}

/** A collision-proof caller-supplied receiptId: keccak256(intentHash ‖ evaluatedAt ‖ 16-byte salt). */
function newReceiptId(decision: Decision): Hex {
  const salt = toHex(randomBytes(16));
  return keccak256(toHex(`${decision.intentHash}:${decision.evaluatedAt}:${salt}`));
}

/** UTC day bucket (YYYY-MM-DD) from an ISO-8601 timestamp, for the ledger day rollup key (§8/§9). */
function dayKeyOf(evaluatedAt: string): string {
  return evaluatedAt.slice(0, 10);
}

/**
 * Build the durable draft for one preflight decision. `verifyResult`/`proofTier` are 0: this is the
 * preflight-only path — delivery verification (verify_delivery) does not exist yet (Proof Engine
 * unbuilt), so there is no verify result to record. Documented as a stub, not a silent zero.
 */
export function draftFromDecision(input: SpendIntentInput, decision: Decision): ReceiptDraft {
  const amount = amountBaseUnits(input.amount);
  const agentId = agentIdBytes32(input.buyerAgentId);
  const vendorId = vendorIdOf(input.endpoint);

  const onchain: ReceiptOnchain = {
    receiptId: newReceiptId(decision),
    policyId: BigInt(decision.policyId),
    policyHash: input.policyHash,
    agentId,
    vendorId,
    amount,
    token: input.token,
    category: keccak256(toHex(input.category)),
    payType: payTypeOf(input),
    intentHash: decision.intentHash,
    taskHash: input.taskHash,
    decision: decisionToUint8(decision.decision),
    verifyResult: 0,
    proofTier: 0,
    metadataHash: metadataHashOf(input, decision),
  };

  const ledger: LedgerEntryInput = {
    agentId,
    type: decision.decision === "APPROVED" ? "SPEND" : "BLOCK_SAVED",
    amount: amount.toString(),
    token: input.token,
    counterparty: input.recipientAddress,
    dayKey: dayKeyOf(decision.evaluatedAt),
    categoryKey: input.category,
    vendorKey: vendorId,
  };

  return { onchain, ledger };
}
