import type { Policy } from "@untch/policy-engine";
import type { PolicyRepo } from "./repo";
import { toEnginePolicy } from "./repo";
import type { StoredPolicy } from "./types";

/**
 * Read-only policy source for preflight (§7.1). Given a policyId it loads the durable stored policy
 * and hands the engine its active-policy record. This is the ONLY thing preflight_payment needs from
 * the store — it never signs or mutates. A missing id resolves to `null`, which the engine turns into
 * BLOCKED_NO_ACTIVE_POLICY (fail-closed, I2), so an unknown policy is a safe block, not an error.
 */
export class PolicyProvider {
  constructor(private readonly repo: PolicyRepo) {}

  /** The engine's active-policy record for `policyId`, or null if no such policy is stored. */
  async load(policyId: string): Promise<Policy | null> {
    const stored = await this.repo.getById(policyId);
    return stored ? toEnginePolicy(stored) : null;
  }

  /** The full stored record (hash, onchain_ref, owner …) — for callers that need more than the engine slice. */
  async loadStored(policyId: string): Promise<StoredPolicy | null> {
    return this.repo.getById(policyId);
  }
}
