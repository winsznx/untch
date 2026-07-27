"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { NavIcon, type NavIconName } from "./nav-icons";

const LINKS: { href: string; label: string; icon: NavIconName }[] = [
  { href: "/dashboard/start", label: "Get started", icon: "start" },
  { href: "/dashboard", label: "Overview", icon: "overview" },
  { href: "/dashboard/intents", label: "Intent stream", icon: "intents" },
  { href: "/dashboard/policies", label: "Policies", icon: "policies" },
  { href: "/dashboard/escalations", label: "Escalations", icon: "escalations" },
  { href: "/dashboard/ledger", label: "Ledger", icon: "ledger" },
  { href: "/dashboard/consumer", label: "Consumer Pack", icon: "consumer" },
  { href: "/dashboard/vault", label: "Vault", icon: "vault" },
  { href: "/dashboard/vendors", label: "Vendors", icon: "vendors" },
  { href: "/dashboard/reports", label: "Reports", icon: "reports" },
  { href: "/dashboard/disputes", label: "Disputes", icon: "disputes" },
  { href: "/dashboard/settings", label: "Settings", icon: "settings" },
  { href: "/explorer", label: "Public explorer", icon: "explorer" },
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
            title={link.label}
            aria-current={active ? "page" : undefined}
            className={`nav-item flex items-center gap-3 rounded-inputs px-3 py-2 text-body-sm transition duration-150 ease-out motion-reduce:transition-none ${FOCUS} ${active ? "" : "opacity-70 hover:opacity-100"}`}
            style={{
              color: "var(--color-text)",
              background: active ? "var(--color-action)" : "transparent",
            }}
          >
            <NavIcon name={link.icon} className="shrink-0" />
            <span className="nav-label truncate">{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className={`flex items-center gap-2 text-title-sm ${FOCUS}`} style={{ color: "var(--color-text)" }} aria-label="Untch home">
      <Image
        src="/untch-logo.png"
        alt=""
        width={26}
        height={26}
        priority
        className="h-[26px] w-[26px] shrink-0"
      />
      {compact ? null : <span className="nav-label">Untch</span>}
    </Link>
  );
}

/** Reads the persisted rail state (set pre-paint by the inline script in the dashboard layout) and toggles
 *  it on <html data-sidebar>, which CSS turns into the collapsed rail width + hidden labels. */
function useRail(): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(document.documentElement.dataset.sidebar === "collapsed");
  }, []);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.documentElement.dataset.sidebar = next ? "collapsed" : "expanded";
    try {
      localStorage.setItem("untch-sidebar", next ? "collapsed" : "expanded");
    } catch {
      /* private mode — rail just won't persist */
    }
  };
  return { collapsed, toggle };
}

export function DashboardNav() {
  const pathname = usePathname() ?? "/dashboard";
  const [open, setOpen] = useState(false);
  const { collapsed, toggle } = useRail();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

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
      {/* Desktop sidebar — collapses to an icon rail (width + labels driven by html[data-sidebar] in CSS) */}
      <aside
        className={`dashboard-sidebar hidden lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:flex-col lg:gap-6 lg:overflow-y-auto lg:px-3 lg:py-6 ${collapsed ? "is-collapsed" : ""}`}
        style={{ background: "var(--color-surface)", borderRight: "1px solid var(--color-border)" }}
      >
        <div className="nav-brand flex items-center justify-between gap-2 px-1">
          <Wordmark compact={collapsed} />
        </div>
        <NavList pathname={pathname} />
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={`nav-item mt-auto flex items-center gap-3 rounded-inputs px-3 py-2 text-body-sm opacity-60 transition hover:opacity-100 ${FOCUS}`}
          style={{ color: "var(--color-text)" }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`shrink-0 transition-transform ${collapsed ? "rotate-180" : ""}`}>
            <path d="M12.5 5 7.5 10l5 5" />
            <path d="M4 4.5v11" />
          </svg>
          <span className="nav-label">Collapse</span>
        </button>
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

      {/* Mobile slide-in drawer + backdrop (icon + label nav) */}
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
          className={`fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[85vw] flex-col gap-6 overflow-y-auto px-4 py-6 transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? "translate-x-0" : "-translate-x-full"} ${open ? "" : "pointer-events-none"}`}
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
