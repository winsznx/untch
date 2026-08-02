import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { AuthBar } from "../../components/wallet/auth-bar";
import { NetworkGuard } from "../../components/wallet/network-guard";
import { Providers } from "../../components/wallet/providers";

export const metadata: Metadata = {
  title: "Untch — approvals",
  description: "The one place a payment decision is made with the wallet that owns the account.",
};

const TABS = [
  { href: "/approvals", label: "Approvals" },
  { href: "/activity", label: "Activity" },
  { href: "/policies", label: "Policies" },
  { href: "/account", label: "Account" },
] as const;

export default async function AccountLayout({ children }: { children: ReactNode }) {
  const cookie = (await headers()).get("cookie");
  return (
    <Providers cookie={cookie}>
      <div className="min-h-screen bg-canvas">
        <AuthBar />
        <NetworkGuard />
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-10">
          <nav className="flex flex-wrap gap-4">
            {TABS.map((t) => (
              <Link key={t.href} href={t.href} className="text-body" style={{ color: "var(--color-inverse-muted)" }}>
                {t.label}
              </Link>
            ))}
          </nav>
          {children}
        </div>
      </div>
    </Providers>
  );
}
