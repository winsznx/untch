"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: { href: string; label: string }[] = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/intents", label: "Intent stream" },
  { href: "/dashboard/policies", label: "Policies" },
  { href: "/dashboard/escalations", label: "Escalations" },
  { href: "/dashboard/ledger", label: "Ledger" },
  { href: "/dashboard/vault", label: "Vault" },
  { href: "/dashboard/vendors", label: "Vendors" },
  { href: "/dashboard/reports", label: "Reports" },
  { href: "/dashboard/disputes", label: "Disputes" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/explorer", label: "Public explorer" },
];

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clinical-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Dashboard" className="flex flex-col gap-1">
      {LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`rounded-inputs px-3 py-2 text-body-sm transition duration-150 ease-out motion-reduce:transition-none ${FOCUS} ${active ? "" : "opacity-70 hover:opacity-100"}`}
            style={{
              color: "var(--color-text)",
              background: active ? "var(--color-action)" : "transparent",
            }}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

function Wordmark() {
  return (
    <Link href="/" className={`text-title-sm ${FOCUS} rounded-icons`} style={{ color: "var(--color-text)" }}>
      Untch
    </Link>
  );
}

export function DashboardNav() {
  const pathname = usePathname() ?? "/dashboard";
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-64 lg:flex-col lg:gap-8 lg:overflow-y-auto lg:px-5 lg:py-8"
        style={{ background: "var(--color-surface)", borderRight: "1px solid var(--color-border)" }}
      >
        <Wordmark />
        <NavList pathname={pathname} />
      </aside>

      {/* Mobile top bar */}
      <div
        className="sticky top-0 z-40 flex items-center justify-between px-6 lg:hidden"
        style={{ background: "var(--color-surface)", borderBottom: "1px solid var(--color-border)", height: 64 }}
      >
        <Wordmark />
        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`-mr-2 flex h-11 w-11 items-center justify-center ${FOCUS}`}
        >
          <span className="relative block h-6 w-6">
            <span className="absolute left-0 right-0 top-1.5 h-0.5 bg-cloud-white" />
            <span className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 bg-cloud-white" />
            <span className="absolute left-0 right-0 bottom-1.5 h-0.5 bg-cloud-white" />
          </span>
        </button>
      </div>

      {open ? (
        <div
          className="sticky top-16 z-40 px-6 py-4 lg:hidden"
          style={{ background: "var(--color-surface)", borderBottom: "1px solid var(--color-border)" }}
        >
          <NavList pathname={pathname} onNavigate={() => setOpen(false)} />
        </div>
      ) : null}
    </>
  );
}
