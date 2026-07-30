import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, type Hex } from "viem";
import {
  DELIVERY_VERIFICATION_RECEIPT_SCHEME,
  deliveryVerificationMetadataHash,
  deliveryVerificationReceiptId,
  draftFromDeliveryVerification,
  type DeliveryVerificationContext,
} from "../src";
import type { SpendIntentInput } from "@untch/policy-engine";

/**
 * The VERIFY receipt that carries a delivery-verification addendum.
 *
 * Intent `ci_e58174e549f6a21c591eacfa` settled real USDC on Solana mainnet and produced a DECISION
 * receipt. The verification came later, from evidence that receipt does not contain, so re-anchoring the
 * settlement batch can never carry it: a batch's receipt set is fixed when the batch is created.
 *
 * Two claims, two receipts. These tests hold that line — and hold the id deterministic, because an
 * addendum that could be minted twice under two ids would let one verification appear as two.
 */

const INTENT_ID = "ci_e58174e549f6a21c591eacfa";
const VERIFICATION_ID = "dv_8337d223cd0a4d5b7291";
const ORIGINAL_RECEIPT = "0xac5265d37ac3208bb822c0cf5ee2be0e89a3f1e82ff963c7e9c3ceecc808eb29";
const SETTLEMENT_TX = "63cbzAEuDkMFs41TwuGKjYC3YWz3e8FeYbQVfrt2WGmvWotdUMmiJCf3yzyd8EypPDikfQjWAxWGUa5rDTJLrhVK";
const INTENT_HASH = `0x${"1c".repeat(32)}` as Hex;

function ctx(over: Partial<DeliveryVerificationContext> = {}): DeliveryVerificationContext {
  return {
    intentId: INTENT_ID,
    policyId: "42442941931142776416717046967261510801573487062357914330441778955482615545182",
    intentHash: INTENT_HASH,
    originalReceiptId: ORIGINAL_RECEIPT,
    verificationId: VERIFICATION_ID,
    verifierVersion: "purch-paid-read/1.0.0",
    evidenceDigest: "0x65591fb41a719f2409f6744222759fd9f7148087f12b9df08810bbc821b806b2",
    resultHash: "0x75ffe3dca670dcdb576916c2c9fcfbce0e9d4f7e09a8b62a092de11e08cf1d77",
    requestHash: `0x${"ab".repeat(32)}`,
    method: "PAID_READ_RESULT_BINDING",
    verified: true,
    verifiedAt: "2026-07-30T16:19:25.084Z",
    settlementTx: SETTLEMENT_TX,
    settlementChain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    settledAmount: "10000",
    ...over,
  };
}

const input: SpendIntentInput = {
  buyerAgentId: "1",
  endpoint: "https://api.purch.xyz/x402/search#shop.search",
  amount: 0.01,
  token: "0x0000000000000000000000000000000000000000",
  category: "consumer",
  taskHash: `0x${"7a".repeat(32)}`,
  policyHash: "0xaa8f4ae24501576eadae6e8ed9b8a11118409c0f0a5b5d97bf2790a812df014b",
} as unknown as SpendIntentInput;

describe("the VERIFY receipt id is deterministic, so one verification cannot become two", () => {
  test("identical evidence always derives the identical id", () => {
    // #given the same verification, twice
    // #then the id is the same, which is what makes the insert's ON CONFLICT a real idempotency guard
    assert.equal(deliveryVerificationReceiptId(ctx()), deliveryVerificationReceiptId(ctx()));
  });

  test("it matches the scheme's stated derivation exactly", () => {
    const c = ctx();
    const expected = keccak256(
      toHex(
        [DELIVERY_VERIFICATION_RECEIPT_SCHEME, c.intentId, c.verificationId, c.verifierVersion, c.evidenceDigest].join(" "),
      ),
    );
    assert.equal(deliveryVerificationReceiptId(c), expected);
  });

  /**
   * Every component of the verification's identity moves the id.
   *
   * A component that did NOT move it would let two genuinely different verifications collide onto one
   * receipt, and the second would silently vanish behind the first.
   */
  test("changing any identity component changes the id", () => {
    const base = deliveryVerificationReceiptId(ctx());
    for (const over of [
      { intentId: "ci_000000000000000000000000" },
      { verificationId: "dv_different0000000000" },
      { verifierVersion: "purch-paid-read/2.0.0" },
      { evidenceDigest: `0x${"9".repeat(64)}` },
    ]) {
      assert.notEqual(deliveryVerificationReceiptId(ctx(over)), base, JSON.stringify(over));
    }
  });

  test("the VERIFY receipt id is not the settlement receipt id", () => {
    // If these ever collided, one anchor would appear to cover both claims.
    assert.notEqual(deliveryVerificationReceiptId(ctx()).toLowerCase(), ORIGINAL_RECEIPT.toLowerCase());
  });
});

describe("the metadata hash binds every field the addendum asserts", () => {
  /**
   * Each binding is proven by MOVING it and watching the commitment change.
   *
   * A field merely present in the hashed object proves nothing; a field that can change without moving
   * the hash is not bound, whatever the source reads like.
   */
  test("all ten required bindings move the hash", () => {
    const base = deliveryVerificationMetadataHash(ctx());
    const cases: Partial<DeliveryVerificationContext>[] = [
      { originalReceiptId: `0x${"0".repeat(64)}` },
      { intentId: "ci_111111111111111111111111" },
      { verificationId: "dv_other0000000000000" },
      { verifierVersion: "purch-paid-read/9.9.9" },
      { method: "PROVIDER_STATUS_POLL" },
      { verifiedAt: "2026-01-01T00:00:00.000Z" },
      { evidenceDigest: `0x${"c".repeat(64)}` },
      { resultHash: `0x${"d".repeat(64)}` },
      { settlementTx: "someOtherSignature" },
      { verified: false },
    ];
    for (const over of cases) {
      assert.notEqual(deliveryVerificationMetadataHash(ctx(over)), base, `unbound: ${JSON.stringify(over)}`);
    }
  });

  test("the commitment states SUBSEQUENT_TO_SETTLEMENT", () => {
    // Present in the hashed document, so the same hashes cannot later be presented as a
    // settlement-time claim.
    const c = ctx();
    const withRelationship = keccak256(
      toHex(
        JSON.stringify({
          scheme: DELIVERY_VERIFICATION_RECEIPT_SCHEME,
          relationship: "SUBSEQUENT_TO_SETTLEMENT",
          intentId: c.intentId,
          originalReceiptId: c.originalReceiptId,
          verificationId: c.verificationId,
          verifierVersion: c.verifierVersion,
          method: c.method,
          verified: c.verified,
          verifiedAt: c.verifiedAt,
          evidenceDigest: c.evidenceDigest,
          resultHash: c.resultHash,
          requestHash: c.requestHash,
          settlementTx: c.settlementTx,
          settlementChain: c.settlementChain,
          settledAmount: c.settledAmount,
        }),
      ),
    );
    assert.equal(deliveryVerificationMetadataHash(c), withRelationship);
  });
});

describe("the draft is a VERIFY receipt that moves no money", () => {
  test("it is kind VERIFY", () => {
    assert.equal(draftFromDeliveryVerification(input, ctx()).kind, "VERIFY");
  });

  /**
   * NO ledger entry, and this is the load-bearing one.
   *
   * A ledger movement here would book the settled USDC a second time and make two anchors of one
   * payment look like two payments.
   */
  test("it carries no ledger entry at all", () => {
    const draft = draftFromDeliveryVerification(input, ctx());
    assert.equal(draft.ledger, undefined);
    assert.equal("ledger" in draft && draft.ledger !== undefined, false);
  });

  test("decision is the NA sentinel, so a zero is never read as ALLOW", () => {
    assert.equal(draftFromDeliveryVerification(input, ctx()).onchain.decision, 0);
  });

  test("a verified addendum is verifyResult PASS, a refused one is FAIL", () => {
    assert.equal(draftFromDeliveryVerification(input, ctx({ verified: true })).onchain.verifyResult, 1);
    // A refused verification is still a fact, and anchoring it is how the refusal becomes checkable.
    assert.equal(draftFromDeliveryVerification(input, ctx({ verified: false })).onchain.verifyResult, 2);
  });

  /**
   * `proofTier` 0, honestly.
   *
   * The verification re-reads evidence Untch already held and reaches no independent oracle. A higher
   * tier would assert corroboration nobody performed.
   */
  test("proofTier is T0 and does not inflate itself", () => {
    assert.equal(draftFromDeliveryVerification(input, ctx()).onchain.proofTier, 0);
  });

  test("provenance is store-committed, because every input was already persisted", () => {
    assert.equal(draftFromDeliveryVerification(input, ctx()).provenance, "store-committed");
  });
});

/**
 * The on-chain LINK between the two receipts.
 *
 * They share `intentHash`, `policyId` and `policyHash`, so an indexer joins them with nothing
 * off-chain. Without that, the addendum would be an orphan hash nobody could tie to the settlement.
 */
describe("the two receipts are joinable on chain", () => {
  test("the VERIFY receipt carries the settlement's intentHash and policy unchanged", () => {
    const on = draftFromDeliveryVerification(input, ctx()).onchain;
    assert.equal(on.intentHash, INTENT_HASH);
    assert.equal(on.policyHash, input.policyHash);
    assert.equal(on.policyId.toString(), ctx().policyId);
    assert.equal(on.taskHash, input.taskHash);
  });

  test("a different intent produces a different receipt, so the join cannot be forged", () => {
    const a = draftFromDeliveryVerification(input, ctx()).onchain;
    const b = draftFromDeliveryVerification(input, ctx({ intentId: "ci_222222222222222222222222" })).onchain;
    assert.notEqual(a.receiptId, b.receiptId);
  });
});
