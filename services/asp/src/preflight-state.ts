/**
 * Assemble LedgerWindowState injects for RULE_EVAL rules that need external state:
 * challenge CBC, vendor LCB score, available proof tiers.
 */

import { keccak256, toHex, type Hex } from "viem";
import type { Ledger, LedgerWindowState, SpendIntentInput } from "@untch/policy-engine";
import type { ScoreDataSource } from "@untch/trust-bureau";

/** Same vendor id derivation as receipt-writer mapping (host of endpoint). */
export function vendorIdOf(endpoint: string): Hex {
  let key = endpoint;
  try {
    key = new URL(endpoint).host;
  } catch {
    /* hash raw string */
  }
  return keccak256(toHex(`untch-vendor:${key}`));
}

export type PreflightBodyInjects = {
  readonly challengeBinding?: {
    readonly expected: Readonly<Record<string, string | undefined>>;
    readonly presented: Readonly<Record<string, string | undefined>>;
  } | null;
  /** Optional inline vendor score (tests / offline). Prefer bureau snapshot when wired. */
  readonly vendorScore?: {
    readonly vendorId?: string;
    readonly lcb: number;
    readonly score: number;
    readonly sigma: number;
    readonly computedAtMs?: number;
    readonly available?: boolean;
  } | null;
  readonly availableProofTier?: number;
};

/**
 * Wrap a base ledger so `read()` enriches the window with injects for one preflight call.
 * Pure assembly — no I/O inside read except the optional async bureau load done before wrap.
 */
export function wrapLedgerWithInjects(
  base: Ledger,
  injects: Partial<LedgerWindowState>,
): Ledger {
  return {
    async read(partitionKey: string): Promise<LedgerWindowState> {
      const state = await base.read(partitionKey);
      return { ...state, ...injects };
    },
    commitApproved(partitionKey, intent, decision) {
      return base.commitApproved(partitionKey, intent, decision);
    },
  };
}

/** Build injects for one preflight from request body + optional bureau. */
export async function assemblePreflightInjects(
  intent: SpendIntentInput,
  body: unknown,
  bureau: ScoreDataSource | null,
): Promise<Partial<LedgerWindowState>> {
  const b = (body ?? {}) as Record<string, unknown> & PreflightBodyInjects;
  let challengeBinding: LedgerWindowState["challengeBinding"];
  let vendorScore: LedgerWindowState["vendorScore"];
  const availableProofTier =
    typeof b.availableProofTier === "number" ? b.availableProofTier : 0;

  // CBC: accept { challengeBinding: { expected, presented } } or nested challenge.expected/presented
  const rawChallenge = b.challengeBinding ?? b.challenge;
  if (rawChallenge && typeof rawChallenge === "object") {
    const c = rawChallenge as Record<string, unknown>;
    const expected = (c.expected ?? c.authorized) as Record<string, string | undefined> | undefined;
    const presented = (c.presented ?? c.actual) as Record<string, string | undefined> | undefined;
    if (expected && presented) {
      challengeBinding = { expected, presented };
    }
  }

  // Vendor score: body override first, else bureau latest snapshot
  if (b.vendorScore && typeof b.vendorScore === "object") {
    const vs = b.vendorScore;
    vendorScore = {
      vendorId: vs.vendorId ?? vendorIdOf(intent.endpoint),
      lcb: vs.lcb,
      score: vs.score,
      sigma: vs.sigma,
      computedAtMs: vs.computedAtMs ?? Date.now(),
      available: vs.available !== false,
    };
  } else if (bureau) {
    try {
      const vid = vendorIdOf(intent.endpoint);
      const snap = await bureau.latestSnapshot("VENDOR", vid);
      if (snap) {
        vendorScore = {
          vendorId: vid,
          lcb: snap.lcb,
          score: snap.score,
          sigma: snap.sigma,
          computedAtMs: Date.parse(snap.computedAt) || Date.now(),
          available: true,
        };
      } else {
        vendorScore = {
          vendorId: vid,
          lcb: 0,
          score: 0,
          sigma: 0,
          computedAtMs: Date.now(),
          available: false,
        };
      }
    } catch {
      vendorScore = null;
    }
  }

  return {
    availableProofTier,
    ...(challengeBinding !== undefined ? { challengeBinding } : {}),
    ...(vendorScore !== undefined ? { vendorScore } : {}),
  };
}
