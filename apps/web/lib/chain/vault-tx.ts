import type { Address } from "viem";
import { ERC20_ABI, VAULT_ABI, VAULT_FACTORY, VAULT_FACTORY_ABI } from "./contracts";

/**
 * Pure UntchVault / UntchVaultFactory write builders — the operator's OWN direct wallet actions
 * (deploy / deposit / withdraw / pause). These are Mode A/B usable on their own; the Mode C
 * always-on oracle-signing service (automated day-to-day spend signing) is deliberately out of scope
 * here — nothing below signs a `spend()`. Each builder returns the exact viem `writeContract` request;
 * the connected owner wallet signs it.
 *
 * Amounts are in the token's BASE units (the ERC-20's smallest unit) — the caller converts display
 * units with the token decimals it read on-chain. Vault caps/budgets are likewise base units.
 */

export interface VaultWriteRequest {
  readonly address: Address;
  readonly abi: typeof VAULT_ABI | typeof VAULT_FACTORY_ABI | typeof ERC20_ABI;
  readonly functionName: string;
  readonly args: readonly unknown[];
}

/**
 * deployVault(...) — the operator deploys their own per-agent vault. Defaults mirror the demo vault's
 * real on-chain parameters (factory deploy receipt): the caller MUST be `owner` (the contract enforces
 * OwnerMustBeSender), so the UI passes the connected address as owner.
 */
export function buildDeployVault(params: {
  owner: Address;
  agent: Address;
  oracle: Address;
  perTxCap: bigint;
  epochBudget: bigint;
  epochLenSecs: bigint;
  tokenAllow: readonly Address[];
  requireAnchoredIntent: boolean;
}): VaultWriteRequest {
  return {
    address: VAULT_FACTORY,
    abi: VAULT_FACTORY_ABI,
    functionName: "deployVault",
    args: [
      params.owner,
      params.agent,
      params.oracle,
      params.perTxCap,
      params.epochBudget,
      params.epochLenSecs,
      [...params.tokenAllow],
      params.requireAnchoredIntent,
    ],
  };
}

/** computeVaultAddress(...) read request — the deterministic address a deployVault with these params lands at. */
export function buildComputeVaultAddress(params: {
  owner: Address;
  agent: Address;
  oracle: Address;
  perTxCap: bigint;
  epochBudget: bigint;
  epochLenSecs: bigint;
  tokenAllow: readonly Address[];
  requireAnchoredIntent: boolean;
}): VaultWriteRequest {
  return {
    address: VAULT_FACTORY,
    abi: VAULT_FACTORY_ABI,
    functionName: "computeVaultAddress",
    args: [
      params.owner,
      params.agent,
      params.oracle,
      params.perTxCap,
      params.epochBudget,
      params.epochLenSecs,
      [...params.tokenAllow],
      params.requireAnchoredIntent,
    ],
  };
}

/** ERC-20 approve(vault, amount) — the deposit prerequisite when allowance is short. */
export function buildApprove(token: Address, vault: Address, amount: bigint): VaultWriteRequest {
  return { address: token, abi: ERC20_ABI, functionName: "approve", args: [vault, amount] };
}

/** vault.deposit(token, amount) — fund the vault. Requires a prior approve covering `amount`. */
export function buildDeposit(vault: Address, token: Address, amount: bigint): VaultWriteRequest {
  return { address: vault, abi: VAULT_ABI, functionName: "deposit", args: [token, amount] };
}

/**
 * vault.ownerWithdraw(token, to, amount) — the I4 sovereignty path: unconditional, needs nothing from
 * Untch's oracle key. The owner pulls funds back to any address they choose.
 */
export function buildOwnerWithdraw(vault: Address, token: Address, to: Address, amount: bigint): VaultWriteRequest {
  return { address: vault, abi: VAULT_ABI, functionName: "ownerWithdraw", args: [token, to, amount] };
}

/** vault.pause() / vault.unpause() — pause blocks oracle spends; owner withdraw still works while paused (I4). */
export function buildVaultPause(vault: Address, paused: boolean): VaultWriteRequest {
  return { address: vault, abi: VAULT_ABI, functionName: paused ? "unpause" : "pause", args: [] };
}
