import type { Hex } from "viem";

/**
 * Types for the Untch Proof Engine — the PARTIAL slice defined in the package README.
 *
 * Shapes mirror PRD §7.3 (delivery-verification state machine) and §13 (proof-tier table) so the
 * object this package emits is the exact shape the receipt writer and the verify_delivery tool
 * consume. Where §7.3 has more tiers than this slice runs, the missing tiers are NOT omitted — they
 * appear in the result as explicit NOT_IMPLEMENTED entries (see `tiers.ts`). No LLM anywhere (I1).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tiers (§13 T0–T4)
// ─────────────────────────────────────────────────────────────────────────────

/** The §13 tier labels. T0 is real in this slice; T1–T4 are stubs (see `IMPLEMENTED_TIERS`). */
export type ProofTier = "T0" | "T1" | "T2" | "T3" | "T4";

/** Numeric tier code, matching §8/§10.3 `proofTier` (uint8) and §8's `proof.defaultTier`. */
export const TIER_NUMBER: Record<ProofTier, number> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
  T4: 4,
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-tier result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The outcome of running ONE tier's check.
 *   • PASS / FAIL               — the tier ran and reached a verdict (T0 only, this slice).
 *   • SKIPPED_UNCOMMITTED       — no acceptanceHash was committed at intent time (§7.3 first branch;
 *                                 a buyer-hygiene event, not a pass and not a failure).
 *   • NOT_IMPLEMENTED           — the tier is a stub in this slice; it did NOT run. Distinct from
 *                                 PASS by construction (HARD RULE: a stub never reports PASS).
 */
export type TierResultCode = "PASS" | "FAIL" | "SKIPPED_UNCOMMITTED" | "NOT_IMPLEMENTED";

/**
 * One machine-readable difference behind a T0 FAIL (§7.3 `VERIFY_FAILED{diffs[]}`). `check` names the
 * conformance check that failed; the remaining fields describe exactly what diverged so a caller can
 * act without re-deriving anything. Deterministic — no free-text model output.
 */
export interface Diff {
  /** Which check produced this diff, e.g. "schema", "requiredField", "size", "regex", "enum",
   *  "exactHash", "criteriaBinding". */
  readonly check: string;
  /** JSON pointer / dot-path into the delivery payload the diff is about (when field-scoped). */
  readonly path?: string;
  readonly expected?: string | number;
  readonly actual?: string | number;
  /** A short, deterministic description of the divergence. */
  readonly message: string;
}

/** One tier's line in the result ladder. `implemented:false` marks a stub, mirroring how the policy
 *  engine tags its stubbed rules — so the manifest test can enumerate exactly which tiers are real. */
export interface TierResult {
  readonly tier: ProofTier;
  readonly result: TierResultCode;
  /** Present and `false` ONLY on stub tiers (T1–T4). Absent on the real tier (T0). */
  readonly implemented?: false;
  /** T0 FAIL diffs (§7.3). Empty/absent on PASS. */
  readonly diffs?: readonly Diff[];
  /** Human-readable note — the deferral reason on a stub, the skip reason on SKIPPED_UNCOMMITTED. */
  readonly note?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verify outcome (§7.3 terminal states)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The §7.3 terminal verification states THIS slice can emit.
 *   • VERIFY_PASSED               — every tier ≤ REQUIRED passed → recommend RELEASE.
 *   • VERIFY_FAILED               — T0 schema/conformance failed → recommend WITHHOLD (§7.3).
 *   • VERIFY_SKIPPED_UNCOMMITTED  — no acceptanceHash committed at intent → logged buyer-hygiene event.
 *   • VERIFY_TIER_NOT_IMPLEMENTED — the policy required a tier this slice does not run (T1+); we
 *                                   CANNOT honestly claim PASS, so this is its own terminal state,
 *                                   never a silent pass (HARD RULE).
 */
export type VerifyFinal =
  | "VERIFY_PASSED"
  | "VERIFY_FAILED"
  | "VERIFY_SKIPPED_UNCOMMITTED"
  | "VERIFY_TIER_NOT_IMPLEMENTED";

/** What the verify result recommends the caller do about releasing the payment (§7.3). Verification
 *  RECOMMENDS; it never itself moves money (the money invariant lives in the vault / broker). */
export type ReleaseRecommendation = "RELEASE" | "WITHHOLD" | "NONE";

/**
 * The full verification outcome for one delivery. `tierResults` is the honest ladder — including
 * every stubbed tier as NOT_IMPLEMENTED — so nothing is ever silently absent. `verifyResultCode` and
 * `proofTier` are the exact uint8s the §10.3 receipt records (see `@untch/receipt-writer`), so a
 * verify receipt finally carries a REAL result instead of the default 0/0 every prior receipt had.
 */
export interface VerifyOutcome {
  readonly intentHash: Hex;
  /** The tier the policy required (§7.3 REQUIRED_TIER; T0/0 default in this slice). */
  readonly requiredTier: number;
  /** The highest tier actually satisfied (0 = T0). Equals requiredTier on PASS. */
  readonly achievedTier: number;
  readonly final: VerifyFinal;
  readonly recommendation: ReleaseRecommendation;
  /** The full §13 tier ladder, real tiers and stubs alike — never a truncated view. */
  readonly tierResults: readonly TierResult[];
  /** The delivery payload's canonical keccak256 hash (§9), recorded on the receipt + returned. */
  readonly payloadHash: Hex;
  /** Flattened T0 diffs for convenience (same objects as tierResults[T0].diffs). */
  readonly diffs: readonly Diff[];
  /** True when the outcome is the §7.3 buyer-hygiene event (no acceptanceHash committed). */
  readonly hygieneEvent: boolean;
  readonly verifyResultCode: number;
  readonly proofTier: number;
  readonly verifiedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Acceptance criteria (the committed T0 spec) + delivery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The committed acceptance-criteria document a T0 delivery is checked against. The buyer commits
 * `acceptanceHash = hashCanonicalJson(criteria)` (§9 RFC 8785) at intent time; at verify time the
 * criteria doc is presented and MUST hash back to that committed value (binding integrity — a buyer
 * cannot swap the spec after delivery). Every field is optional so a criteria doc can be as light as
 * a single required field or as strict as an exact hash; an empty doc checks nothing but its binding.
 */
export interface AcceptanceCriteria {
  /** §9 canonicalization version tag carried on every hash-bearing record. */
  readonly canonVersion?: string;
  /** A JSON Schema (ajv draft 2020-12 / draft-07) the delivery payload must validate against. */
  readonly schema?: Record<string, unknown>;
  /** Dot-path fields that must be present (and non-undefined) in the payload. */
  readonly requiredFields?: readonly string[];
  /** Byte bounds on the payload's canonical JSON serialization. */
  readonly sizeBounds?: {
    readonly maxBytes?: number;
    readonly minBytes?: number;
  };
  /** Per-field regex / enum / length constraints, checked in order. */
  readonly fieldConstraints?: readonly FieldConstraint[];
  /** For a FULLY deterministic deliverable: the payload's canonical keccak256 must equal this. */
  readonly exactHash?: {
    readonly algorithm: "keccak256-canonical-json";
    readonly value: Hex;
  };
}

/** One §7.3 "regex/enum" (+ size) constraint on a single payload field, addressed by dot-path. */
export interface FieldConstraint {
  readonly field: string;
  /** ECMAScript regex source the field's string value must fully or partially match. */
  readonly regex?: string;
  /** `true` (default) requires a full-string match (anchored); `false` allows a partial match. */
  readonly regexAnchored?: boolean;
  /** The field's value must be one of these. */
  readonly enum?: readonly (string | number | boolean)[];
  /** Bounds on the field's string length (or array length). */
  readonly maxLen?: number;
  readonly minLen?: number;
}

/** What T0 verifies. `payload` is the actual delivered object (required for schema/field checks);
 *  when only an opaque `payloadHash` is available, exact-hash matching still runs but schema checks
 *  are reported as not-evaluable diffs rather than silently passing. */
export interface Delivery {
  readonly payload?: unknown;
  /** Supplied when the payload itself is opaque/large — used for exact-hash matching only. */
  readonly payloadHash?: Hex;
}
