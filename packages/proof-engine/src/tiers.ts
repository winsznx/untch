import type { ProofTier, TierResult } from "./types";

/**
 * The tier manifest for the PARTIAL Proof Engine (PRD §13 / §7.3).
 *
 * ONE of §13's five tiers is real here — T0 (deterministic schema/conformance verification). The
 * other FOUR remain explicit stubs: each returns NOT_IMPLEMENTED (never PASS) tagged
 * `implemented:false` in the tier ladder, so a stubbed tier is never silently skipped, never silently
 * absent, and never faked as success (the HARD RULES). This mirrors exactly how `@untch/policy-engine`
 * stubs its unbuilt RULE_EVAL rules — a manifest test asserts precisely which tiers are real (T0) and
 * which are stubbed (T1–T4), so nobody mistakes this slice for the complete engine.
 *
 * Why T1/T2 are deferred, not overlooked (the two "next up" tiers):
 *   • T1 (Trace Proof) needs a registry of vendor/worker signing keys "registered at index time"
 *     (§13). That registry does not exist yet, and nothing in this build has a real vendor to
 *     register a key for — building T1 now would mean inventing a fake key registry to satisfy a tier
 *     nothing could actually exercise.
 *   • T2 (Source Proof) needs a real source-manifest concept (§13) with the same problem.
 * T3 (TEE attestation adapter registry) and T4 (evaluator/dispute) are later build stages (§22.7);
 * they are stubbed here too so a policy that asks for them gets an honest NOT_IMPLEMENTED, never a
 * quiet pass. T0 has no such gap — it checks the acceptance criteria already committed at intent time
 * (the §8.1 `acceptanceHash`), which this build already threads through the intentHash.
 */

/** The tiers that are REAL in this slice, in §13 order. */
export const IMPLEMENTED_TIERS = ["T0"] as const;

/** The §13 tiers NOT implemented in this slice, in order. Each maps to its §13 mechanism + its real
 *  blocker; here each is a no-op NOT_IMPLEMENTED marked `implemented:false`. The manifest test asserts
 *  the ladder's stub set equals exactly this list. */
export const STUBBED_TIERS = ["T1", "T2", "T3", "T4"] as const;

/** The precise, honest deferral reason surfaced on each stub tier's `note`. */
export const STUB_NOTES: Record<(typeof STUBBED_TIERS)[number], string> = {
  T1: "NOT_IMPLEMENTED — §13 Trace Proof needs a vendor/worker signing-key registry (registered at index time); no such registry and no real vendor to register yet.",
  T2: "NOT_IMPLEMENTED — §13 Source Proof needs a real source-manifest concept; not built yet.",
  T3: "NOT_IMPLEMENTED — §13 TEE Proof needs an attestation adapter registry (§22.7); not built yet.",
  T4: "NOT_IMPLEMENTED — §13 Evaluator/Dispute Proof needs the dispute-packet + arbitration ingest (§7.6/§13); not built yet.",
};

/** The tier ladder entry for a stub — always NOT_IMPLEMENTED, never PASS (HARD RULE). */
export function stubTierResult(tier: (typeof STUBBED_TIERS)[number]): TierResult {
  return {
    tier: tier as ProofTier,
    result: "NOT_IMPLEMENTED",
    implemented: false,
    note: STUB_NOTES[tier],
  };
}

/** True iff `tier` is the one tier this slice actually runs. */
export function isImplementedTier(tier: ProofTier): boolean {
  return (IMPLEMENTED_TIERS as readonly string[]).includes(tier);
}

/**
 * Canonical §10.3 `verifyResult` uint8 codes — the value a verify receipt records on-chain.
 * `UNVERIFIED = 0` is FROZEN: it is the default every prior (decision-kind) receipt has carried, i.e.
 * "no verify result recorded". A real verify_delivery call now writes one of the non-zero codes for
 * the first time. New codes may be appended; existing numbers never change (an indexer keys on them).
 */
export const VERIFY_RESULT_CODE = {
  UNVERIFIED: 0,
  PASS: 1,
  FAIL: 2,
  SKIPPED_UNCOMMITTED: 3,
  NOT_IMPLEMENTED: 4,
} as const;

export type VerifyResultName = keyof typeof VERIFY_RESULT_CODE;
