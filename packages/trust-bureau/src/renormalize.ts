import type { FeatureResult, UncertaintyBreakdown } from "./types";
import { COLD_START_PRIOR_STD } from "./weights";

/**
 * The §12 "Data-source fallback" mechanism, implemented for real (not skipped):
 *
 *   "if marketplace listing/review data is unavailable or restricted … feature weights renormalize and
 *    σ increases (LCB tightens enforcement automatically)."
 *
 * Given every feature's base weight and per-feature σ, split them into OBSERVED (weight kept) and
 * COLD-START (weight renormalized away). The point estimate is the weight-renormalized average of the
 * observed features only — a cold-start prior is REPORTED but never contributes its value to the score.
 * σ is then widened by a term proportional to the weight that was renormalized away, so the more of the
 * intended signal is missing, the wider the uncertainty and the lower the LCB.
 *
 * Math:
 *   Wobs   = Σ baseWeightᵢ over observed features
 *   wnormᵢ = baseWeightᵢ / Wobs                          (renormalized to sum to 1 over observed)
 *   score  = Σ wnormᵢ · valueᵢ                           (observed only)
 *   fmiss  = (Σ baseWeightⱼ over cold-start) / Wtotal    (fraction of weight renormalized away)
 *   Vobs   = Σ wnormᵢ² · σᵢ²                             (point-estimate variance from observed σ)
 *   Vmiss  = fmiss · PRIOR_STD²                          (the §12 "σ increases" term)
 *   σ      = sqrt(Vobs + Vmiss)
 *
 * `weightApplied` on each returned feature is wnormᵢ for observed, 0 for cold-start — so the tool
 * response shows exactly which features moved the number and which are priors carried for context.
 */
export interface RenormalizeInput {
  readonly key: string;
  readonly value: number;
  readonly sigma: number;
  readonly baseWeight: number;
  readonly observed: boolean;
}

export interface RenormalizeOutput {
  readonly score: number;
  readonly weightApplied: Record<string, number>;
  readonly uncertainty: UncertaintyBreakdown;
}

export function renormalize(features: readonly RenormalizeInput[]): RenormalizeOutput {
  const totalWeight = features.reduce((s, f) => s + f.baseWeight, 0);
  const observed = features.filter((f) => f.observed);
  const observedWeight = observed.reduce((s, f) => s + f.baseWeight, 0);

  if (observedWeight <= 0) {
    // No observed signal at all — there is nothing to renormalize onto. This is a hard cold start:
    // the score is undefined-by-data, so we return the neutral midpoint with maximal uncertainty
    // (fmiss = 1), which drives the LCB to the floor. Callers should read this as "no data".
    return {
      score: 50,
      weightApplied: Object.fromEntries(features.map((f) => [f.key, 0])),
      uncertainty: {
        observedVariance: 0,
        missingSignalVariance: COLD_START_PRIOR_STD * COLD_START_PRIOR_STD,
        renormalizedAwayWeight: 1,
        sigma: COLD_START_PRIOR_STD,
      },
    };
  }

  const weightApplied: Record<string, number> = {};
  let score = 0;
  let observedVariance = 0;
  for (const f of features) {
    if (f.observed) {
      const wnorm = f.baseWeight / observedWeight;
      weightApplied[f.key] = wnorm;
      score += wnorm * f.value;
      observedVariance += wnorm * wnorm * f.sigma * f.sigma;
    } else {
      weightApplied[f.key] = 0;
    }
  }

  const missingWeight = totalWeight - observedWeight;
  const fMissing = totalWeight > 0 ? missingWeight / totalWeight : 0;
  const missingSignalVariance = fMissing * COLD_START_PRIOR_STD * COLD_START_PRIOR_STD;
  const sigma = Math.sqrt(observedVariance + missingSignalVariance);

  return {
    score,
    weightApplied,
    uncertainty: {
      observedVariance,
      missingSignalVariance,
      renormalizedAwayWeight: fMissing,
      sigma,
    },
  };
}

/** Attach the renormalized `weightApplied` back onto the feature results (for the response). */
export function withWeightApplied(
  features: readonly Omit<FeatureResult, "weightApplied">[],
  weightApplied: Record<string, number>,
): FeatureResult[] {
  return features.map((f) => ({ ...f, weightApplied: weightApplied[f.key] ?? 0 }));
}
