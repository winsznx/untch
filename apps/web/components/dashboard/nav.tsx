"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
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
    <Link href="/" className={`flex items-center gap-2 text-title-sm ${FOCUS} rounded-icons`} style={{ color: "var(--color-text)" }}>
      <Image src="/untch-logo.png" alt="" width={26} height={26} priority className="rounded-icons" />
      Untch
    </Link>
  );
}

export function DashboardNav() {
  const pathname = usePathname() ?? "/dashboard";
  const [open, setOpen] = useState(false);

  // Close the drawer on route change.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // While the drawer is open: close on Escape and lock body scroll (a modal surface).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
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
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="dashboard-drawer"
          onClick={() => setOpen(true)}
          className={`-mr-2 flex h-11 w-11 items-center justify-center ${FOCUS}`}
        >
          <span className="relative block h-6 w-6" aria-hidden>
            <span className="absolute left-0 right-0 top-1.5 h-0.5 bg-cloud-white" />
            <span className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 bg-cloud-white" />
            <span className="absolute left-0 right-0 bottom-1.5 h-0.5 bg-cloud-white" />
          </span>
        </button>
      </div>

      {/* Mobile slide-in drawer + backdrop (off-canvas, above the top bar) */}
      <div className="lg:hidden" aria-hidden={!open}>
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={open ? 0 : -1}
          onClick={() => setOpen(false)}
          className={`fixed inset-0 z-50 cursor-default transition-opacity duration-200 ease-out motion-reduce:transition-none ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
          style={{ background: "rgba(3, 2, 14, 0.6)", backdropFilter: "blur(2px)" }}
        />
        <aside
          id="dashboard-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Dashboard menu"
          className={`fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[85vw] flex-col gap-6 overflow-y-auto px-5 py-6 transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? "translate-x-0" : "-translate-x-full"} ${open ? "" : "pointer-events-none"}`}
          style={{ background: "var(--color-surface)", borderRight: "1px solid var(--color-border)" }}
        >
          <div className="flex items-center justify-between">
            <Wordmark />
            <button
              type="button"
              aria-label="Close menu"
              tabIndex={open ? 0 : -1}
              onClick={() => setOpen(false)}
              className={`-mr-1 flex h-10 w-10 items-center justify-center ${FOCUS}`}
            >
              <span className="relative block h-5 w-5" aria-hidden>
                <span className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 rotate-45 bg-cloud-white" />
                <span className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 -rotate-45 bg-cloud-white" />
              </span>
            </button>
          </div>
          <NavList pathname={pathname} onNavigate={() => setOpen(false)} />
        </aside>
      </div>
    </>
  );
}
