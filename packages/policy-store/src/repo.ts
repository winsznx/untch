import type { Policy } from "@untch/policy-engine";
import type { OnchainRef, StoredPolicy, StoredPolicyStatus } from "./types";

/**
 * The durable policy store, behind an interface so the service + provider are tested with an in-memory
 * fake and no Postgres. Every write mirrors a confirmed on-chain state change (the caller passes the
 * fresh `onchain_ref`), so a row and its chain anchor move together.
 */
export interface PolicyRepo {
  /** Insert a freshly-registered policy. Its `id` is the on-chain policyId (uint256 decimal string). */
  insert(policy: StoredPolicy): Promise<void>;
  /** Read one policy by its on-chain policyId; null if absent. */
  getById(policyId: string): Promise<StoredPolicy | null>;
  /** Sync a confirmed updatePolicy: new hash, rules, version, expiry, and the tx that produced them. */
  updateRuleset(args: {
    policyId: string;
    policyHash: string;
    rules: StoredPolicy["rules"];
    version: number;
    expiry: number;
    onchainRef: OnchainRef;
  }): Promise<void>;
  /** Sync a confirmed pause/resume: new status + the tx that produced it. */
  setStatus(args: {
    policyId: string;
    status: StoredPolicyStatus;
    version: number;
    onchainRef: OnchainRef;
  }): Promise<void>;
  /** All policies governing an agent, newest first. */
  listByAgent(agentId: string): Promise<StoredPolicy[]>;
  /** All policies registered BY an operator wallet (the on-chain registrant / `owner`), newest first. */
  listByOwner(owner: string): Promise<StoredPolicy[]>;
}

/**
 * Map a stored policy to the engine's active-policy record. The stored {ACTIVE, PAUSED} status maps
 * straight through (both are valid engine statuses); the engine independently derives EXPIRED from
 * `rules.expiry`, so a PAUSED or expired policy fail-closes to BLOCKED_NO_ACTIVE_POLICY without this
 * layer having to pre-compute it.
 */
export function toEnginePolicy(stored: StoredPolicy): Policy {
  return {
    id: stored.id,
    version: stored.version,
    status: stored.status,
    rules: stored.rules,
    // Carried through so a decision names the exact ruleset bytes it judged, not only the row. This
    // is the value the chain anchored; the engine never recomputes it, because a second answer could
    // disagree with the registry and there would be no way to tell which was right.
    policyHash: stored.policyHash,
  };
}
