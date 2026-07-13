/**
 * @untch/trust-bureau — PRD §12 Untch Bureau. Deterministic, weighted, NO-LLM (I1) vendor + buyer
 * reliability scoring with per-score uncertainty and LCB-based enforcement.
 *
 * Honesty manifest (enumerable, like the proof/policy engines):
 *   • REAL vendor features (observed):  track_record_depth, delivery_consistency, dispute_signal,
 *                                        wallet_operational_profile.
 *   • COLD-START vendor features:        rating_quality, price_sanity, claims_consistency — marketplace
 *                                        data unavailable (see README), so category-baseline prior,
 *                                        renormalized out, σ widened. Tagged source:"cold-start-prior"
 *                                        + implemented:false; NEVER presented as observed.
 *   • REAL buyer hygiene (all observed): unbound_acceptance_rate, ignores_verification_rate,
 *                                        out_of_policy_rate, late_escalation_rate.
 *   • DEFERRED (named, not silent):      anti-gaming detectors (hook shipped, no-op), appeal/correction
 *                                        flow (needs the §15 dashboard).
 */

export * from "./types";
export { scoreVendor, scoreBuyer, toSnapshot, type ScoreVendorOptions, type ScoreBuyerOptions } from "./score";
export { lcb, clamp01to100 } from "./lcb";
export { bandOf } from "./band";
export { epochOf, currentEpoch } from "./epoch";
export { renormalize, withWeightApplied, type RenormalizeInput, type RenormalizeOutput } from "./renormalize";
export { SCORE_DISCLAIMER } from "./disclaimer";
export {
  VENDOR_FEATURES,
  BUYER_FEATURES,
  Z_DEFAULT,
  EPOCH_SECONDS,
  CATEGORY_BASELINE_PRIOR,
  COLD_START_PRIOR_STD,
  featureSigma,
} from "./weights";
export * from "./features/vendor";
export * from "./features/buyer";
export {
  applyAntiGaming,
  NO_OP_DISCOUNTS,
  type AntiGamingContext,
  type AntiGamingDiscount,
} from "./anti-gaming";
export {
  type ScoreDataSource,
  type OrderRecord,
  type VerifyRecord,
  type EscalationView,
} from "./datasource";
export { MemoryScoreDataSource } from "./datasource-memory";
export { PgScoreDataSource } from "./datasource-pg";
export { createPool, runMigrations, type Pool } from "./db";
export {
  ViemWalletProfileProvider,
  type WalletProfileProvider,
  type WalletSignals,
} from "./rpc";
export { leafOf, hashPair, merkleRoot, rootOfSnapshots } from "./merkle";
export { ScoreAnchorer, type ScoreAnchorerOptions, type AnchorResult } from "./anchor";
export {
  loadAnchorConfig,
  SCORE_ANCHOR_CHAIN,
  SCORE_RECEIPTS_CONTRACT,
  DEFAULT_RPC_URL,
  MissingEnvError,
  type AnchorConfig,
} from "./config";
export {
  APPROVED_CODE,
  BLOCKED_CODES,
  isApproved,
  isBlocked,
  VERIFY_PASS,
  VERIFY_FAIL,
  VERIFY_SKIPPED_UNCOMMITTED,
  VERIFY_NOT_IMPLEMENTED,
} from "./decision-codes";
