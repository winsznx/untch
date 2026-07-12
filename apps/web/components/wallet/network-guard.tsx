"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { X_LAYER_TESTNET_ADD_PARAMS, xLayerTestnet } from "../../lib/chain/chains";
import { REQUIRED_CHAIN_ID, resolveNetworkAction } from "../../lib/wallet/network";

/**
 * Ensures a connected wallet is on X Layer testnet BEFORE the SIWE sign step (and every write) can run.
 *
 * Why this exists: RainbowKit's SIWE handler reads `useAccount().chain?.id`, which wagmi leaves `undefined`
 * whenever the wallet's active chain isn't in the configured set — and then silently returns without
 * prompting a signature. MetaMask happens to auto-switch to a configured chain on connect, so it never hits
 * that path; OKX (and others) do not, so their sign-in silently no-ops. Rather than rely on each wallet's
 * connect-time grace, we make the switch EXPLICIT and connector-agnostic here.
 *
 * The switch goes through wagmi's `switchChainAsync`, which issues `wallet_switchEthereumChain` and, if the
 * wallet doesn't yet know X Layer testnet (EIP-3326 error 4902), first issues `wallet_addEthereumChain` with
 * the EIP-3085 params, then switches. If the wallet can't or won't switch (rejected, unsupported), we show a
 * clear banner asking the operator to switch manually — never a silent failure or hang.
 */

type SwitchState = { readonly busy: boolean; readonly error: string | null };

export function NetworkGuard() {
  const { isConnected, chainId, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [state, setState] = useState<SwitchState>({ busy: false, error: null });
  const attemptedFor = useRef<string | null>(null);

  const action = resolveNetworkAction({ isConnected, chainId });
  const wrongChain = action.kind === "switch";
  // One attempt key per (connector, wrong chain): a rejection won't loop; a chain change re-arms the auto-switch.
  const attemptKey = wrongChain ? `${connector?.id ?? "?"}:${chainId}` : null;

  const requestSwitch = useCallback(async () => {
    setState({ busy: true, error: null });
    try {
      await switchChainAsync({
        chainId: REQUIRED_CHAIN_ID,
        addEthereumChainParameter: X_LAYER_TESTNET_ADD_PARAMS,
      });
      setState({ busy: false, error: null });
    } catch (e) {
      setState({ busy: false, error: switchErrorMessage(e) });
    }
  }, [switchChainAsync]);

  // Proactively request the switch the instant a connected wallet is seen on the wrong chain, so the SIWE
  // step never renders against an unsupported chain. Guarded to fire at most once per wrong-chain state; the
  // banner button below drives any retry after a rejection.
  useEffect(() => {
    if (attemptKey === null) {
      attemptedFor.current = null;
      return;
    }
    if (attemptedFor.current === attemptKey) return;
    attemptedFor.current = attemptKey;
    void requestSwitch();
  }, [attemptKey, requestSwitch]);

  if (!wrongChain) return null;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 px-6 py-3"
      style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-signal-subtle, #2a1a1a)" }}
    >
      <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
        {state.error
          ? `${state.error} Untch runs on ${xLayerTestnet.name} — switch your wallet's network there to sign in.`
          : state.busy
            ? `Switching your wallet to ${xLayerTestnet.name}… approve the request in your wallet.`
            : `Your wallet is on the wrong network. Untch runs on ${xLayerTestnet.name}.`}
      </span>
      <button
        type="button"
        onClick={() => void requestSwitch()}
        disabled={state.busy}
        style={{
          borderRadius: "9999px",
          padding: "8px 18px",
          fontSize: 14,
          fontWeight: 500,
          cursor: state.busy ? "not-allowed" : "pointer",
          opacity: state.busy ? 0.55 : 1,
          background: "var(--color-action)",
          color: "var(--color-text)",
          border: "1px solid var(--color-action)",
        }}
      >
        {state.busy ? "Switching…" : `Switch to ${xLayerTestnet.name}`}
      </button>
    </div>
  );
}

function switchErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/rejected|denied|user cancel/i.test(msg)) return "Network switch was rejected in your wallet.";
  if (e && typeof e === "object" && "shortMessage" in e && typeof e.shortMessage === "string") {
    return e.shortMessage;
  }
  return msg.split("\n")[0] ?? "Couldn't switch networks.";
}
