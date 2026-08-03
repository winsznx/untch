import { randomBytes } from "node:crypto";
import type { Decision, DecisionOutcome, SpendIntentInput } from "@untch/policy-engine";
import { keccak256, toHex, type Hex } from "viem";
import type { LedgerEntryInput, ReceiptDraft, ReceiptOnchain } from "./types";
import {
  deliveryVerificationMetadataHash,
  deliveryVerificationReceiptId,
  type DeliveryVerificationContext,
} from "./delivery-verification-receipt";

/**
 * The uint8 `decision` value on a VERIFY-kind receipt. A delivery verification does NOT re-decide the
 * §7.1 preflight outcome — its meaningful fields are `verifyResult` + `proofTier` — so `decision` is
 * the sentinel 0 = "not a preflight decision (this is a VERIFY receipt)". 0 is safe: DECISION receipts
 * use 1..15 (see DECISION_CODE), never 0, so an indexer can tell the two apart on the number alone.
 */
export const DECISION_NA = 0;

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
  // Appended after the frozen 1–15 set — never renumber existing codes.
  BLOCKED_REPLAY: 16,
  REJECTED_BINDING: 17,
  BLOCKED_VENDOR_RISK: 18,
  ESCALATED_VENDOR_RISK: 19,
  ESCALATED_PROOF_TIER: 20,
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
/**
 * The off-chain commitment a receipt anchors alongside its on-chain fields.
 *
 * `evaluator` is included because the on-chain receipt names a `policyHash` and nothing else about
 * how that ruleset was read. One anchored ruleset can be judged by two different evaluators — it
 * already has been, when `hardCap.absolute` began being enforced for a policy registered before that
 * rule existed. Without the evaluator in this commitment, two receipts for the same policy and the
 * same amount could record different verdicts with nothing in either explaining why.
 *
 * Still deliberately absent: the task text, the parameters, the recipient and the endpoint PATH. The
 * host is enough to identify a vendor; the rest is the caller's business and a receipt is public.
 */
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
    // Which rules ran, in what order, under which implementation.
    evaluator: decision.evaluator,
    // The ruleset bytes the engine actually judged, which may differ from `input.policyHash` if a
    // caller ever bound an intent to one ruleset and the store held another. Recording both means a
    // disagreement is visible rather than resolved silently in favour of one of them.
    judgedPolicyHash: decision.policyHash,
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
    /**
     * An APPROVED preflight is AUTHORITY_RESERVED, not SPEND.
     *
     * This line wrote `SPEND` with the governed amount for every approved decision. That is how a
     * 4.00 authorisation became a 4,000,000-base-unit SPEND row on 2026-08-02 for a decision where no
     * provider ran and no payment settled — and how the reconcile report and the dashboard came to
     * describe granted authority as money that had moved.
     *
     * `SPEND` is now written only when a reservation is consumed at the settlement point.
     */
    type: decision.decision === "APPROVED" ? "AUTHORITY_RESERVED" : "BLOCK_SAVED",
    amount: amount.toString(),
    token: input.token,
    counterparty: input.recipientAddress,
    dayKey: dayKeyOf(decision.evaluatedAt),
    categoryKey: input.category,
    vendorKey: vendorId,
  };

  return { onchain, kind: "DECISION", ledger };
}

/** Whether the verified intent came from the seller's committed store or from caller-supplied inline
 *  data (a store miss) — committed into the receipt's metadata so it is tamper-evident and available
 *  to Trust Bureau as a confidence weight. Mirrors the seller's `IntentProvenance`. */
export type VerifyIntentProvenance = "store-committed" | "caller-supplied";

/** The verification context a VERIFY receipt records — the real result of a `verify_delivery` call.
 *  `verifyResultCode` / `proofTier` come straight from `@untch/proof-engine`'s `VerifyOutcome`. */
export interface VerifyReceiptContext {
  /** uint256 policyId (decimal string) the intent was bound to — for the receipt's `policyId` field. */
  readonly policyId: string;
  readonly intentHash: Hex;
  /** §10.3 `verifyResult` (proof-engine VERIFY_RESULT_CODE: 1=PASS, 2=FAIL, 3=SKIPPED, 4=NOT_IMPL). */
  readonly verifyResultCode: number;
  /** §10.3 `proofTier` — the tier achieved (0 for T0). */
  readonly proofTier: number;
  /** The delivery's canonical payload hash (§9) this verify pertains to. */
  readonly payloadHash: Hex;
  /** ISO-8601 UTC verify time — the day rollup key + receiptId salt. */
  readonly verifiedAt: string;
  /** Whether the intent was the committed store record or caller-supplied inline data (store miss). */
  readonly provenance: VerifyIntentProvenance;
}

/** Hash the (off-chain) verify context this receipt stands for — on-chain carries hashes only (§10.3).
 *  Includes `provenance` so a caller-supplied (lower-confidence) result is committed as such. */
function metadataHashOfVerify(input: SpendIntentInput, ctx: VerifyReceiptContext): Hex {
  const redacted = JSON.stringify({
    intentHash: ctx.intentHash,
    verifyResult: ctx.verifyResultCode,
    proofTier: ctx.proofTier,
    payloadHash: ctx.payloadHash,
    verifiedAt: ctx.verifiedAt,
    provenance: ctx.provenance,
    category: input.category,
  });
  return keccak256(toHex(redacted));
}

/** A collision-proof receiptId for a verify receipt: keccak256("verify:" ‖ intentHash ‖ verifiedAt ‖ salt).
 *  The `verify:` tag guarantees it can never collide with the decision receipt of the same intent. */
function newVerifyReceiptId(ctx: VerifyReceiptContext): Hex {
  const salt = toHex(randomBytes(16));
  return keccak256(toHex(`verify:${ctx.intentHash}:${ctx.verifiedAt}:${salt}`));
}

/**
 * Build the durable draft for one delivery verification (§7.3 → §10.3). Unlike a decision receipt,
 * this carries a REAL `verifyResult` and `proofTier` (the whole point of this build) and the sentinel
 * `decision = DECISION_NA`. It moves no money, so it produces NO ledger entry — the receipt is the
 * anchored proof of what verification found, not a spend.
 */
export function draftFromVerify(input: SpendIntentInput, ctx: VerifyReceiptContext): ReceiptDraft {
  const onchain: ReceiptOnchain = {
    receiptId: newVerifyReceiptId(ctx),
    policyId: BigInt(ctx.policyId),
    policyHash: input.policyHash,
    agentId: agentIdBytes32(input.buyerAgentId),
    vendorId: vendorIdOf(input.endpoint),
    amount: amountBaseUnits(input.amount),
    token: input.token,
    category: keccak256(toHex(input.category)),
    payType: payTypeOf(input),
    intentHash: ctx.intentHash,
    taskHash: input.taskHash,
    decision: DECISION_NA,
    verifyResult: ctx.verifyResultCode,
    proofTier: ctx.proofTier,
    metadataHash: metadataHashOfVerify(input, ctx),
  };

  return { onchain, kind: "VERIFY", provenance: ctx.provenance };
}

/** §10.3 `verifyResult`: 1 = PASS, 2 = FAIL. A refused verification is still a fact worth anchoring. */
const VERIFY_RESULT_PASS = 1;
const VERIFY_RESULT_FAIL = 2;

/**
 * Build the durable draft for one delivery-verification addendum (§7.3 → §10.3).
 *
 * Takes the SAME `SpendIntentInput` the settlement receipt was built from, so `intentHash`, `policyId`,
 * `policyHash`, `agentId`, `vendorId`, `amount` and `token` come out identical through the same helpers.
 * That shared identity IS the on-chain link between the two receipts: an indexer joins them on
 * `intentHash` with nothing off-chain, and `kind` plus `decision = DECISION_NA` says which is which.
 *
 * Re-deriving those fields independently would produce a receipt describing a different transaction,
 * which could not be joined to the settlement it is about.
 *
 * Returns NO ledger entry, and that is load-bearing rather than incidental: this receipt records what a
 * check found about a payment that already happened. A ledger movement here would book the same money
 * twice and make two anchors look like two spends.
 *
 * `proofTier` is 0 (T0), honestly. The verification re-reads evidence Untch already held and reaches no
 * independent oracle, so a higher tier would assert corroboration nobody performed.
 */
export function draftFromDeliveryVerification(
  input: SpendIntentInput,
  ctx: DeliveryVerificationContext,
): ReceiptDraft {
  const onchain: ReceiptOnchain = {
    receiptId: deliveryVerificationReceiptId(ctx),
    policyId: BigInt(ctx.policyId ?? "0"),
    policyHash: input.policyHash,
    agentId: agentIdBytes32(input.buyerAgentId),
    vendorId: vendorIdOf(input.endpoint),
    amount: amountBaseUnits(input.amount),
    token: input.token,
    category: keccak256(toHex(input.category)),
    payType: payTypeOf(input),
    intentHash: ctx.intentHash,
    taskHash: input.taskHash,
    // Not a spend decision. The sentinel says so rather than leaving a zero to be read as ALLOW.
    decision: DECISION_NA,
    verifyResult: ctx.verified ? VERIFY_RESULT_PASS : VERIFY_RESULT_FAIL,
    proofTier: 0,
    metadataHash: deliveryVerificationMetadataHash(ctx),
  };

  /**
   * `store-committed`, because every input came from Untch's own persisted evidence.
   *
   * Nothing here was supplied by a caller at request time, which is exactly the distinction this field
   * exists to record for the §12 Bureau's `delivery_consistency` weighting.
   */
  return { onchain, kind: "VERIFY", provenance: "store-committed" };
}
