"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { useAuthStatus } from "./wallet-context";

/**
 * The dashboard app bar — a slim two-zone band: the current section (breadcrumb) on the left, and the
 * session-status chip + the (token-themed) RainbowKit connect button on the right. It's the single top
 * chrome; the long §27 explainer that used to float here now lives in the status chip's tooltip so the bar
 * stays clean. Sticky at the desktop breakpoint; on mobile the nav's own top bar sits above it.
 */

const SECTION: Record<string, string> = {
  "/dashboard/start": "Get started",
  "/dashboard": "Overview",
  "/dashboard/intents": "Intent stream",
  "/dashboard/policies": "Policies",
  "/dashboard/escalations": "Escalations",
  "/dashboard/ledger": "Ledger",
  "/dashboard/vault": "Vault",
  "/dashboard/vendors": "Vendors",
  "/dashboard/reports": "Reports",
  "/dashboard/disputes": "Disputes",
  "/dashboard/settings": "Settings",
};

export function AuthBar() {
  const pathname = usePathname() ?? "/dashboard";
  const { isConnected } = useAccount();
  const authStatus = useAuthStatus();
  const section = SECTION[pathname] ?? "Dashboard";

  const status =
    authStatus === "authenticated"
      ? {
          dot: "var(--color-positive)",
          label: "Signed in",
          title:
            "Signed in. Escalation approvals are authorized by this session; each on-chain write signs its own transaction.",
        }
      : isConnected
        ? {
            dot: "var(--color-signal)",
            label: "Sign in to operate",
            title: "Wallet connected. Finish signing in to authorize approvals.",
          }
        : {
            dot: "var(--color-inverse-muted)",
            label: "Not connected",
            title: "Connect your wallet and sign in to operate this dashboard. OKX Wallet recommended.",
          };

  return (
    <div
      className="z-30 flex items-center justify-between gap-3 px-6 py-3 lg:sticky lg:top-0"
      style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-canvas)" }}
    >
      <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-2 text-body-sm lg:flex">
        <span style={{ color: "var(--color-inverse-muted)" }}>Dashboard</span>
        <span aria-hidden style={{ color: "var(--color-divider)" }}>
          /
        </span>
        <span className="truncate" style={{ color: "var(--color-text)" }}>
          {section}
        </span>
      </nav>

      <div className="flex flex-1 items-center justify-end gap-3 lg:flex-none">
        <span
          title={status.title}
          className="hidden items-center gap-2 rounded-full px-3 py-1.5 text-caption-lg sm:flex"
          style={{ border: "1px solid var(--color-border)", color: "var(--color-inverse-canvas)" }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.dot }} />
          {status.label}
        </span>
        <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
      </div>
    </div>
  );
}
