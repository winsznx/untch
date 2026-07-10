import type { Hex } from "viem";
import { MissingEnvError } from "./config";

/**
 * The real, durable demo policy the buyer-side proof scripts bind their intents to. Since the fixture
 * policy was removed, an intent must commit to a policy that actually exists in the store: create /
 * preflight now require a `policyId` and enforce that the intent's `policyHash` equals that stored
 * policy's hash. These come from a real create_spend_policy run (see run-policy-e2e-proof.ts, which
 * prints and records them) — supplied to the proof scripts via env so no fixture is reintroduced.
 *
 * DEMO_POLICY_ID   — uint256 decimal string (the on-chain-derived policyId).
 * DEMO_POLICY_HASH — 0x-prefixed 32-byte canonical ruleset hash of that policy.
 */
export interface DemoPolicyRef {
  readonly policyId: string;
  readonly policyHash: Hex;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") throw new MissingEnvError(name);
  return v.trim();
}

export function loadDemoPolicyRef(): DemoPolicyRef {
  const policyId = requireEnv("DEMO_POLICY_ID");
  if (!/^[0-9]+$/.test(policyId)) {
    throw new Error(`DEMO_POLICY_ID must be a uint256 decimal string, got ${JSON.stringify(policyId)}`);
  }
  const policyHash = requireEnv("DEMO_POLICY_HASH");
  if (!/^0x[0-9a-fA-F]{64}$/.test(policyHash)) {
    throw new Error("DEMO_POLICY_HASH must be a 0x-prefixed 32-byte hex string");
  }
  return { policyId, policyHash: policyHash.toLowerCase() as Hex };
}
