import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * The PolicyRegistry (§10.1) chain surface, behind an interface so the service is unit-tested with a
 * fake and no RPC. Writes WAIT for their receipt and return {txHash, blockNumber} plus the state the
 * caller must sync to Postgres — registration additionally returns the on-chain-derived `policyId`,
 * read from the confirmed `PolicyRegistered` event (never the driver's own guess).
 *
 * Custody / trust posture (see README): the account here is the operator's OWN wallet. In this interim
 * build that is the demo/burner wallet 0x98F43e…, a TEMPORARY stand-in for the operator's dashboard-
 * connected wallet (§15). Only the tool-running instance ever holds this key; the read path
 * (`PolicyProvider` for preflight) never does.
 */
export interface OnchainPolicy {
  readonly owner: Address;
  readonly agent: Address;
  readonly policyHash: Hex;
  readonly status: number; // 0 NONE | 1 ACTIVE | 2 PAUSED
  readonly expiry: bigint;
  readonly version: number;
}

export interface RegisterResult {
  readonly policyId: bigint;
  readonly txHash: Hex;
  readonly blockNumber: number;
  readonly version: number;
}

export interface MutateResult {
  readonly txHash: Hex;
  readonly blockNumber: number;
  readonly version: number;
}

export interface PolicyRegistryChain {
  readonly ownerAddress: Address;
  readonly registryAddress: Address;
  readonly chainId: number;
  /** The policyId the owner's NEXT registration will produce (contract-derived from the live nonce). */
  nextPolicyId(): Promise<bigint>;
  register(agent: Address, policyHash: Hex, expiry: bigint): Promise<RegisterResult>;
  update(policyId: bigint, newPolicyHash: Hex, newExpiry: bigint): Promise<MutateResult>;
  pause(policyId: bigint): Promise<MutateResult>;
  resume(policyId: bigint): Promise<MutateResult>;
  getPolicy(policyId: bigint): Promise<OnchainPolicy>;
}

/** The subset of PolicyRegistry's ABI this store drives. Names match the deployed contract exactly. */
export const POLICY_REGISTRY_ABI = [
  {
    type: "function",
    name: "nextPolicyId",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "registerPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      { name: "policyHash", type: "bytes32" },
      { name: "expiry", type: "uint64" },
    ],
    outputs: [{ name: "policyId", type: "uint256" }],
  },
  {
    type: "function",
    name: "updatePolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "policyId", type: "uint256" },
      { name: "newPolicyHash", type: "bytes32" },
      { name: "newExpiry", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "pausePolicy",
    stateMutability: "nonpayable",
    inputs: [{ name: "policyId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "resumePolicy",
    stateMutability: "nonpayable",
    inputs: [{ name: "policyId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getPolicy",
    stateMutability: "view",
    inputs: [{ name: "policyId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "expiry", type: "uint64" },
          { name: "version", type: "uint32" },
          { name: "agent", type: "address" },
          { name: "status", type: "uint8" },
          { name: "policyHash", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "PolicyRegistered",
    inputs: [
      { name: "policyId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "policyHash", type: "bytes32", indexed: false },
      { name: "expiry", type: "uint64", indexed: false },
      { name: "version", type: "uint32", indexed: false },
    ],
  },
] as const satisfies Abi;

export interface ViemPolicyRegistryOptions {
  readonly chain: Chain;
  readonly rpcUrl: string;
  readonly registry: Address;
  readonly operatorPrivateKey: Hex;
}

export class ViemPolicyRegistry implements PolicyRegistryChain {
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  private readonly account: Account;
  private readonly chain: Chain;
  readonly registryAddress: Address;
  readonly chainId: number;

  constructor(opts: ViemPolicyRegistryOptions) {
    this.account = privateKeyToAccount(opts.operatorPrivateKey);
    this.chain = opts.chain;
    this.chainId = opts.chain.id;
    this.registryAddress = getAddress(opts.registry);
    this.pub = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
    this.wallet = createWalletClient({
      account: this.account,
      chain: opts.chain,
      transport: http(opts.rpcUrl),
    });
  }

  get ownerAddress(): Address {
    return this.account.address;
  }

  async nextPolicyId(): Promise<bigint> {
    return (await this.pub.readContract({
      address: this.registryAddress,
      abi: POLICY_REGISTRY_ABI,
      functionName: "nextPolicyId",
      args: [this.account.address],
    })) as bigint;
  }

  async register(agent: Address, policyHash: Hex, expiry: bigint): Promise<RegisterResult> {
    // Predict from the LIVE on-chain nonce, then register, then confirm the emitted id equals the
    // prediction — so Postgres binds to the id the chain actually assigned.
    const predicted = await this.nextPolicyId();
    const txHash = await this.wallet.writeContract({
      account: this.account,
      chain: this.chain,
      address: this.registryAddress,
      abi: POLICY_REGISTRY_ABI,
      functionName: "registerPolicy",
      args: [getAddress(agent), policyHash, expiry],
    });
    const rcpt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    if (rcpt.status !== "success") throw new Error(`registerPolicy reverted (tx ${txHash})`);

    let eventPolicyId: bigint | undefined;
    for (const log of rcpt.logs) {
      try {
        const ev = decodeEventLog({ abi: POLICY_REGISTRY_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === "PolicyRegistered") {
          eventPolicyId = (ev.args as unknown as { policyId: bigint }).policyId;
          break;
        }
      } catch {
        /* not our event */
      }
    }
    if (eventPolicyId === undefined) {
      throw new Error(`registerPolicy tx ${txHash} emitted no PolicyRegistered event`);
    }
    if (eventPolicyId !== predicted) {
      throw new Error(
        `policyId drift: predicted ${predicted} from nonce, chain assigned ${eventPolicyId}`,
      );
    }
    return { policyId: eventPolicyId, txHash, blockNumber: Number(rcpt.blockNumber), version: 1 };
  }

  async update(policyId: bigint, newPolicyHash: Hex, newExpiry: bigint): Promise<MutateResult> {
    const txHash = await this.wallet.writeContract({
      account: this.account,
      chain: this.chain,
      address: this.registryAddress,
      abi: POLICY_REGISTRY_ABI,
      functionName: "updatePolicy",
      args: [policyId, newPolicyHash, newExpiry],
    });
    const rcpt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    if (rcpt.status !== "success") throw new Error(`updatePolicy reverted (tx ${txHash})`);
    const after = await this.getPolicy(policyId);
    return { txHash, blockNumber: Number(rcpt.blockNumber), version: after.version };
  }

  async pause(policyId: bigint): Promise<MutateResult> {
    return this.mutateStatus(policyId, "pausePolicy");
  }

  async resume(policyId: bigint): Promise<MutateResult> {
    return this.mutateStatus(policyId, "resumePolicy");
  }

  private async mutateStatus(
    policyId: bigint,
    fn: "pausePolicy" | "resumePolicy",
  ): Promise<MutateResult> {
    const txHash = await this.wallet.writeContract({
      account: this.account,
      chain: this.chain,
      address: this.registryAddress,
      abi: POLICY_REGISTRY_ABI,
      functionName: fn,
      args: [policyId],
    });
    const rcpt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    if (rcpt.status !== "success") throw new Error(`${fn} reverted (tx ${txHash})`);
    const after = await this.getPolicy(policyId);
    return { txHash, blockNumber: Number(rcpt.blockNumber), version: after.version };
  }

  async getPolicy(policyId: bigint): Promise<OnchainPolicy> {
    const p = (await this.pub.readContract({
      address: this.registryAddress,
      abi: POLICY_REGISTRY_ABI,
      functionName: "getPolicy",
      args: [policyId],
    })) as {
      owner: Address;
      expiry: bigint;
      version: number;
      agent: Address;
      status: number;
      policyHash: Hex;
    };
    return {
      owner: getAddress(p.owner),
      agent: getAddress(p.agent),
      policyHash: p.policyHash,
      status: Number(p.status),
      expiry: p.expiry,
      version: Number(p.version),
    };
  }
}
