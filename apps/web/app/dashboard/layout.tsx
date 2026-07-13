import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { DashboardNav } from "../../components/dashboard/nav";
import { AuthBar } from "../../components/wallet/auth-bar";
import { NetworkGuard } from "../../components/wallet/network-guard";
import { Providers } from "../../components/wallet/providers";

export const metadata: Metadata = {
  title: "Untch dashboard",
  description: "Operator dashboard — the proof surface for agent spend governance.",
};

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // The wagmi connection cookie hydrates the client's initial wallet state (see providers.tsx).
  const cookie = (await headers()).get("cookie");

  return (
    <Providers cookie={cookie}>
      {/* Restore the collapsed-rail choice before first paint so the sidebar never flashes full-width. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `try{if(localStorage.getItem('untch-sidebar')==='collapsed')document.documentElement.dataset.sidebar='collapsed';}catch(e){}`,
        }}
      />
      <div className="min-h-screen bg-canvas">
        <DashboardNav />
        <div className="dashboard-shell">
          {/* Auth (§15 #1) — RainbowKit single-flow connect + SIWE sign-in (OKX Wallet priority). */}
          <AuthBar />
          {/* Normalises any connected wallet to X Layer testnet before SIWE — see network-guard.tsx. */}
          <NetworkGuard />
          <main className="mx-auto max-w-[1120px] px-6 py-10">{children}</main>
        </div>
      </div>
    </Providers>
  );
}
