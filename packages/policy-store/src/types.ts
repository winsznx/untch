import type { PolicyRules } from "@untch/policy-engine";
import type { Address, Hex } from "viem";

/**
 * Types for the policy store. `PolicyRules` is re-exported from @untch/policy-engine on purpose: the
 * rules a policy stores are the EXACT shape the engine evaluates — there is one ruleset type in the
 * system, not a store copy that could drift from what preflight enforces.
 */

/** Stored lifecycle, mirroring the on-chain PolicyRegistry enum {ACTIVE, PAUSED}. EXPIRED is derived
 *  from the rules' expiry at read time (never stored), exactly as the contract derives it. */
export type StoredPolicyStatus = "ACTIVE" | "PAUSED";

/**
 * Proof a stored row is backed by real chain state (§8 `onchain_ref`). `registerTx` is fixed at
 * creation; `lastTx`/`lastBlock` track the most recent mutation (update/pause/resume) so the row's
 * current state is always traceable to the tx that produced it.
 */
export interface OnchainRef {
  readonly chainId: number;
  readonly registry: Address;
  readonly registerTx: Hex;
  readonly registerBlock: number;
  readonly lastTx: Hex;
  readonly lastBlock: number;
}

/** A full policy row as stored (id is the on-chain policyId as a decimal string; uint256). */
export interface StoredPolicy {
  readonly id: string;
  readonly owner: Address;
  readonly agentId: Address;
  readonly version: number;
  readonly status: StoredPolicyStatus;
  readonly policyHash: Hex;
  /** on-chain expiry, unix seconds (uint64). */
  readonly expiry: number;
  readonly onchainRef: OnchainRef;
  readonly rules: PolicyRules;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Result of a create — the shape the create_spend_policy tool returns (§11: policyId, hash, tx). */
export interface CreatePolicyResult {
  readonly policyId: string;
  readonly policyHash: Hex;
  readonly txHash: Hex;
  readonly blockNumber: number;
  readonly version: number;
  readonly agentId: Address;
  readonly owner: Address;
  readonly expiry: number;
}

/** Result of an update — new hash + version + tx. */
export interface UpdatePolicyResult {
  readonly policyId: string;
  readonly policyHash: Hex;
  readonly txHash: Hex;
  readonly blockNumber: number;
  readonly version: number;
  readonly expiry: number;
}

/** Result of a pause — tx that flipped status. */
export interface PausePolicyResult {
  readonly policyId: string;
  readonly status: StoredPolicyStatus;
  readonly txHash: Hex;
  readonly blockNumber: number;
}
