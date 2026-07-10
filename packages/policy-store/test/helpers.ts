import { encodePacked, getAddress, keccak256, type Address, type Hex } from "viem";
import type { MutateResult, OnchainPolicy, PolicyRegistryChain, RegisterResult } from "../src/registry";

/**
 * A fake PolicyRegistry that reproduces the REAL contract's observable behaviour with no RPC:
 *   • policyId = uint256(keccak256(abi.encodePacked(owner, ownerNonce))) — the exact §10.1 derivation,
 *     so tests can assert the stored id IS the on-chain-derived value (not an off-chain counter).
 *   • per-owner nonce increments once per register.
 *   • owner-gating: a policyId in `notOwned` reverts like NotPolicyOwner.
 *   • pause reverts (PolicyNotActive) when already paused; resume reverts when not paused.
 */
export function derivePolicyId(owner: Address, nonce: bigint): bigint {
  return BigInt(keccak256(encodePacked(["address", "uint256"], [getAddress(owner), nonce])));
}

interface OnchainRow {
  policyHash: Hex;
  expiry: bigint;
  version: number;
  status: number; // 1 ACTIVE | 2 PAUSED
  owner: Address;
  agent: Address;
}

export class FakeChain implements PolicyRegistryChain {
  readonly ownerAddress: Address;
  readonly registryAddress: Address = getAddress("0xe1d74c90801db0fa806c72eb818b7671b8233532");
  readonly chainId = 1952;
  private nonce = 0n;
  private block = 100;
  private readonly rows = new Map<string, OnchainRow>();
  /** policyIds this operator does NOT own — mutating them reverts NotPolicyOwner. */
  readonly notOwned = new Set<string>();

  constructor(owner: Address = getAddress("0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b")) {
    this.ownerAddress = getAddress(owner);
  }

  private tx(tag: string): Hex {
    return keccak256(encodePacked(["string", "uint256"], [tag, BigInt(this.block)]));
  }

  async nextPolicyId(): Promise<bigint> {
    return derivePolicyId(this.ownerAddress, this.nonce);
  }

  async register(agent: Address, policyHash: Hex, expiry: bigint): Promise<RegisterResult> {
    const id = derivePolicyId(this.ownerAddress, this.nonce);
    this.nonce += 1n;
    this.block += 1;
    this.rows.set(id.toString(), {
      policyHash,
      expiry,
      version: 1,
      status: 1,
      owner: this.ownerAddress,
      agent: getAddress(agent),
    });
    return { policyId: id, txHash: this.tx(`register:${id}`), blockNumber: this.block, version: 1 };
  }

  private owned(policyId: bigint): OnchainRow {
    const key = policyId.toString();
    if (this.notOwned.has(key)) throw new Error(`NotPolicyOwner(${key})`);
    const row = this.rows.get(key);
    if (!row) throw new Error(`PolicyNotFound(${key})`);
    return row;
  }

  async update(policyId: bigint, newPolicyHash: Hex, newExpiry: bigint): Promise<MutateResult> {
    const row = this.owned(policyId);
    row.policyHash = newPolicyHash;
    row.expiry = newExpiry;
    row.version += 1;
    this.block += 1;
    return { txHash: this.tx(`update:${policyId}`), blockNumber: this.block, version: row.version };
  }

  async pause(policyId: bigint): Promise<MutateResult> {
    const row = this.owned(policyId);
    if (row.status !== 1) throw new Error(`PolicyNotActive(${policyId})`);
    row.status = 2;
    this.block += 1;
    return { txHash: this.tx(`pause:${policyId}`), blockNumber: this.block, version: row.version };
  }

  async resume(policyId: bigint): Promise<MutateResult> {
    const row = this.owned(policyId);
    if (row.status !== 2) throw new Error(`PolicyNotPaused(${policyId})`);
    row.status = 1;
    this.block += 1;
    return { txHash: this.tx(`resume:${policyId}`), blockNumber: this.block, version: row.version };
  }

  async getPolicy(policyId: bigint): Promise<OnchainPolicy> {
    const row = this.owned(policyId);
    return {
      owner: row.owner,
      agent: row.agent,
      policyHash: row.policyHash,
      status: row.status,
      expiry: row.expiry,
      version: row.version,
    };
  }
}

/** A valid §8-shaped ruleset with overridable fields — the baseline the tests mutate. */
export function sampleRules(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    budgets: { daily: 25, token: "USDT" },
    perCallCap: 1.0,
    onPerCallCapExceeded: "ESCALATE",
    escalateAbove: 5.0,
    categories: { allow: ["market-data", "security", "research"], deny: [] },
    recipients: { allow: [], deny: [] },
    agents: { allowWorkerIds: [], denyWorkerIds: [] },
    duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
    cooldowns: { sameServiceMin: 5 },
    rateLimit: { callsPerHour: 40 },
    expiry: "2026-12-31T00:00:00Z",
    ...overrides,
  };
}
