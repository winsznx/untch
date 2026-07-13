import { hashCanonicalJson } from "@untch/canon";
import type { Address, Hex } from "viem";
import { POLICY_REGISTRY, POLICY_REGISTRY_ABI } from "./contracts";

/**
 * Pure PolicyRegistry write builders — the SINGLE transaction-construction path shared by the
 * dashboard's "Create / Update / Pause" buttons and the headless on-chain proof harness.
 *
 * These functions hold NO wallet and touch NO browser API: each returns the exact viem
 * `writeContract` request (address + abi + functionName + args) plus the canonical policy hash.
 * The UI hands the request to a wallet client backed by the connected OKX Wallet; the proof harness
 * hands the identical request to a viem account. Same bytes either way — which is what lets the proof
 * genuinely exercise the UI's real code path rather than a parallel script.
 *
 * The policy hash comes from `@untch/canon` `hashCanonicalJson` — the SAME canonical-JSON surface the
 * ASP preflight and the deploy scripts use, so the ruleset the MCP server enforces and the ruleset
 * committed on-chain are provably the same bytes (§9 / §10.1).
 */

/** The §8 policy ruleset the operator edits and commits. Hashed verbatim through canon Surface A. */
export interface PolicyRules {
  budgets: { daily: number; token: string };
  perCallCap: number;
  onPerCallCapExceeded: "BLOCK" | "ESCALATE";
  escalateAbove: number;
  categories: { allow: string[]; deny: string[] };
  recipients: { allow: string[]; deny: string[] };
  agents: { allowWorkerIds: string[]; denyWorkerIds: string[] };
  duplicates: { ttlMin: number; keys: string[] };
  cooldowns: { sameServiceMin: number };
  rateLimit: { callsPerHour: number };
  expiry: string;
}

export interface WriteRequest {
  readonly address: Address;
  readonly abi: typeof POLICY_REGISTRY_ABI;
  readonly functionName: "registerPolicy" | "updatePolicy" | "pausePolicy" | "resumePolicy";
  readonly args: readonly unknown[];
}

/** The canonical policy hash — the value anchored on-chain and matched against the MCP-enforced rules. */
export function computePolicyHash(rules: PolicyRules): Hex {
  return hashCanonicalJson(rules as unknown as Record<string, unknown>) as Hex;
}

/** Convert the policy's ISO expiry to the uint64 unix seconds the registry stores. */
export function expiryToUnix(rules: PolicyRules): bigint {
  const ms = Date.parse(rules.expiry);
  if (!Number.isFinite(ms)) throw new Error(`policy.expiry is not a valid date: ${rules.expiry}`);
  return BigInt(Math.floor(ms / 1000));
}

export interface RegisterPolicyResult {
  readonly request: WriteRequest;
  readonly policyHash: Hex;
}

/** registerPolicy(agent, policyHash, expiry) — commit a brand-new ruleset for an agent. */
export function buildRegisterPolicy(params: { agent: Address; rules: PolicyRules }): RegisterPolicyResult {
  const policyHash = computePolicyHash(params.rules);
  return {
    policyHash,
    request: {
      address: POLICY_REGISTRY,
      abi: POLICY_REGISTRY_ABI,
      functionName: "registerPolicy",
      args: [params.agent, policyHash, expiryToUnix(params.rules)],
    },
  };
}

/** updatePolicy(policyId, newPolicyHash, newExpiry) — commit an edited ruleset; bumps version on-chain. */
export function buildUpdatePolicy(params: { policyId: bigint; rules: PolicyRules }): RegisterPolicyResult {
  const policyHash = computePolicyHash(params.rules);
  return {
    policyHash,
    request: {
      address: POLICY_REGISTRY,
      abi: POLICY_REGISTRY_ABI,
      functionName: "updatePolicy",
      args: [params.policyId, policyHash, expiryToUnix(params.rules)],
    },
  };
}

/** pausePolicy(policyId) — one-click stop; the agent's preflights fail closed while paused (I2). */
export function buildPausePolicy(policyId: bigint): WriteRequest {
  return { address: POLICY_REGISTRY, abi: POLICY_REGISTRY_ABI, functionName: "pausePolicy", args: [policyId] };
}

/** resumePolicy(policyId) — lift a pause. */
export function buildResumePolicy(policyId: bigint): WriteRequest {
  return { address: POLICY_REGISTRY, abi: POLICY_REGISTRY_ABI, functionName: "resumePolicy", args: [policyId] };
}
