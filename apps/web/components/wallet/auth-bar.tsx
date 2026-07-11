"use client";

import { OKX_WALLET_URL, useWallet } from "./wallet-context";

/**
 * The dashboard's real auth control, replacing the old "demo operator · no live wallet" banner.
 *
 * It surfaces the two-step §27 model directly: connect a wallet (OKX Wallet first), then sign in
 * (SIWE) to prove identity. Once signed in it shows the operator's address and a sign-out. Wrong network
 * and no-wallet states are explicit, never a dead button.
 */

const barStyle = { borderBottom: "1px solid var(--color-border)", background: "var(--color-canvas)" } as const;

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AuthBar() {
  const w = useWallet();

  return (
    <div className="flex flex-col gap-2 px-6 py-3" style={barStyle}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
          {w.status === "authenticated" ? (
            <>
              Signed in as{" "}
              <strong style={{ color: "var(--color-text)", fontFamily: "ui-monospace, monospace" }}>
                {w.address ? short(w.address) : ""}
              </strong>{" "}
              · X Layer testnet
            </>
          ) : w.status === "connected" ? (
            <>
              Wallet connected{" "}
              <strong style={{ color: "var(--color-text)", fontFamily: "ui-monospace, monospace" }}>
                {w.address ? short(w.address) : ""}
              </strong>{" "}
              · sign in to authorize approvals
            </>
          ) : w.hasWallet ? (
            <>Connect your wallet to create policies, run vault actions, and approve escalations.</>
          ) : (
            <>No wallet detected. Install OKX Wallet to operate this dashboard.</>
          )}
        </span>

        <div className="flex items-center gap-2">
          {w.wrongChain ? (
            <button type="button" onClick={() => void w.connect()} disabled={w.busy} className="auth-btn" style={signalBtn}>
              Switch to X Layer testnet
            </button>
          ) : null}

          {!w.hasWallet ? (
            <a href={OKX_WALLET_URL} target="_blank" rel="noopener noreferrer" className="auth-btn" style={primaryBtn}>
              Install OKX Wallet
            </a>
          ) : w.status === "disconnected" ? (
            <button type="button" onClick={() => void w.connect()} disabled={w.busy} className="auth-btn" style={primaryBtn}>
              {w.busy ? "Connecting…" : `Connect ${w.walletLabel ?? "wallet"}`}
            </button>
          ) : w.status === "connected" ? (
            <button type="button" onClick={() => void w.signIn()} disabled={w.busy} className="auth-btn" style={primaryBtn}>
              {w.busy ? "Signing…" : "Sign in"}
            </button>
          ) : (
            <button type="button" onClick={() => void w.signOut()} disabled={w.busy} className="auth-btn" style={ghostBtn}>
              Sign out
            </button>
          )}
        </div>
      </div>

      {w.error ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-caption-lg" style={{ color: "var(--color-signal)" }}>{w.error}</span>
          <button type="button" onClick={w.clearError} className="text-caption-lg underline-offset-4 hover:underline" style={{ color: "var(--color-inverse-muted)" }}>
            dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

const baseBtn = {
  borderRadius: "9999px",
  padding: "8px 16px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
} as const;
const primaryBtn = { ...baseBtn, background: "var(--color-action)", color: "var(--color-text)", border: "1px solid var(--color-action)" };
const ghostBtn = { ...baseBtn, background: "transparent", color: "var(--color-text)", border: "1px solid var(--color-border)" };
const signalBtn = { ...baseBtn, background: "transparent", color: "var(--color-signal)", border: "1px solid var(--color-signal)" };
