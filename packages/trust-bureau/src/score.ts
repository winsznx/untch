import type { Address, Hex } from "viem";
import type { ScoreDataSource } from "./datasource";
import type { WalletProfileProvider, WalletSignals } from "./rpc";
import type { AntiGamingDiscount } from "./anti-gaming";
import { applyAntiGaming } from "./anti-gaming";
import type { FeatureResult, ScoreResult, SubjectKind } from "./types";
import {
  BUYER_FEATURES,
  OBSERVED,
  VENDOR_FEATURES,
  Z_DEFAULT,
} from "./weights";
import {
  coldStartVendorFeature,
  deliveryConsistency,
  disputeSignal,
  sigmaFor,
  trackRecordDepth,
  walletOperationalProfile,
} from "./features/vendor";
import {
  ignoresVerificationRate,
  lateEscalationRate,
  outOfPolicyRate,
  unboundAcceptanceRate,
} from "./features/buyer";
import { renormalize, type RenormalizeInput } from "./renormalize";
import { clamp01to100, lcb } from "./lcb";
import { bandOf } from "./band";
import { epochOf } from "./epoch";
import { SCORE_DISCLAIMER } from "./disclaimer";

/**
 * The two §12 scoring entry points. Both are DETERMINISTIC weighted math — no LLM anywhere (I1). Each
 * reads the subject's real receipt / escalation / on-chain history via the injected `ScoreDataSource`
 * (+ RPC for the vendor wallet feature), computes features, renormalizes, derives the LCB and band,
 * runs the (currently no-op) anti-gaming hook, persists the epoch snapshot, and returns a result that
 * ALWAYS carries the disclaimer and NEVER presents a cold-start prior as observed data.
 */

export interface ScoreVendorOptions {
  readonly z?: number;
  readonly nowMs?: () => number;
  /** RPC provider for the wallet_operational_profile feature. Null/omitted ⇒ that feature has no data
   *  (neutral value, wide σ) — an honest "address not profiled", never a fabricated on-chain number. */
  readonly walletProvider?: WalletProfileProvider | null;
  /** Explicit payout address to profile; else resolved from the vendor's most recent ledger counterparty. */
  readonly payoutAddress?: Address;
  readonly discounts?: readonly AntiGamingDiscount[];
  /** Persist the snapshot to score_snapshots (default true). */
  readonly persist?: boolean;
}

export interface ScoreBuyerOptions {
  readonly z?: number;
  readonly nowMs?: () => number;
  readonly discounts?: readonly AntiGamingDiscount[];
  readonly persist?: boolean;
}

const COLD_START_VENDOR_KEYS = VENDOR_FEATURES.filter((f) => !f.real).map((f) => f.key);

export async function scoreVendor(
  ds: ScoreDataSource,
  vendorId: Hex,
  opts: ScoreVendorOptions = {},
): Promise<ScoreResult> {
  const z = opts.z ?? Z_DEFAULT;
  const nowMs = opts.nowMs ?? Date.now;
  const now = nowMs();
  const epoch = epochOf(Math.floor(now / 1000));

  const [orders, verifies, escalations] = await Promise.all([
    ds.vendorOrders(vendorId),
    ds.vendorVerifies(vendorId),
    ds.vendorEscalations(vendorId),
  ]);

  // Resolve the payout address to profile (explicit override, else most recent ledger counterparty).
  const payout =
    opts.payoutAddress ??
    ([...orders].reverse().find((o) => o.counterparty)?.counterparty as Address | undefined) ??
    null;
  let walletSignals: WalletSignals | null = null;
  if (payout && opts.walletProvider) {
    try {
      walletSignals = await opts.walletProvider.signals(payout);
    } catch {
      walletSignals = null; // RPC failed ⇒ no data, wide σ. Never fabricate an on-chain number.
    }
  }

  const track = trackRecordDepth(orders);
  const delivery = deliveryConsistency(verifies);
  const dispute = disputeSignal(orders, verifies, escalations);
  const wallet = walletOperationalProfile(walletSignals);

  const realRaw: Record<string, { value: number; n: number; note: string }> = {
    track_record_depth: track,
    delivery_consistency: delivery,
    dispute_signal: dispute,
    wallet_operational_profile: wallet,
  };

  // Build the renormalize inputs: 4 real observed features + 3 cold-start (observed:false → renormed out).
  const renormInputs: RenormalizeInput[] = VENDOR_FEATURES.map((spec) => {
    if (spec.real) {
      const raw = realRaw[spec.key]!;
      return {
        key: spec.key,
        value: raw.value,
        sigma: sigmaFor(spec.key, raw.n),
        baseWeight: spec.baseWeight,
        observed: true,
      };
    }
    const cs = coldStartVendorFeature(spec.key, spec.baseWeight);
    return { key: spec.key, value: cs.value, sigma: cs.sigma, baseWeight: spec.baseWeight, observed: false };
  });

  const renorm = renormalize(renormInputs);
  const score = clamp01to100(renorm.score);
  const sigma = renorm.uncertainty.sigma;
  const lcbValue = lcb(score, sigma, z);

  // Feature results for the response: real observed + cold-start priors, each tagged honestly.
  let features: FeatureResult[] = VENDOR_FEATURES.map((spec) => {
    if (spec.real) {
      const raw = realRaw[spec.key]!;
      return {
        key: spec.key,
        value: raw.value,
        sigma: sigmaFor(spec.key, raw.n),
        source: OBSERVED,
        baseWeight: spec.baseWeight,
        weightApplied: renorm.weightApplied[spec.key] ?? 0,
        n: raw.n,
        note: raw.note,
      };
    }
    const cs = coldStartVendorFeature(spec.key, spec.baseWeight);
    return {
      key: cs.key,
      value: cs.value,
      sigma: cs.sigma,
      source: cs.source,
      implemented: cs.implemented,
      baseWeight: cs.baseWeight,
      weightApplied: 0,
      n: cs.n,
      note: cs.note,
    };
  });

  // Anti-gaming hook (currently no-op) — features pass THROUGH it so a real detector is a drop-in later.
  features = [
    ...applyAntiGaming(
      features,
      {
        subjectId: vendorId,
        relatedAddresses: payout ? [payout] : [],
        eventTimestamps: [...orders, ...verifies].map((r) => r.createdAt),
      },
      opts.discounts,
    ),
  ];

  const result: ScoreResult = {
    subjectKind: "VENDOR",
    subjectId: vendorId,
    epoch,
    score,
    sigma,
    lcb: lcbValue,
    z,
    band: bandOf(lcbValue),
    features,
    uncertainty: renorm.uncertainty,
    coldStartFeatures: COLD_START_VENDOR_KEYS,
    computedAt: new Date(now).toISOString(),
    disclaimer: SCORE_DISCLAIMER,
    anchoredRoot: null,
  };

  if (opts.persist !== false) await ds.saveSnapshot(toSnapshot(result));
  return result;
}

export async function scoreBuyer(
  ds: ScoreDataSource,
  agentId: Hex,
  opts: ScoreBuyerOptions = {},
): Promise<ScoreResult> {
  const z = opts.z ?? Z_DEFAULT;
  const nowMs = opts.nowMs ?? Date.now;
  const now = nowMs();
  const epoch = epochOf(Math.floor(now / 1000));

  const [orders, verifies, escalations] = await Promise.all([
    ds.buyerOrders(agentId),
    ds.buyerVerifies(agentId),
    ds.buyerEscalations(agentId),
  ]);

  const raw = {
    unbound_acceptance_rate: unboundAcceptanceRate(verifies),
    ignores_verification_rate: ignoresVerificationRate(orders, verifies),
    out_of_policy_rate: outOfPolicyRate(orders),
    late_escalation_rate: lateEscalationRate(escalations),
  };

  // Every buyer feature is REAL (observed) — no cold-start, so no missing-signal σ term. A badness rate
  // b maps to a per-feature value 100·(1−b); the renormalizer (all weights sum to 1) then yields
  // score = 100·(1 − Σ wⱼ·bⱼ), and σ from the per-feature sample sizes.
  const renormInputs: RenormalizeInput[] = BUYER_FEATURES.map((spec) => {
    const r = raw[spec.key as keyof typeof raw];
    return {
      key: spec.key,
      value: clamp01to100(100 * (1 - r.badness)),
      sigma: sigmaFor(spec.key, r.n),
      baseWeight: spec.weight,
      observed: true,
    };
  });

  const renorm = renormalize(renormInputs);
  const score = clamp01to100(renorm.score);
  const sigma = renorm.uncertainty.sigma;
  const lcbValue = lcb(score, sigma, z);

  let features: FeatureResult[] = BUYER_FEATURES.map((spec) => {
    const r = raw[spec.key as keyof typeof raw];
    return {
      key: spec.key,
      value: clamp01to100(100 * (1 - r.badness)),
      sigma: sigmaFor(spec.key, r.n),
      source: OBSERVED,
      baseWeight: spec.weight,
      weightApplied: renorm.weightApplied[spec.key] ?? 0,
      n: r.n,
      note: r.note,
    };
  });

  features = [
    ...applyAntiGaming(
      features,
      { subjectId: agentId, relatedAddresses: [], eventTimestamps: orders.map((o) => o.createdAt) },
      opts.discounts,
    ),
  ];

  const result: ScoreResult = {
    subjectKind: "BUYER",
    subjectId: agentId,
    epoch,
    score,
    sigma,
    lcb: lcbValue,
    z,
    band: bandOf(lcbValue),
    features,
    uncertainty: renorm.uncertainty,
    coldStartFeatures: [],
    computedAt: new Date(now).toISOString(),
    disclaimer: SCORE_DISCLAIMER,
    anchoredRoot: null,
  };

  if (opts.persist !== false) await ds.saveSnapshot(toSnapshot(result));
  return result;
}

/** Project a computed result onto the durable §8 snapshot row. */
export function toSnapshot(r: ScoreResult): {
  subject: SubjectKind;
  subjectId: string;
  epoch: number;
  score: number;
  sigma: number;
  lcb: number;
  band: ScoreResult["band"];
  features: readonly FeatureResult[];
  anchoredRoot: Hex | null;
  computedAt: string;
} {
  return {
    subject: r.subjectKind,
    subjectId: r.subjectId,
    epoch: r.epoch,
    score: r.score,
    sigma: r.sigma,
    lcb: r.lcb,
    band: r.band,
    features: r.features,
    anchoredRoot: r.anchoredRoot,
    computedAt: r.computedAt,
  };
}
