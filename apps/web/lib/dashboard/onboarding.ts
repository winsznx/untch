import type { Address } from "viem";
import { POLICY_REGISTRY, POLICY_REGISTRY_ABI } from "../chain/contracts";
import { makePublicClient } from "../wallet/provider";

/**
 * First-time detection for the onboarding path (Step-31 #1).
 *
 * The dashboard's seeded history is scoped to the demo operator, so a brand-new wallet has no off-chain
 * record. The honest "has this wallet set anything up" signal is on-chain: PolicyRegistry.ownerNonce
 * starts at 0 and increments once per registered policy, independently per owner (proven in
 * contracts/test/PolicyRegistry.t.sol::test_RegisterPolicy_IncrementsOwnerNonce). So a wallet with
 * ownerNonce 0 has never registered a policy and is a first-time operator.
 */
export async function readOwnerNonce(address: Address): Promise<bigint> {
  return (await makePublicClient().readContract({
    address: POLICY_REGISTRY,
    abi: POLICY_REGISTRY_ABI,
    functionName: "ownerNonce",
    args: [address],
  })) as bigint;
}

/** True once the wallet owns at least one on-chain policy (i.e. is no longer a first-time operator). */
export async function hasAnyPolicy(address: Address): Promise<boolean> {
  try {
    return (await readOwnerNonce(address)) > 0n;
  } catch {
    // An RPC hiccup must never trap a real operator on the onboarding path; treat as "unknown, not first
    // time" so we fall through to the normal dashboard rather than looping them into onboarding.
    return true;
  }
}
