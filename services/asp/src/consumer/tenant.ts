/**
 * The tenant identity, and the only place that knows it.
 *
 * A Consumer tenant IS a policy partition: `policy:<policyId>`. That formula existed in three places
 * before this module — `auth.ts`, `handlers.ts` and, inverted, `operator-intent-plan.ts` — each with a
 * comment asserting the others were identical. They were, which is exactly why the duplication was
 * dangerous: nothing would have failed if one had drifted, and the failure it would eventually produce
 * is a caller reading another tenant's intents because two functions disagreed about what a tenant is.
 *
 * This module has NO imports. That is a requirement rather than a happy accident: the remote proof
 * controller derives its tenant from the canonical helper instead of re-typing the formula, and the
 * controller is only trustworthy if importing it cannot drag in a store, a signer or a rail client.
 */

/** The wire form a tenant must take. Permissive in the id so a non-numeric partition stays expressible. */
export const TENANT_PATTERN = /^policy:([A-Za-z0-9._:-]{1,80})$/;

/**
 * An on-chain PolicyRegistry id: a uint256 rendered as a decimal string.
 *
 * Separate from `TENANT_PATTERN` on purpose. The tenant format is a namespacing rule and may hold
 * whatever a partition is called; a policy that a production intent will actually be evaluated
 * against has to be one the registry anchored, and those are always numeric. A caller passing
 * `policy:proof-tenant` should get a clear refusal rather than a `POLICY_NOT_FOUND` twenty lines later.
 */
export const ONCHAIN_POLICY_ID_PATTERN = /^[0-9]{1,78}$/;

export function tenantForPolicy(policyId: string): string {
  return `policy:${policyId}`;
}

/** The inverse. `null` when the string is not a tenant at all — never a guess at what was meant. */
export function policyIdForTenant(tenantId: string): string | null {
  return TENANT_PATTERN.exec(tenantId)?.[1] ?? null;
}

export function isOnchainPolicyId(policyId: string): boolean {
  return ONCHAIN_POLICY_ID_PATTERN.test(policyId);
}
