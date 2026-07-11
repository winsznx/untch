import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DashboardNav } from "../../components/dashboard/nav";
import { AuthBar } from "../../components/wallet/auth-bar";
import { Providers } from "../../components/wallet/providers";

export const metadata: Metadata = {
  title: "Untch dashboard",
  description: "Operator dashboard — the proof surface for agent spend governance.",
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <div className="min-h-screen bg-canvas">
        <DashboardNav />
        <div className="lg:pl-64">
          {/* Auth (§15 #1) — RainbowKit single-flow connect + SIWE sign-in (OKX Wallet priority). */}
          <AuthBar />
          <main className="mx-auto max-w-[1120px] px-6 py-10">{children}</main>
        </div>
      </div>
    </Providers>
  );
}
