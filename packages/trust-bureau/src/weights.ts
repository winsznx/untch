import type { FeatureSource } from "./types";

/**
 * §12 feature weights and the model constants. Every number here is a deliberate, documented choice —
 * there is no learned parameter and no LLM anywhere (I1). Changing a weight changes enforcement, so the
 * weights live in one audited place, not scattered across the feature code.
 */

/** §12 default z for the lower-confidence bound LCB = score − z·σ. */
export const Z_DEFAULT = 1.28;

/** §12 "Epoch 6h" — the snapshot/anchor cadence, in seconds. */
export const EPOCH_SECONDS = 6 * 60 * 60;

/**
 * The seven §12 vendor features with their base weights (sum = 1.00). `real: true` are computed from
 * data this build actually has; `real: false` are the three whose only real source is OKX marketplace
 * listing/review data, which is UNAVAILABLE (README finding) — they fall back to a category prior and
 * are renormalized out of the point estimate with σ widened (§12's own fallback rule).
 */
export interface VendorFeatureSpec {
  readonly key: string;
  readonly baseWeight: number;
  readonly real: boolean;
}

export const VENDOR_FEATURES: readonly VendorFeatureSpec[] = [
  { key: "track_record_depth", baseWeight: 0.2, real: true },
  { key: "delivery_consistency", baseWeight: 0.2, real: true },
  { key: "dispute_signal", baseWeight: 0.15, real: true },
  { key: "wallet_operational_profile", baseWeight: 0.1, real: true },
  { key: "rating_quality", baseWeight: 0.2, real: false },
  { key: "price_sanity", baseWeight: 0.075, real: false },
  { key: "claims_consistency", baseWeight: 0.075, real: false },
];

/** Buyer-hygiene features (§12), all REAL — every signal maps onto a subsystem already built. Each is a
 *  "badness" rate in [0,1]; the hygiene score is 100·(1 − Σ wⱼ·badnessⱼ). Weights sum to 1. */
export interface BuyerFeatureSpec {
  readonly key: string;
  readonly weight: number;
}

export const BUYER_FEATURES: readonly BuyerFeatureSpec[] = [
  { key: "unbound_acceptance_rate", weight: 0.3 },
  { key: "ignores_verification_rate", weight: 0.3 },
  { key: "out_of_policy_rate", weight: 0.25 },
  { key: "late_escalation_rate", weight: 0.15 },
];

/**
 * The category-baseline PRIOR a cold-start feature reports (§12 "category-baseline prior"). A neutral,
 * mildly-conservative value: absent any observed signal we neither reward nor punish a vendor on that
 * dimension, we just carry the uncertainty. This is REPORTED, never used in the point estimate.
 */
export const CATEGORY_BASELINE_PRIOR = 60;

/**
 * The std of a cold-start prior (score points). This is the §12 "σ increases" magnitude: a prior is a
 * WIDE guess, so renormalizing a feature's weight away injects `renormalizedAwayFraction · PRIOR_STD²`
 * of variance. With 0.35 of the weight missing this alone gives σ ≈ sqrt(0.35)·22 ≈ 13 points, so
 * every vendor score in this build carries a conservative LCB even when the raw score looks fine —
 * exactly the §12 behavior: missing marketplace data tightens enforcement automatically.
 */
export const COLD_START_PRIOR_STD = 22;

/** Per-feature uncertainty model. An observed feature with n backing observations has
 *  σ = BASE_STD / sqrt(1 + n / K) + FLOOR: wide when n is small, tending to FLOOR as data accrues. */
export const FEATURE_BASE_STD = 18;
export const FEATURE_SIGMA_FLOOR = 2;

/** Per-feature K (observations for the σ to roughly halve from BASE). Larger K ⇒ σ shrinks slower —
 *  a feature that needs more evidence before we trust it. */
export const FEATURE_K: Record<string, number> = {
  track_record_depth: 8,
  delivery_consistency: 6,
  dispute_signal: 10,
  wallet_operational_profile: 4,
  unbound_acceptance_rate: 6,
  ignores_verification_rate: 6,
  out_of_policy_rate: 8,
  late_escalation_rate: 5,
};

/** σ for a feature with n observations (the shrink model above). */
export function featureSigma(key: string, n: number): number {
  const k = FEATURE_K[key] ?? 8;
  return FEATURE_BASE_STD / Math.sqrt(1 + Math.max(0, n) / k) + FEATURE_SIGMA_FLOOR;
}

/** Saturation points for the log-scaled / rate features. */
export const TRACK_RECORD_SATURATION = 50;
export const WALLET_NONCE_SATURATION = 500;
/** Dispute rate (per 100 receipted orders) at which dispute_signal hits 0. */
export const DISPUTE_RATE_SATURATION = 25;

export const OBSERVED: FeatureSource = "observed";
export const COLD_START: FeatureSource = "cold-start-prior";
