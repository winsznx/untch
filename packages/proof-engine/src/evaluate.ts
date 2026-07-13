import { hashCanonicalJson } from "@untch/canon";
import type { Hex } from "viem";
import { runT0 } from "./t0";
import { STUBBED_TIERS, VERIFY_RESULT_CODE, stubTierResult } from "./tiers";
import type {
  AcceptanceCriteria,
  Delivery,
  Diff,
  ReleaseRecommendation,
  TierResult,
  VerifyFinal,
  VerifyOutcome,
} from "./types";

/**
 * The Proof Engine entry point (PRD §7.3). Given a delivery, the intent's COMMITTED acceptanceHash,
 * and the acceptance-criteria document, it runs the tier ladder and returns a single `VerifyOutcome`
 * that (a) reflects exactly what happened, (b) never claims more than a tier proved, and (c) lists the
 * full §13 ladder including every stubbed tier as NOT_IMPLEMENTED — so nothing is silently absent.
 *
 * No LLM anywhere (I1). Deterministic: same inputs → same outcome, same diffs, same order.
 */

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

export interface VerifyRequest {
  readonly intentHash: Hex;
  /** The §8.1 acceptanceHash committed at intent time. `0x0` ⇒ §7.3 VERIFY_SKIPPED_UNCOMMITTED. */
  readonly acceptanceHash: Hex;
  /** The acceptance criteria doc. Required when acceptanceHash is non-zero (it must hash back to it). */
  readonly criteria?: AcceptanceCriteria;
  readonly delivery: Delivery;
  /** §7.3 REQUIRED_TIER from policy.requireProofTier(amount). Defaults to 0 (T0). A required tier > 0
   *  is honestly unmet in this slice → VERIFY_TIER_NOT_IMPLEMENTED (never a silent pass). */
  readonly requiredTier?: number;
  /** Injectable clock for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The full §13 ladder with the T0 line filled in and T1–T4 as their NOT_IMPLEMENTED stubs. */
function ladder(t0: TierResult): TierResult[] {
  return [t0, ...STUBBED_TIERS.map((t) => stubTierResult(t))];
}

function isZero(hash: Hex): boolean {
  return hash.toLowerCase() === ZERO_HASH;
}

/** The delivery's canonical hash for the receipt — payload preferred, else an opaque payloadHash. */
function deliveryHash(delivery: Delivery): Hex {
  if (delivery.payload !== undefined) return hashCanonicalJson(delivery.payload);
  return delivery.payloadHash ?? ZERO_HASH;
}

export function verifyDelivery(req: VerifyRequest): VerifyOutcome {
  const now = req.now ?? Date.now;
  const verifiedAt = new Date(now()).toISOString();
  const requiredTier = req.requiredTier ?? 0;

  // §7.3 first branch: no acceptanceHash committed at intent ⇒ VERIFY_SKIPPED_UNCOMMITTED. Logged as a
  // buyer-hygiene event, NEVER silently ignored and NEVER a pass.
  if (isZero(req.acceptanceHash)) {
    const t0: TierResult = {
      tier: "T0",
      result: "SKIPPED_UNCOMMITTED",
      note: "no acceptanceHash was committed at intent time (§8.1 0x0) — nothing to verify against; buyer-hygiene event (§7.3)",
    };
    return {
      intentHash: req.intentHash,
      requiredTier,
      achievedTier: 0,
      final: "VERIFY_SKIPPED_UNCOMMITTED",
      recommendation: "NONE",
      tierResults: ladder(t0),
      payloadHash: deliveryHash(req.delivery),
      diffs: [],
      hygieneEvent: true,
      verifyResultCode: VERIFY_RESULT_CODE.SKIPPED_UNCOMMITTED,
      proofTier: 0,
      verifiedAt,
    };
  }

  // A non-zero acceptanceHash was committed but no criteria doc was presented — we cannot verify. This
  // is a FAIL (the committed spec was withheld), never a pass.
  if (!req.criteria) {
    const diffs: Diff[] = [
      {
        check: "criteriaBinding",
        expected: req.acceptanceHash,
        message: "a non-zero acceptanceHash was committed but no acceptance-criteria document was supplied to verify against",
      },
    ];
    const t0: TierResult = { tier: "T0", result: "FAIL", diffs, note: "acceptance criteria not presented" };
    return {
      intentHash: req.intentHash,
      requiredTier,
      achievedTier: 0,
      final: "VERIFY_FAILED",
      recommendation: "WITHHOLD",
      tierResults: ladder(t0),
      payloadHash: deliveryHash(req.delivery),
      diffs,
      hygieneEvent: false,
      verifyResultCode: VERIFY_RESULT_CODE.FAIL,
      proofTier: 0,
      verifiedAt,
    };
  }

  // Run T0 for real.
  const { tier: t0, payloadHash } = runT0(req.acceptanceHash, req.criteria, req.delivery);
  const t0Diffs = t0.diffs ?? [];

  let final: VerifyFinal;
  let recommendation: ReleaseRecommendation;
  let verifyResultCode: number;

  if (t0.result === "FAIL") {
    // T0 is the floor: if it fails, that dominates any higher-tier requirement (§7.3 recommend WITHHOLD).
    final = "VERIFY_FAILED";
    recommendation = "WITHHOLD";
    verifyResultCode = VERIFY_RESULT_CODE.FAIL;
  } else if (requiredTier > 0) {
    // T0 passed, but the policy required a tier this slice does not run. We cannot honestly claim PASS.
    final = "VERIFY_TIER_NOT_IMPLEMENTED";
    recommendation = "WITHHOLD";
    verifyResultCode = VERIFY_RESULT_CODE.NOT_IMPLEMENTED;
  } else {
    final = "VERIFY_PASSED";
    recommendation = "RELEASE";
    verifyResultCode = VERIFY_RESULT_CODE.PASS;
  }

  return {
    intentHash: req.intentHash,
    requiredTier,
    // T0 is the only tier this slice runs, so the achieved tier number is 0 whenever anything is
    // achieved; a T0 FAIL achieves nothing but is reported via `final`, not a negative tier number.
    achievedTier: 0,
    final,
    recommendation,
    tierResults: ladder(t0),
    payloadHash,
    diffs: t0Diffs,
    hygieneEvent: false,
    verifyResultCode,
    proofTier: 0,
    verifiedAt,
  };
}
