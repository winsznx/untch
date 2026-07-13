import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
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
 *
 * PER-CALLER OWNERSHIP (the `RegistryReader` split): `create_spend_policy` no longer signs on the
 * caller's behalf. It BUILDS the unsigned `registerPolicy` call (`buildRegister`) for the caller's own
 * wallet to sign + submit, then the backend SYNCS Postgres from what the chain actually confirmed
 * (`getRegistrationFromReceipt`) — so the stored `owner` is whatever address really submitted the tx,
 * read from the on-chain `PolicyRegistered` event, never assumed. Neither of those two operations needs
 * a private key, so `RegistryReader` is the key-free surface the create/sync path uses.
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

/** The unsigned `registerPolicy(agent, policyHash, expiry)` call — the exact viem write-request shape,
 *  plus the raw ABI-encoded `calldata`, so ANY wallet (browser or programmatic) can sign + submit it. */
export interface RegisterCall {
  readonly to: Address;
  readonly abi: typeof POLICY_REGISTRY_ABI;
  readonly functionName: "registerPolicy";
  readonly args: readonly [Address, Hex, bigint];
  readonly calldata: Hex;
  readonly chainId: number;
}

/** A confirmed on-chain registration, read back from the `PolicyRegistered` event of a submitted tx.
 *  `owner` is whatever address actually submitted — the ground truth the store syncs to, never assumed. */
export interface OnchainRegistration {
  readonly policyId: bigint;
  readonly owner: Address;
  readonly agent: Address;
  readonly policyHash: Hex;
  readonly expiry: bigint;
  readonly version: number;
  readonly txHash: Hex;
  readonly blockNumber: number;
}

/**
 * The KEY-FREE registry surface used by the per-caller create/sync path. `buildRegister` is pure (no
 * network, no key); `getRegistrationFromReceipt` only READS a confirmed tx over RPC. A read-only client
 * (`ViemRegistryReader`) implements exactly this, so `create_spend_policy` never needs a signing key.
 */
export interface RegistryReader {
  readonly registryAddress: Address;
  readonly chainId: number;
  /** Build the unsigned registerPolicy call for the caller's own wallet to sign + submit. */
  buildRegister(agent: Address, policyHash: Hex, expiry: bigint): RegisterCall;
  /** Read a confirmed registerPolicy tx and decode its `PolicyRegistered` event (owner = real submitter). */
  getRegistrationFromReceipt(txHash: Hex): Promise<OnchainRegistration>;
}

export interface PolicyRegistryChain extends RegistryReader {
  readonly ownerAddress: Address;
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

/** Pure builder for the unsigned registerPolicy call — shared by the read-only reader and the full client
 *  so the bytes a caller signs are the same regardless of which surface built them. */
function buildRegisterCall(
  registry: Address,
  chainId: number,
  agent: Address,
  policyHash: Hex,
  expiry: bigint,
): RegisterCall {
  const args = [getAddress(agent), policyHash, expiry] as const;
  return {
    to: registry,
    abi: POLICY_REGISTRY_ABI,
    functionName: "registerPolicy",
    args,
    calldata: encodeFunctionData({ abi: POLICY_REGISTRY_ABI, functionName: "registerPolicy", args }),
    chainId,
  };
}

/** Read a confirmed registerPolicy tx and pull the on-chain truth from its `PolicyRegistered` event.
 *  Only accepts an event emitted BY the configured registry, so a look-alike log cannot spoof a policy. */
async function readRegistration(
  pub: PublicClient,
  registry: Address,
  txHash: Hex,
): Promise<OnchainRegistration> {
  const rcpt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (rcpt.status !== "success") throw new Error(`registerPolicy tx reverted (tx ${txHash})`);

  for (const log of rcpt.logs) {
    if (getAddress(log.address) !== registry) continue; // must come from OUR registry
    try {
      const ev = decodeEventLog({ abi: POLICY_REGISTRY_ABI, data: log.data, topics: log.topics });
      if (ev.eventName !== "PolicyRegistered") continue;
      const a = ev.args as unknown as {
        policyId: bigint;
        owner: Address;
        agent: Address;
        policyHash: Hex;
        expiry: bigint;
        version: number;
      };
      return {
        policyId: a.policyId,
        owner: getAddress(a.owner),
        agent: getAddress(a.agent),
        policyHash: a.policyHash,
        expiry: a.expiry,
        version: Number(a.version),
        txHash,
        blockNumber: Number(rcpt.blockNumber),
      };
    } catch {
      /* not a PolicyRegistered log */
    }
  }
  throw new Error(`tx ${txHash} has no PolicyRegistered event from registry ${registry}`);
}

export interface ViemRegistryReaderOptions {
  readonly chain: Chain;
  readonly rpcUrl: string;
  readonly registry: Address;
}

/**
 * Key-free `RegistryReader` — the create/sync surface for `create_spend_policy`. Holds only a public
 * client: it can BUILD the unsigned registerPolicy call and READ a confirmed registration back, but it
 * cannot sign anything. This is what makes the backend structurally unable to register a policy on a
 * caller's behalf; the caller's own wallet is the only signer.
 */
export class ViemRegistryReader implements RegistryReader {
  private readonly pub: PublicClient;
  readonly registryAddress: Address;
  readonly chainId: number;

  constructor(opts: ViemRegistryReaderOptions) {
    this.chainId = opts.chain.id;
    this.registryAddress = getAddress(opts.registry);
    this.pub = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  }

  buildRegister(agent: Address, policyHash: Hex, expiry: bigint): RegisterCall {
    return buildRegisterCall(this.registryAddress, this.chainId, agent, policyHash, expiry);
  }

  getRegistrationFromReceipt(txHash: Hex): Promise<OnchainRegistration> {
    return readRegistration(this.pub, this.registryAddress, txHash);
  }
}

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

  buildRegister(agent: Address, policyHash: Hex, expiry: bigint): RegisterCall {
    return buildRegisterCall(this.registryAddress, this.chainId, agent, policyHash, expiry);
  }

  getRegistrationFromReceipt(txHash: Hex): Promise<OnchainRegistration> {
    return readRegistration(this.pub, this.registryAddress, txHash);
  }

  async nextPolicyId(): Promise<bigint> {
    return (await this.pub.readContract({
      address: this.registryAddress,
      abi: POLICY_REGISTRY_ABI,
      functionName: "nextPolicyId",
      args: [this.account.address],
    })) as bigint;
  }

  /**
   * LEGACY server-signing create path — the operator wallet self-signs a registerPolicy for its OWN
   * policy. The `create_spend_policy` TOOL no longer calls this (it builds unsigned calldata for the
   * caller's own wallet, see `PolicyRegistrationService`); it is retained ONLY for the single-owner
   * legacy proof. It can only ever produce a policy owned by THIS operator wallet — it never signs on
   * another caller's behalf.
   */
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
    const reg = await readRegistration(this.pub, this.registryAddress, txHash);
    if (reg.policyId !== predicted) {
      throw new Error(
        `policyId drift: predicted ${predicted} from nonce, chain assigned ${reg.policyId}`,
      );
    }
    return { policyId: reg.policyId, txHash, blockNumber: reg.blockNumber, version: 1 };
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
