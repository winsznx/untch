import type { EscalationView, OrderRecord, VerifyRecord } from "../datasource";
import type { WalletSignals } from "../rpc";
import {
  APPROVED_CODE,
  VERIFY_FAIL,
  VERIFY_PASS,
} from "../decision-codes";
import { isApproved } from "../decision-codes";
import {
  CATEGORY_BASELINE_PRIOR,
  COLD_START,
  COLD_START_PRIOR_STD,
  DISPUTE_RATE_SATURATION,
  featureSigma,
  OBSERVED,
  TRACK_RECORD_SATURATION,
  WALLET_NONCE_SATURATION,
} from "../weights";
import { clamp01to100 } from "../lcb";

/**
 * The four REAL vendor features (§12), each computed from data this build actually has. Pure functions:
 * records in, {value ∈ [0,100], n, note} out. `n` drives the per-feature σ (few observations ⇒ wide).
 * The three marketplace-only features (rating_quality, price_sanity, claims_consistency) are NOT here —
 * they are honest cold-start priors built by `coldStartVendorFeature`.
 */

export interface RawFeature {
  readonly value: number;
  readonly n: number;
  readonly note: string;
}

/** Confidence weight of a verify result by intent provenance — a store-committed (authoritative) result
 *  counts fully; a caller-supplied (or pre-provenance, unknown) result counts at half confidence. This
 *  is the exact §12 distinction the last prompt's verify_delivery fix made queryable. */
function provenanceWeight(p: VerifyRecord["provenance"]): number {
  return p === "store-committed" ? 1 : 0.5;
}

/** track_record_depth (0.20): log-scaled count of APPROVED (completed, receipted) orders for the vendor. */
export function trackRecordDepth(orders: readonly OrderRecord[]): RawFeature {
  const n = orders.filter((o) => isApproved(o.decision)).length;
  const value = clamp01to100((100 * Math.log1p(n)) / Math.log1p(TRACK_RECORD_SATURATION));
  return {
    value,
    n,
    note:
      n === 0
        ? "no receipted orders yet for this vendor — neutral depth, wide uncertainty"
        : `${n} receipted order(s), log-scaled to saturation ${TRACK_RECORD_SATURATION}`,
  };
}

/** delivery_consistency (0.20): provenance-weighted T0 tier-pass rate over real verify_delivery results.
 *  SKIPPED/NOT_IMPLEMENTED are not tier verdicts and are excluded from the pass/fail denominator. */
export function deliveryConsistency(verifies: readonly VerifyRecord[]): RawFeature {
  let passWeight = 0;
  let totalWeight = 0;
  let passes = 0;
  let fails = 0;
  let committed = 0;
  let callerSupplied = 0;
  for (const v of verifies) {
    if (v.verifyResult !== VERIFY_PASS && v.verifyResult !== VERIFY_FAIL) continue;
    const w = provenanceWeight(v.provenance);
    totalWeight += w;
    if (v.provenance === "store-committed") committed += 1;
    else callerSupplied += 1;
    if (v.verifyResult === VERIFY_PASS) {
      passWeight += w;
      passes += 1;
    } else {
      fails += 1;
    }
  }
  if (totalWeight === 0) {
    return { value: 50, n: 0, note: "no T0 verify results for this vendor — neutral, wide uncertainty" };
  }
  const value = clamp01to100((100 * passWeight) / totalWeight);
  // Effective sample = the confidence-weighted count (store-committed contributes more than caller-supplied).
  const nEff = totalWeight;
  return {
    value,
    n: nEff,
    note:
      `${passes} pass / ${fails} fail T0 (${committed} store-committed, ${callerSupplied} caller-supplied), ` +
      `provenance-weighted pass rate ${(value / 100).toFixed(3)}`,
  };
}

/** dispute_signal (0.15): (escalation deny/timeout + verify-fail) per 100 receipted orders — the
 *  internal proxy for formal arbitration data this build does not have. Higher disputes ⇒ lower value. */
export function disputeSignal(
  orders: readonly OrderRecord[],
  verifies: readonly VerifyRecord[],
  escalations: readonly EscalationView[],
): RawFeature {
  const orderN = orders.filter((o) => o.decision === APPROVED_CODE).length;
  const denyTimeout = escalations.filter((e) => e.status === "DENIED" || e.status === "EXPIRED").length;
  const verifyFail = verifies.filter((v) => v.verifyResult === VERIFY_FAIL).length;
  const disputes = denyTimeout + verifyFail;
  const ratePer100 = (100 * disputes) / Math.max(orderN, 1);
  const value = clamp01to100(100 * (1 - Math.min(ratePer100 / DISPUTE_RATE_SATURATION, 1)));
  return {
    value,
    n: orderN,
    note:
      `${disputes} dispute signal(s) (${denyTimeout} escalation deny/timeout + ${verifyFail} verify-fail) ` +
      `over ${orderN} receipted order(s) = ${ratePer100.toFixed(1)}/100`,
  };
}

/** wallet_operational_profile (0.10): public on-chain signals for the payout address via direct RPC.
 *  Age/regularity/diversity need an indexer (deferred, see README); this uses the three real point-in-
 *  time RPC signals (tx-count activity, reserve, EOA/contract). `signals` null ⇒ address unknown. */
export function walletOperationalProfile(signals: WalletSignals | null): RawFeature {
  if (signals === null) {
    return {
      value: 50,
      n: 0,
      note: "no known payout address for this vendor — neutral profile, wide uncertainty",
    };
  }
  const activity = clamp01to100(
    (100 * Math.log1p(signals.txCount)) / Math.log1p(WALLET_NONCE_SATURATION),
  );
  const reserve = signals.balanceWei > 0n ? 1 : 0;
  const value = clamp01to100(0.85 * activity + 15 * reserve);
  return {
    value,
    n: signals.txCount,
    note:
      `payout ${signals.address}: txCount ${signals.txCount}, ` +
      `${reserve ? "has" : "no"} native reserve, ${signals.isContract ? "contract" : "EOA"} ` +
      `(age/regularity/diversity deferred to an indexer, not claimed)`,
  };
}

/** Per-feature σ from the shrink model, keyed by feature name. */
export function sigmaFor(key: string, n: number): number {
  return featureSigma(key, n);
}

export const COLD_START_VENDOR_NOTE =
  "marketplace listing/review data is unavailable (no confirmed OKX.AI API or scrapeable source — see " +
  "README finding), so this feature falls back to the category-baseline prior. Its weight is " +
  "renormalized across the four real features and σ is widened per §12's fallback rule. This value is a " +
  "PRIOR, not observed data.";

/** A cold-start-prior vendor feature: reports the category baseline, tagged cold-start-prior +
 *  implemented:false so it is never mistaken for observed data. Weight is renormalized away in `score.ts`. */
export function coldStartVendorFeature(
  key: string,
  baseWeight: number,
): {
  readonly key: string;
  readonly value: number;
  readonly sigma: number;
  readonly source: typeof COLD_START;
  readonly implemented: false;
  readonly baseWeight: number;
  readonly n: number;
  readonly note: string;
} {
  return {
    key,
    value: CATEGORY_BASELINE_PRIOR,
    sigma: COLD_START_PRIOR_STD,
    source: COLD_START,
    implemented: false,
    baseWeight,
    n: 0,
    note: COLD_START_VENDOR_NOTE,
  };
}

export { OBSERVED };
