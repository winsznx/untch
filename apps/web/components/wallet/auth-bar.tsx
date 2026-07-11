"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { useAuthStatus } from "./wallet-context";

/**
 * The dashboard auth control: a single RainbowKit `<ConnectButton />`. Connecting a wallet and signing in
 * (SIWE) happen as one continuous flow inside RainbowKit's own modal — there is no separate "Sign in"
 * button to find. OKX Wallet is the first, recommended connector (see lib/wallet/wagmi.ts). The left-hand
 * message reflects the two-step §27 model (identity via sign-in; each on-chain write signs its own tx).
 */
export function AuthBar() {
  const { isConnected } = useAccount();
  const authStatus = useAuthStatus();

  const message =
    authStatus === "authenticated"
      ? "Signed in. Escalation approvals are authorized by this session; each on-chain write signs its own transaction."
      : isConnected
        ? "Wallet connected. Finish signing in to authorize approvals."
        : "Connect your wallet and sign in to operate this dashboard. OKX Wallet recommended.";

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 px-6 py-3"
      style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-canvas)" }}
    >
      <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
        {message}
      </span>
      <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
    </div>
  );
}
