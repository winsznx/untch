"use client";

import { createContext, useCallback, useContext } from "react";
import type { Abi, Address, Hex } from "viem";
import { useAccount, useSwitchChain, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import type { AuthenticationStatus } from "@rainbow-me/rainbowkit";
import { REQUIRED_CHAIN_ID } from "../../lib/wallet/network";
import { wagmiConfig } from "../../lib/wallet/wagmi";

/**
 * SIWE auth status, owned by <Providers> and fed both to RainbowKit and to this hook. RainbowKit does not
 * publicly export a status hook, so we mirror the same value we already pass to its provider.
 */
export const AuthStatusContext = createContext<AuthenticationStatus>("loading");
export function useAuthStatus(): AuthenticationStatus {
  return useContext(AuthStatusContext);
}

/**
 * `useWallet` — the small, stable surface the write components consume (tx-button, policy-actions,
 * vault-actions) plus the escalation/binding controls. It is now backed by wagmi + RainbowKit rather than a
 * hand-rolled EIP-1193 flow: connect + SIWE sign-in are handled by RainbowKit's modal (see providers.tsx),
 * so this hook only exposes connection status, the signed-in address, and the two things the writes need —
 * a fresh-signed `writeContract` and a `waitForReceipt`. Each write ensures the wallet is on the
 * product chain (mainnet by default) first, then asks the connected wallet to sign.
 */

export type WalletStatus = "disconnected" | "connected" | "authenticated";

/** A contract call any builder in lib/chain produces — address + abi + function + args. */
export interface ContractCall {
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args: readonly unknown[];
}

export interface WalletState {
  readonly status: WalletStatus;
  readonly address: Address | null;
  readonly busy: boolean;
  writeContract(call: ContractCall): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<"success" | "reverted">;
}

export function useWallet(): WalletState {
  const { address, isConnected, chainId } = useAccount();
  const authStatus = useAuthStatus();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const status: WalletStatus =
    authStatus === "authenticated" ? "authenticated" : isConnected ? "connected" : "disconnected";

  const writeContract = useCallback(
    async (call: ContractCall): Promise<Hex> => {
      if (!address) throw new Error("Connect a wallet first.");
      if (chainId !== REQUIRED_CHAIN_ID) await switchChainAsync({ chainId: REQUIRED_CHAIN_ID });
      // writeContractAsync is generic over the ABI; a runtime-assembled call is typed structurally, so
      // narrow to the parameter type here rather than fighting the inference. Not `any` — a concrete cast.
      return writeContractAsync({
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
        chainId: REQUIRED_CHAIN_ID,
      } as unknown as Parameters<typeof writeContractAsync>[0]);
    },
    [address, chainId, switchChainAsync, writeContractAsync],
  );

  const waitForReceipt = useCallback(async (hash: Hex): Promise<"success" | "reverted"> => {
    const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
    return receipt.status;
  }, []);

  return { status, address: address ?? null, busy: false, writeContract, waitForReceipt };
}
