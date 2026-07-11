import type { Address } from "viem";

/**
 * Real deployed contract addresses + the exact ABI fragments the dashboard writes against.
 *
 * Addresses are the genuine X Layer testnet deployments from this build's history (see
 * contracts/deploy/*-testnet-receipt.json and lib/onchain.ts). The ABIs are transcribed verbatim
 * from the Foundry-compiled artifacts (contracts/out/**), narrowed to only the functions/events the
 * UI calls — same bytes the deploy scripts used, so a write built here is the same call that verified.
 */

export const POLICY_REGISTRY: Address = "0xe1d74c90801db0fa806c72eb818b7671b8233532";
export const VAULT_FACTORY: Address = "0x1562c6eb1813016c8562cf6771cbf715007bb7e9";
export const INTENT_REGISTRY: Address = "0xf87e50f83172c2dace7d274e4c701212caeb1372";
/** The demo UntchVault instance (real spend + withdraw tx history on its address page). */
export const DEMO_VAULT: Address = "0x42e699ffd8215d48397a049b4f7a176db06f4848";
/** The testnet ERC-20 the demo vault allows (from the factory deploy receipt). */
export const VAULT_TOKEN: Address = "0xf202ce41d76ee1a2aec72e7a9180331d437ddd41";

export const POLICY_REGISTRY_ABI = [
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
    name: "nextPolicyId",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerNonce",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
  {
    type: "function",
    name: "isUsable",
    stateMutability: "view",
    inputs: [{ name: "policyId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getPolicy",
    stateMutability: "view",
    inputs: [{ name: "policyId", type: "uint256" }],
    outputs: [
      {
        name: "",
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
  {
    type: "event",
    name: "PolicyUpdated",
    inputs: [
      { name: "policyId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "newPolicyHash", type: "bytes32", indexed: true },
      { name: "previousPolicyHash", type: "bytes32", indexed: false },
      { name: "newExpiry", type: "uint64", indexed: false },
      { name: "version", type: "uint32", indexed: false },
    ],
  },
] as const;

export const VAULT_FACTORY_ABI = [
  {
    type: "function",
    name: "deployVault",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "agent", type: "address" },
      { name: "oracle", type: "address" },
      { name: "perTxCap", type: "uint256" },
      { name: "epochBudget", type: "uint256" },
      { name: "epochLenSecs", type: "uint64" },
      { name: "tokenAllow", type: "address[]" },
      { name: "requireAnchoredIntent", type: "bool" },
    ],
    outputs: [{ name: "vault", type: "address" }],
  },
  {
    type: "function",
    name: "computeVaultAddress",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "agent", type: "address" },
      { name: "oracle", type: "address" },
      { name: "perTxCap", type: "uint256" },
      { name: "epochBudget", type: "uint256" },
      { name: "epochLenSecs", type: "uint64" },
      { name: "tokenAllow", type: "address[]" },
      { name: "requireAnchoredIntent", type: "bool" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "VaultDeployed",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "vault", type: "address", indexed: true },
      { name: "oracle", type: "address", indexed: false },
      { name: "requireAnchoredIntent", type: "bool", indexed: false },
    ],
  },
] as const;

export const VAULT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "ownerWithdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "unpause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "epochSpent",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "epochBudget",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** The two ERC-20 calls a vault deposit needs: allowance check + approve. */
export const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
