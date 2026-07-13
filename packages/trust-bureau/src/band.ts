import type { Band } from "./types";

/**
 * Reliability band from the LCB (§12/§15 directory display). Derived from the LOWER-confidence bound,
 * not the raw score, so the band a policy/dashboard reads already carries the uncertainty discount.
 * Thresholds are fixed and documented here (there is no learned boundary).
 */
export function bandOf(lcbValue: number): Band {
  if (lcbValue >= 80) return "TRUSTED";
  if (lcbValue >= 65) return "STABLE";
  if (lcbValue >= 50) return "CAUTION";
  if (lcbValue >= 35) return "ELEVATED_RISK";
  return "HIGH_RISK";
}
