"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Abi, Address, EIP1193Provider, Hex, WriteContractParameters } from "viem";
import { xLayerTestnet, X_LAYER_TESTNET_ID } from "../../lib/chain/chains";
import {
  detectProvider,
  ensureXLayerTestnet,
  getAccounts,
  getChainId,
  makePublicClient,
  makeWalletClient,
  OKX_WALLET_URL,
  requestAccounts,
  type WalletKind,
} from "../../lib/wallet/provider";
import { buildSiweMessage } from "../../lib/wallet/siwe";

/**
 * The single client-side owner of wallet + session state for the whole dashboard.
 *
 * It keeps two separate facts that §27 keeps separate: whether a wallet is CONNECTED (an address is
 * available to sign) and whether the operator is SIGNED IN (SIWE identity proven, session cookie set).
 * Escalation approvals need only the session identity; policy/vault writes ask the connected wallet to
 * sign a fresh transaction each time via `writeContract`. Nothing here reaches into `window` directly —
 * that all lives in lib/wallet/provider.
 */

export type WalletStatus = "disconnected" | "connected" | "authenticated";

/** A contract call any builder in lib/chain produces — address + abi + function + args. */
export interface ContractCall {
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args: readonly unknown[];
}

interface WalletState {
  readonly status: WalletStatus;
  readonly address: Address | null;
  readonly operatorId: string | null;
  readonly chainId: number | null;
  readonly walletLabel: string | null;
  readonly walletKind: WalletKind | null;
  readonly wrongChain: boolean;
  readonly hasWallet: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  connect(): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Ensure connected + on X Layer testnet, sign the call with the connected wallet, return the tx hash. */
  writeContract(call: ContractCall): Promise<Hex>;
  /** Wait for a broadcast tx to confirm; returns the receipt status. */
  waitForReceipt(hash: Hex): Promise<"success" | "reverted">;
  clearError(): void;
}

const WalletContext = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within <WalletProvider>");
  return ctx;
}

export { OKX_WALLET_URL };

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [walletLabel, setWalletLabel] = useState<string | null>(null);
  const [walletKind, setWalletKind] = useState<WalletKind | null>(null);
  const [hasWallet, setHasWallet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerRef = useRef<EIP1193Provider | null>(null);

  // Hydrate once: existing session (cookie) + an already-authorized wallet account (no prompt).
  useEffect(() => {
    let cancelled = false;
    const detected = detectProvider();
    setHasWallet(detected !== null);
    if (detected) {
      providerRef.current = detected.provider;
      setWalletLabel(detected.label);
      setWalletKind(detected.kind);
    }
    void (async () => {
      try {
        const me = (await (await fetch("/api/auth/me")).json()) as {
          authenticated: boolean;
          address?: Address;
          operatorId?: string;
          chainId?: number;
        };
        if (!cancelled && me.authenticated && me.address) {
          setAddress(me.address);
          setOperatorId(me.operatorId ?? null);
          setChainId(me.chainId ?? null);
          setAuthenticated(true);
        }
      } catch {
        /* not signed in */
      }
      if (detected) {
        try {
          const accounts = await getAccounts(detected.provider);
          const id = await getChainId(detected.provider);
          if (!cancelled) {
            if (accounts[0]) setAddress((prev) => prev ?? accounts[0]!);
            setChainId(id);
          }
        } catch {
          /* wallet not authorized yet */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // React to wallet account / chain changes so a switch in OKX Wallet is reflected immediately.
  useEffect(() => {
    const provider = providerRef.current;
    if (!provider?.on) return;
    const onAccounts = (accs: unknown) => {
      const next = Array.isArray(accs) ? (accs[0] as Address | undefined) : undefined;
      setAddress(next ?? null);
      if (!next) {
        setAuthenticated(false);
        setOperatorId(null);
      }
    };
    const onChain = (hex: unknown) => setChainId(Number.parseInt(String(hex), 16));
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [hasWallet]);

  const requireProvider = useCallback((): EIP1193Provider => {
    const provider = providerRef.current ?? detectProvider()?.provider ?? null;
    if (!provider) throw new Error("No wallet found. Install OKX Wallet to connect.");
    providerRef.current = provider;
    return provider;
  }, []);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const provider = requireProvider();
      const accounts = await requestAccounts(provider);
      await ensureXLayerTestnet(provider);
      setAddress(accounts[0] ?? null);
      setChainId(await getChainId(provider));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }, [requireProvider]);

  const signIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const provider = requireProvider();
      let acct = address;
      if (!acct) {
        const accounts = await requestAccounts(provider);
        acct = accounts[0] ?? null;
        setAddress(acct);
      }
      if (!acct) throw new Error("Connect a wallet first.");
      await ensureXLayerTestnet(provider);

      const { nonce } = (await (await fetch("/api/auth/nonce")).json()) as { nonce: string };
      const message = buildSiweMessage({
        address: acct,
        domain: window.location.host,
        uri: window.location.origin,
        nonce,
        issuedAt: new Date(),
        expirationTime: new Date(Date.now() + 10 * 60_000),
      });
      const wallet = makeWalletClient(provider, acct);
      const signature = await wallet.signMessage({ account: acct, message });

      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      const json = (await res.json()) as { ok: boolean; operatorId?: string; reason?: string };
      if (!res.ok || !json.ok) throw new Error(json.reason ?? "Sign-in failed.");
      setOperatorId(json.operatorId ?? null);
      setChainId(X_LAYER_TESTNET_ID);
      setAuthenticated(true);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }, [address, requireProvider]);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      setAuthenticated(false);
      setOperatorId(null);
      setBusy(false);
    }
  }, []);

  const writeContract = useCallback(
    async (call: ContractCall): Promise<Hex> => {
      const provider = requireProvider();
      let acct = address;
      if (!acct) {
        const accounts = await requestAccounts(provider);
        acct = accounts[0] ?? null;
        setAddress(acct);
      }
      if (!acct) throw new Error("Connect a wallet first.");
      await ensureXLayerTestnet(provider);
      const wallet = makeWalletClient(provider, acct);
      // viem's writeContract is generic over the ABI; a runtime-assembled call is typed structurally, so
      // narrow to the parameter type here rather than fighting the inference. Not `any` — a concrete cast.
      const params = {
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
        account: acct,
        chain: xLayerTestnet,
      } as unknown as WriteContractParameters;
      return wallet.writeContract(params);
    },
    [address, requireProvider],
  );

  const waitForReceipt = useCallback(async (hash: Hex): Promise<"success" | "reverted"> => {
    const receipt = await makePublicClient().waitForTransactionReceipt({ hash });
    return receipt.status;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const wrongChain = address !== null && chainId !== null && chainId !== X_LAYER_TESTNET_ID;
  const status: WalletStatus = authenticated ? "authenticated" : address ? "connected" : "disconnected";

  const value = useMemo<WalletState>(
    () => ({
      status,
      address,
      operatorId,
      chainId,
      walletLabel,
      walletKind,
      wrongChain,
      hasWallet,
      busy,
      error,
      connect,
      signIn,
      signOut,
      writeContract,
      waitForReceipt,
      clearError,
    }),
    [status, address, operatorId, chainId, walletLabel, walletKind, wrongChain, hasWallet, busy, error, connect, signIn, signOut, writeContract, waitForReceipt, clearError],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "shortMessage" in e && typeof e.shortMessage === "string") {
    return e.shortMessage;
  }
  const msg = e instanceof Error ? e.message : String(e);
  // User-rejected signatures are the common case; keep it human.
  if (/rejected|denied|user cancel/i.test(msg)) return "Request rejected in wallet.";
  return msg.split("\n")[0] ?? "Something went wrong.";
}
