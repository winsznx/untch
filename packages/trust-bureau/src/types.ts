import type { Hex } from "viem";

/**
 * Untch Bureau (§12) domain types. The score is a DETERMINISTIC weighted feature model — NO LLM
 * anywhere (invariant I1). Every score carries a per-score uncertainty σ; enforcement always uses the
 * lower-confidence bound LCB = score − z·σ (§12), never the raw score.
 *
 * A first-class honesty rule runs through these types: a feature whose value came from a category
 * baseline PRIOR (because its real data source — the OKX marketplace — is unavailable, see README) is
 * tagged `source: "cold-start-prior"` and `observed: false`. That distinction is carried in the tool
 * RESPONSE, not hidden in a code comment (HARD RULE: never present a prior as observed data).
 */

export type SubjectKind = "VENDOR" | "BUYER";

/** Raw §10.3 `subjectKind` uint8 codes anchored on-chain by `UntchReceipts.anchorScore`. Passed
 *  through the contract verbatim (not constrained on-chain). Frozen once anchored. */
export const SUBJECT_KIND_CODE: Record<SubjectKind, number> = {
  VENDOR: 1,
  BUYER: 2,
};

/**
 * Where a feature's value came from:
 *   • "observed"          — computed from real data this build actually has (receipts, escalations,
 *                           on-chain RPC). The only kind that moves enforcement in this build.
 *   • "cold-start-prior"  — a category-baseline PRIOR standing in for a signal whose real source is
 *                           unavailable (marketplace listing/review data — see README finding). Its
 *                           weight is renormalized AWAY from the point estimate and σ is widened; the
 *                           prior value is reported for transparency but never presented as observed.
 */
export type FeatureSource = "observed" | "cold-start-prior";

/** One scored feature. `value` and `sigma` are in score points [0,100]. `weightApplied` is the
 *  weight actually used in the point estimate AFTER renormalization — 0 for a cold-start feature that
 *  was renormalized out (its `baseWeight` is what §12 assigns it before the fallback). */
export interface FeatureResult {
  readonly key: string;
  readonly value: number;
  /** Per-feature uncertainty (std, score points). Wide when the feature has little/no data. */
  readonly sigma: number;
  readonly source: FeatureSource;
  /** `false` on a cold-start-prior feature — mirrors how the policy/proof engines tag their stubs so
   *  a manifest can enumerate exactly which features are real. Absent on an observed feature. */
  readonly implemented?: false;
  readonly baseWeight: number;
  readonly weightApplied: number;
  /** Count of real observations backing an observed feature (0 for a cold-start prior). Drives σ. */
  readonly n: number;
  /** Deterministic, human-readable note — the data behind an observed value, or the deferral reason
   *  on a cold-start prior. Never free-text model output. */
  readonly note: string;
}

/** The uncertainty breakdown behind the final σ — surfaced so "why this σ" is auditable (§12/§15). */
export interface UncertaintyBreakdown {
  /** Variance from the observed features' own per-feature σ, at renormalized weights. */
  readonly observedVariance: number;
  /** Variance ADDED because cold-start features were renormalized out (the §12 "σ increases" term).
   *  Proportional to the total weight that was renormalized away. */
  readonly missingSignalVariance: number;
  /** Fraction of total base weight that was renormalized away (marketplace signal missing). */
  readonly renormalizedAwayWeight: number;
  /** Final σ = sqrt(observedVariance + missingSignalVariance). */
  readonly sigma: number;
}

/** Reliability band derived from the LCB (NOT the raw score) — enforcement reads the band/LCB. */
export type Band = "TRUSTED" | "STABLE" | "CAUTION" | "ELEVATED_RISK" | "HIGH_RISK";

/** The full computed score for one subject. `score` is the raw weighted point estimate; `lcb` is what
 *  enforcement uses. `anchoredRoot` is set once the epoch's snapshot tree is anchored on-chain. */
export interface ScoreResult {
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly epoch: number;
  readonly score: number;
  readonly sigma: number;
  readonly lcb: number;
  readonly z: number;
  readonly band: Band;
  readonly features: readonly FeatureResult[];
  readonly uncertainty: UncertaintyBreakdown;
  /** The subjects whose real signals were unavailable and fell back to a prior — named, not silent. */
  readonly coldStartFeatures: readonly string[];
  readonly computedAt: string;
  readonly disclaimer: string;
  /** The merkle root this subject was anchored under (null until the epoch is anchored). */
  readonly anchoredRoot: Hex | null;
}

/** A row of the §8 `score_snapshots` table (Postgres source of truth). */
export interface ScoreSnapshotRow {
  readonly subject: SubjectKind;
  readonly subjectId: string;
  readonly epoch: number;
  readonly score: number;
  readonly sigma: number;
  readonly lcb: number;
  readonly band: Band;
  readonly features: readonly FeatureResult[];
  readonly anchoredRoot: Hex | null;
  readonly computedAt: string;
}
