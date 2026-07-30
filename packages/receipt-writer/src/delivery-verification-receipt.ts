/**
 * Anchoring a delivery-verification addendum as its own VERIFY receipt.
 *
 * WHY A SECOND RECEIPT AND NOT A SECOND ANCHOR OF THE FIRST
 *
 * Intent `ci_e58174e549f6a21c591eacfa` settled real USDC on Solana mainnet and produced a DECISION
 * receipt. The delivery verification came LATER, from evidence the settlement receipt does not contain.
 *
 * Re-anchoring the settlement receipt cannot carry that claim: a batch's receipt set is fixed when the
 * batch is created, and the settlement batch was created before the verification existed. Re-driving it
 * anchors exactly what it always held. So a document that said "anchored" after that redrive would be
 * asserting the verification was on chain when only the settlement was.
 *
 * Two claims, two receipts, two anchors, reported separately until both land.
 *
 * HOW THE TWO ARE LINKED ON CHAIN
 *
 * Through `intentHash`, `policyId` and `policyHash`, which both receipts carry identically. An indexer
 * joins them on that without needing anything off-chain, and `kind` plus `decision = DECISION_NA`
 * distinguishes which is which. The full linkage document — the original receipt id, the verification
 * id, the verifier version, the result hash, the settlement transaction — is committed in
 * `metadataHash`, because §10.3 puts hashes and metadata on chain and never payloads.
 *
 * WHY THE ID IS DERIVED AND NOT RANDOM
 *
 * `draftFromVerify` salts its receipt id with `randomBytes(16)`, which is right for its own path: two
 * genuine verifications of the same intent at the same instant are two different facts and must not
 * collide. This path has the opposite requirement. A delivery-verification record is already unique on
 * `(intentId, verifierVersion, evidenceDigest)` and is immutable, so re-requesting an anchor for one
 * must return the receipt that already exists rather than mint a second id for the same claim.
 *
 * Deriving the id from exactly that identity makes the repeat collide in the database, and idempotency
 * then costs nothing and cannot be forgotten by a caller.
 */

import { keccak256, toHex, type Hex } from "viem";

/**
 * Bumped if the derivation below changes.
 *
 * In the id itself, so a future scheme cannot silently produce the same id from different inputs — the
 * version is part of what is hashed rather than a note beside it.
 */
export const DELIVERY_VERIFICATION_RECEIPT_SCHEME = "untch:delivery-verification:v1" as const;

/** Everything about the verification itself. The receipt's transaction fields come from the SAME
 *  `SpendIntentInput` the settlement receipt was built from, so the two are joinable on chain. */
export interface DeliveryVerificationContext {
  readonly intentId: string;
  /** uint256 policyId (decimal string) — the SAME policy the settlement receipt was bound to. */
  readonly policyId: string;
  /** The settlement receipt's own intentHash. Carried unchanged: it is the on-chain join key. */
  readonly intentHash: `0x${string}`;
  /** The DECISION receipt written at settlement. Null when settlement never produced one. */
  readonly originalReceiptId: string | null;
  readonly verificationId: string;
  readonly verifierVersion: string;
  readonly evidenceDigest: string;
  readonly resultHash: string | null;
  readonly requestHash: string | null;
  readonly method: string;
  readonly verified: boolean;
  readonly verifiedAt: string;
  readonly settlementTx: string | null;
  readonly settlementChain: string | null;
  readonly settledAmount: string | null;
}

/**
 * The receipt id for one delivery-verification addendum.
 *
 * Derived from the record's own identity — the same triple the verification table is keyed on — plus
 * the intent. Identical evidence therefore lands on the identical id, and the insert's
 * `ON CONFLICT DO NOTHING` turns a repeat into a no-op without a separate lock or a read-then-write.
 */
export function deliveryVerificationReceiptId(input: {
  readonly intentId: string;
  readonly verificationId: string;
  readonly verifierVersion: string;
  readonly evidenceDigest: string;
}): Hex {
  return keccak256(
    toHex(
      [
        DELIVERY_VERIFICATION_RECEIPT_SCHEME,
        input.intentId,
        input.verificationId,
        input.verifierVersion,
        input.evidenceDigest,
      ].join(" "),
    ),
  );
}

/**
 * Everything this receipt asserts about the verification, committed as one hash.
 *
 * `relationship` is in here on purpose. It is the field that stops a reader treating this as a
 * settlement-time claim, and a commitment that omitted it would let the same hashes be presented as
 * though the check had happened when the money moved.
 */
export function deliveryVerificationMetadataHash(input: DeliveryVerificationContext): Hex {
  return keccak256(
    toHex(
      JSON.stringify({
        scheme: DELIVERY_VERIFICATION_RECEIPT_SCHEME,
        relationship: "SUBSEQUENT_TO_SETTLEMENT",
        intentId: input.intentId,
        originalReceiptId: input.originalReceiptId,
        verificationId: input.verificationId,
        verifierVersion: input.verifierVersion,
        method: input.method,
        verified: input.verified,
        verifiedAt: input.verifiedAt,
        evidenceDigest: input.evidenceDigest,
        resultHash: input.resultHash,
        requestHash: input.requestHash,
        settlementTx: input.settlementTx,
        settlementChain: input.settlementChain,
        settledAmount: input.settledAmount,
      }),
    ),
  );
}
