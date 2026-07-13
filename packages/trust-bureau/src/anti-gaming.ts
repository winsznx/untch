import type { FeatureResult } from "./types";

/**
 * §12 anti-gaming — DELIBERATELY DEFERRED, named here so it is never silently absent (same category as
 * proof-engine's T1/T2 stubs and policy-engine's unbuilt rules).
 *
 * §12 lists "wallet-cluster self-dealing discounts on receipted volume" and "review-velocity anomaly
 * damping". Both are damping functions that discount a feature when a gaming pattern is detected. In a
 * build this size there is essentially NO real gaming to detect or validate against — a cluster
 * detector tuned on non-existent adversarial data would be theater, not defense. So this build ships
 * the INTERFACE where those discounts plug in, wired into the scoring path as an identity transform,
 * and leaves the detectors themselves for when there is real volume to calibrate them on.
 *
 * A discount is a pure function (FeatureResult, context) → FeatureResult that may only LOWER a value or
 * WIDEN a σ (never improve a score), keeping the hook incapable of inflating reputation even once real
 * detectors land.
 */
export interface AntiGamingContext {
  readonly subjectId: string;
  /** Payout/counterparty addresses seen for this subject — the substrate a cluster detector would use. */
  readonly relatedAddresses: readonly string[];
  /** Timestamps of the reputation-moving events — the substrate a velocity detector would use. */
  readonly eventTimestamps: readonly string[];
}

export interface AntiGamingDiscount {
  readonly key: string;
  apply(feature: FeatureResult, ctx: AntiGamingContext): FeatureResult;
}

/** The identity discount this build ships: no-op, but it proves the hook is wired and enforces the
 *  "may only lower, never raise" contract at the type level. */
export const NO_OP_DISCOUNTS: readonly AntiGamingDiscount[] = [];

/**
 * Apply the registered discounts in order. With `NO_OP_DISCOUNTS` this returns the features unchanged
 * — but the scoring path calls THROUGH here, so landing a real detector later is an addition to this
 * registry, not a change to the scoring core. Each discount is clamped to the "never improve" contract.
 */
export function applyAntiGaming(
  features: readonly FeatureResult[],
  ctx: AntiGamingContext,
  discounts: readonly AntiGamingDiscount[] = NO_OP_DISCOUNTS,
): readonly FeatureResult[] {
  if (discounts.length === 0) return features;
  return features.map((f) => {
    let out = f;
    for (const d of discounts) {
      const next = d.apply(out, ctx);
      // Enforce the contract: a discount may only lower value or widen sigma.
      out = {
        ...next,
        value: Math.min(out.value, next.value),
        sigma: Math.max(out.sigma, next.sigma),
      };
    }
    return out;
  });
}
