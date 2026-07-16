import { getAddress, type Address } from "viem";
import {
  contractsForChain,
  resolveChainId,
  settlementToken,
  X_LAYER_MAINNET_ID,
  X_LAYER_TESTNET_ID,
} from "@untch/shared";

/**
 * Real deployed contract addresses + the exact ABI fragments the dashboard writes against.
 *
 * The four base addresses are resolved PER NETWORK from CONTRACTS_BY_CHAIN, selected by
 * NEXT_PUBLIC_CHAIN_ID (inlined at build; unset ⇒ mainnet 196). Testnet via NEXT_PUBLIC_CHAIN_ID=1952.
 */

const ACTIVE_CHAIN_ID = resolveChainId({ CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID }, X_LAYER_MAINNET_ID);
const CONTRACTS = contractsForChain(ACTIVE_CHAIN_ID);

export const ACTIVE_PRODUCT_CHAIN_ID = ACTIVE_CHAIN_ID;
export const POLICY_REGISTRY: Address = getAddress(CONTRACTS.policyRegistry);
export const VAULT_FACTORY: Address = getAddress(CONTRACTS.vaultFactory);
export const INTENT_REGISTRY: Address = getAddress(CONTRACTS.spendIntentRegistry);
export const RECEIPTS: Address = getAddress(CONTRACTS.receipts);

/** Testnet demo vault + mock ERC-20 (only meaningful on chain 1952). */
export const DEMO_VAULT_TESTNET: Address = "0x42e699ffd8215d48397a049b4f7a176db06f4848";
export const VAULT_TOKEN_TESTNET: Address = "0xf202ce41d76ee1a2aec72e7a9180331d437ddd41";

/** Demo vault surface — null on mainnet (operators deploy via factory). */
export const DEMO_VAULT: Address | null =
  ACTIVE_CHAIN_ID === X_LAYER_TESTNET_ID ? DEMO_VAULT_TESTNET : null;

/** Settlement / vault token for the product chain. */
export const VAULT_TOKEN: Address =
  ACTIVE_CHAIN_ID === X_LAYER_TESTNET_ID
    ? VAULT_TOKEN_TESTNET
    : getAddress(settlementToken(ACTIVE_CHAIN_ID).address);

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
