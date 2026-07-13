import { hashCanonicalJson } from "@untch/canon";
import type { Address } from "viem";
import { getAddress } from "viem";
import type { PolicyRegistryChain } from "./registry";
import type { PolicyRepo } from "./repo";
import { parsePolicyRules } from "./rules";
import type {
  CreatePolicyResult,
  OnchainRef,
  PausePolicyResult,
  StoredPolicy,
  UpdatePolicyResult,
} from "./types";

/**
 * The policy CRUD service (PRD §6.2 / §8 / §10.1). It ties three real subsystems together for each
 * mutation and keeps them consistent:
 *   1. @untch/canon  — canonicalize + hash the ruleset (Surface A). REUSED, never reimplemented.
 *   2. PolicyRegistry — the real on-chain register/update/pause/resume (a real testnet tx each).
 *   3. Postgres      — the durable row, SYNCED from what the chain confirmed (written after the tx).
 *
 * policyId consistency (task "POLICY ID CONSISTENCY"): `id` is the on-chain-derived
 * uint256(keccak256(abi.encodePacked(owner, ownerNonce))). It is read from the confirmed
 * PolicyRegistered event (the chain assigns it from the LIVE nonce), never an off-chain counter — so
 * the Postgres id and the on-chain id are the same value and cannot drift.
 */
export class PolicyNotFoundError extends Error {
  constructor(public readonly policyId: string) {
    super(`policy ${policyId} not found in the store`);
    this.name = "PolicyNotFoundError";
  }
}

function expiryUnixFromRules(expiryIso: string): number {
  const ms = Date.parse(expiryIso);
  if (Number.isNaN(ms)) throw new Error(`rules.expiry is not a parseable instant: ${expiryIso}`);
  return Math.floor(ms / 1000);
}

export interface CreatePolicyArgs {
  readonly agent: Address;
  readonly rules: unknown;
}

export interface UpdatePolicyArgs {
  readonly policyId: string;
  readonly rules: unknown;
}

export class PolicyService {
  constructor(
    private readonly repo: PolicyRepo,
    private readonly chain: PolicyRegistryChain,
  ) {}

  /** The operator identity that signs on-chain (the interim demo wallet, see README). */
  get operatorAddress(): Address {
    return this.chain.ownerAddress;
  }

  async createPolicy(args: CreatePolicyArgs): Promise<CreatePolicyResult> {
    const rules = parsePolicyRules(args.rules); // throws PolicyValidationError on a bad ruleset
    const agent = getAddress(args.agent);
    const policyHash = hashCanonicalJson(rules as unknown as Record<string, unknown>);
    const expiry = expiryUnixFromRules(rules.expiry);

    const reg = await this.chain.register(agent, policyHash, BigInt(expiry));

    const owner = this.chain.ownerAddress;
    const onchainRef: OnchainRef = {
      chainId: this.chain.chainId,
      registry: this.chain.registryAddress,
      registerTx: reg.txHash,
      registerBlock: reg.blockNumber,
      lastTx: reg.txHash,
      lastBlock: reg.blockNumber,
    };
    const nowIso = new Date().toISOString();
    const stored: StoredPolicy = {
      id: reg.policyId.toString(),
      owner,
      agentId: agent,
      version: reg.version,
      status: "ACTIVE",
      policyHash,
      expiry,
      onchainRef,
      rules,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.repo.insert(stored);

    return {
      policyId: stored.id,
      policyHash,
      txHash: reg.txHash,
      blockNumber: reg.blockNumber,
      version: reg.version,
      agentId: agent,
      owner,
      expiry,
    };
  }

  async updatePolicy(args: UpdatePolicyArgs): Promise<UpdatePolicyResult> {
    const existing = await this.repo.getById(args.policyId);
    if (!existing) throw new PolicyNotFoundError(args.policyId);

    const rules = parsePolicyRules(args.rules);
    const policyHash = hashCanonicalJson(rules as unknown as Record<string, unknown>);
    const expiry = expiryUnixFromRules(rules.expiry);

    const res = await this.chain.update(BigInt(args.policyId), policyHash, BigInt(expiry));

    const onchainRef: OnchainRef = {
      ...existing.onchainRef,
      lastTx: res.txHash,
      lastBlock: res.blockNumber,
    };
    await this.repo.updateRuleset({
      policyId: args.policyId,
      policyHash,
      rules,
      version: res.version,
      expiry,
      onchainRef,
    });

    return {
      policyId: args.policyId,
      policyHash,
      txHash: res.txHash,
      blockNumber: res.blockNumber,
      version: res.version,
      expiry,
    };
  }

  async pausePolicy(policyId: string): Promise<PausePolicyResult> {
    return this.setStatus(policyId, "pause");
  }

  async resumePolicy(policyId: string): Promise<PausePolicyResult> {
    return this.setStatus(policyId, "resume");
  }

  private async setStatus(policyId: string, op: "pause" | "resume"): Promise<PausePolicyResult> {
    const existing = await this.repo.getById(policyId);
    if (!existing) throw new PolicyNotFoundError(policyId);

    const res =
      op === "pause"
        ? await this.chain.pause(BigInt(policyId))
        : await this.chain.resume(BigInt(policyId));

    const status = op === "pause" ? "PAUSED" : "ACTIVE";
    const onchainRef: OnchainRef = {
      ...existing.onchainRef,
      lastTx: res.txHash,
      lastBlock: res.blockNumber,
    };
    await this.repo.setStatus({ policyId, status, version: res.version, onchainRef });

    return { policyId, status, txHash: res.txHash, blockNumber: res.blockNumber };
  }
}
