/**
 * @untch/proof-engine — Untch Proof Engine (PRD §13 / §7.3).
 *
 * PARTIAL SLICE. Real: T0 — deterministic schema/conformance verification (ajv schema validation +
 * required-field / size / regex / enum field checks + exact-hash for fully-deterministic deliverables),
 * plus acceptance-criteria binding (the presented spec must hash back to the committed §8.1
 * acceptanceHash) and the §7.3 VERIFY_SKIPPED_UNCOMMITTED buyer-hygiene path. STUBBED: T1 (Trace),
 * T2 (Source), T3 (TEE), T4 (Evaluator/Dispute) — each returns NOT_IMPLEMENTED, tagged
 * `implemented:false` in the tier ladder, never silently skipped and never faked as PASS. A manifest
 * test pins exactly which tiers are real (T0) vs stubbed (T1–T4). See README.md and PRD §13/§7.3.
 *
 * Invariant I1 holds here: no LLM anywhere in the verification path — every T0 check is pure,
 * deterministic code, same as the policy engine's own rules.
 */
export { verifyDelivery, type VerifyRequest } from "./evaluate";
export {
  IMPLEMENTED_TIERS,
  STUBBED_TIERS,
  STUB_NOTES,
  VERIFY_RESULT_CODE,
  isImplementedTier,
  stubTierResult,
  type VerifyResultName,
} from "./tiers";
export { runT0 } from "./t0";
export type {
  AcceptanceCriteria,
  Delivery,
  Diff,
  FieldConstraint,
  ProofTier,
  ReleaseRecommendation,
  TierResult,
  TierResultCode,
  VerifyFinal,
  VerifyOutcome,
} from "./types";
export { TIER_NUMBER } from "./types";
