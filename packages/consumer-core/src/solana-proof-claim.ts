/**
 * The durable one-shot Solana proof claim: types, scope hashing, and the release rule.
 *
 * WHAT THE FIRST VERSION GOT WRONG
 *
 * It inferred consumption from execution rows. If no execution for the proof intent had reached PAID
 * or ACKNOWLEDGED, the gate was treated as unused. Between invoking the signer and persisting PAID
 * there are five separate moments though: the credential is built, the transaction is signed, it goes
 * to the sponsor, the sponsor broadcasts, and only then does anything of ours get written. A crash in
 * that window leaves a row that does not say PAID while a real transfer may already be on chain, so
 * the inference reports "unused" for a gate that has already spent, and the next attempt pays twice.
 *
 * The question a gate must answer is not "did this succeed?" It is "might the treasury's authority
 * already have been used?", and only a record written BEFORE the signer can answer that afterwards.
 *
 * So the claim is a durable row, taken under a conditional write, before the signer is reachable.
 *
 * CLAIMED IS A ONE-WAY DOOR
 *
 * Nothing in automation moves a CLAIMED gate back to ARMED. "The attempt failed" and "no money moved"
 * are different claims, and only the second justifies re-arming. A FAILED execution row is precisely
 * what an ambiguous broadcast also produces, so it can never be the evidence. RELEASED_PRE_SIGN
 * exists for when the stronger claim can genuinely be shown, and it demands that no credential, no
 * signature and no submission were ever recorded.
 */

import { sha256Hex, stableStringify } from "./ids";
import { formatMoney, type Money } from "./money";
import type { AssetRef, CaipChainId } from "./assets";

export type SolanaProofGateState =
  | "ARMED"
  | "CLAIMED"
  | "SETTLED"
  | "ACKNOWLEDGED"
  | "MANUAL_REVIEW"
  | "RELEASED_PRE_SIGN";

/** The exact authority a proof gate carries. Hashed to give the row its identity. */
export interface SolanaProofScope {
  readonly intentId: string;
  readonly providerId: string;
  readonly capability: string;
  readonly chain: CaipChainId;
  readonly asset: AssetRef;
  readonly maxAmount: Money;
  /** ISO 8601. The gate refuses at or after this instant. */
  readonly expiresAt: string;
}

/**
 * The scope hash, which is also the row's primary key.
 *
 * Keyed on the scope rather than on a random id so that two workers arming the same proof converge on
 * one row instead of creating two gates that each look unclaimed. Every field that bounds authority is
 * in the hash, which means widening any of them produces a DIFFERENT gate rather than silently
 * reusing the existing one's claim state.
 */
export function solanaProofScopeHash(scope: SolanaProofScope): string {
  return sha256Hex(
    stableStringify({
      intentId: scope.intentId,
      providerId: scope.providerId,
      capability: scope.capability,
      chain: scope.chain,
      asset: { symbol: scope.asset.symbol, address: scope.asset.address },
      maxAmount: scope.maxAmount.amount.toString(),
      expiresAt: scope.expiresAt,
    }),
  );
}

export interface SolanaProofGateRecord {
  readonly scopeHash: string;
  readonly state: SolanaProofGateState;
  readonly scope: SolanaProofScope;
  readonly claimedByExecution: string | null;
  readonly claimedAt: string | null;
  /** Set the moment the signer path becomes reachable. Its presence forbids automatic release. */
  readonly signerReachedAt: string | null;
  readonly credentialCreatedAt: string | null;
  readonly txSignature: string | null;
  readonly txSubmittedAt: string | null;
  readonly settledAt: string | null;
  readonly confirmedSlot: number | null;
  readonly txError: string | null;
  readonly preTokenAmount: string | null;
  readonly postTokenAmount: string | null;
  readonly tokenDelta: string | null;
  readonly mint: string | null;
  readonly authority: string | null;
  readonly feePayer: string | null;
  readonly acknowledgedAt: string | null;
  readonly providerResultHash: string | null;
  readonly manualReviewReason: string | null;
  readonly releasedAt: string | null;
  readonly releasedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What may be written as a proof progresses. Every field is additive evidence, never a reset. */
export type SolanaProofProgress = Partial<{
  signerReachedAt: string;
  credentialCreatedAt: string;
  txSignature: string;
  txSubmittedAt: string;
  settledAt: string;
  confirmedSlot: number;
  txError: string | null;
  preTokenAmount: string;
  postTokenAmount: string;
  tokenDelta: string;
  mint: string;
  authority: string;
  feePayer: string;
  acknowledgedAt: string;
  providerResultHash: string;
  manualReviewReason: string;
}>;

/** States from which no further signing is permitted, whatever else is configured. */
const SPENT_OR_UNCERTAIN: ReadonlySet<SolanaProofGateState> = new Set<SolanaProofGateState>([
  "CLAIMED",
  "SETTLED",
  "ACKNOWLEDGED",
  "MANUAL_REVIEW",
]);

export function isReusable(state: SolanaProofGateState): boolean {
  return !SPENT_OR_UNCERTAIN.has(state);
}

/**
 * Whether a gate may be released back to a re-armable state.
 *
 * Deliberately strict, and deliberately not a function of how the attempt ended. The only acceptable
 * evidence is the ABSENCE of every trace of signer access: no reach timestamp, no credential, no
 * signature, no submission. If any one of those exists, the honest state is MANUAL_REVIEW and a human
 * decides.
 *
 * For a production proof, being stranded costs a retry. Being wrong costs a double payment.
 */
export function canReleasePreSign(record: SolanaProofGateRecord): { ok: boolean; why: string } {
  if (record.signerReachedAt !== null) {
    return { ok: false, why: `the signer was reached at ${record.signerReachedAt}` };
  }
  if (record.credentialCreatedAt !== null) {
    return { ok: false, why: `a payment credential was created at ${record.credentialCreatedAt}` };
  }
  if (record.txSignature !== null) {
    return { ok: false, why: `a transaction signature exists (${record.txSignature})` };
  }
  if (record.txSubmittedAt !== null) {
    return { ok: false, why: `a transaction was submitted at ${record.txSubmittedAt}` };
  }
  if (record.settledAt !== null) {
    return { ok: false, why: `settlement was recorded at ${record.settledAt}` };
  }
  return { ok: true, why: "no credential, signature or submission was ever recorded" };
}

/**
 * A redacted operational view.
 *
 * Carries what an operator needs in order to decide whether a retry is safe, and nothing that would
 * make the log itself a liability: no secret, no signed credential, no RPC url, no provider payload.
 */
export function describeProofGate(record: SolanaProofGateRecord): Record<string, unknown> {
  return {
    state: record.state,
    intentId: record.scope.intentId,
    provider: record.scope.providerId,
    capability: record.scope.capability,
    chain: record.scope.chain,
    maxAmount: formatMoney(record.scope.maxAmount),
    expiresAt: record.scope.expiresAt,
    claimedAt: record.claimedAt,
    claimedByExecution: record.claimedByExecution,
    signerReached: record.signerReachedAt !== null,
    txSignature: record.txSignature,
    settledAt: record.settledAt,
    confirmedSlot: record.confirmedSlot,
    tokenDelta: record.tokenDelta,
    acknowledgedAt: record.acknowledgedAt,
    manualReviewReason: record.manualReviewReason,
    reusable: isReusable(record.state),
  };
}
