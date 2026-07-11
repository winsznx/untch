import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DashboardNav } from "../../components/dashboard/nav";
import { OPERATOR } from "../../lib/dashboard/data";

export const metadata: Metadata = {
  title: "Untch dashboard",
  description: "Operator dashboard — the proof surface for agent spend governance.",
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas">
      <DashboardNav />
      <div className="lg:pl-64">
        {/* Auth (§15 #1) — demo-operator stand-in, honestly labeled (no live wallet connect). */}
        <div
          className="flex flex-wrap items-center justify-between gap-3 px-6 py-3"
          style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-canvas)" }}
        >
          <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
            Connected as <strong style={{ color: "var(--color-text)" }}>{OPERATOR.label}</strong> · {OPERATOR.agentLabel} · mode {OPERATOR.mode}
          </span>
          <span
            className="rounded-tags px-3 py-1 text-caption"
            style={{ border: "1px solid var(--color-signal)", color: "var(--color-signal)", letterSpacing: "0.24px" }}
          >
            demo operator · no live wallet
          </span>
        </div>

        <main className="mx-auto max-w-[1120px] px-6 py-10">{children}</main>
      </div>
    </div>
  );
}
