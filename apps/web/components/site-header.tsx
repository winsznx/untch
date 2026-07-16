"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { layout } from "@untch/design-tokens";

/**
 * Untch site header / navigation — the product's first real UI component.
 *
 * Header and nav are one component. The Impilo comprehension report (internal/design.md,
 * "Navigation Bar (Dark)") describes a single top bar; there is no separate header spec, so
 * this is one unified piece, not two.
 *
 * TOKENS ONLY. Every color, type role, spacing, and radius comes from @untch/design-tokens:
 *   - colors      → `bg-*` utilities and `var(--color-*)` (the theme.css semantic + raw aliases)
 *   - type roles  → `text-body` (17px/500) and `text-title-sm` (24px/600); each utility carries
 *                   its size, line-height, tracking, and weight together, straight from the scale
 *   - spacing     → the 4px-base utilities (px-6 = 24, gap-8 = 32, py-4 = 16); the base unit IS
 *                   the design's base unit, so these are token references, not raw values
 *   - radius      → `rounded-buttons` (the 9999px pill token)
 * The one raw px in the file is NAV_HEIGHT_PX; see its note.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * FAITHFUL TO SPEC (design.md "Navigation Bar (Dark)" + the do/don't list — applied directly):
 *   - Deep Iris canvas background, 80px height, logo left, center links, pill CTA right
 *   - nav link + CTA text at the settled body role (17px / weight 500)
 *   - 9999px pill radius on the CTA (the non-negotiable "pill on all buttons" rule)
 *   - nav pill carries NO shadow on the dark canvas (tokens.ts elevationRules)
 *
 * LOGO (settled): seal-gate mark from internal/brand — white ring + clinical cyan aperture on
 * dark canvas (`/untch-logo.png`), plus text wordmark at title-sm. Same mark on mobile menu bar.
 *
 * OPEN DECISIONS — Impilo's spec does not answer these:
 *   1. NAV LINKS → Product / Receipts / Docs / Pricing. Receipts points at the real /explorer
 *                  (the public receipts explorer, S6). Product / Docs / Pricing are structural
 *                  placeholders — those pages do not exist yet. Not generic About/Contact filler.
 *   2. CTA       → "Create a spend policy" (the PRD's own canonical primary CTA), not Impilo's
 *                  "Request Demo" (Untch has no demo-booking flow). Points at /dashboard.
 *   3. MOBILE    → collapse below 768px (Tailwind `md`) to a hamburger + token-styled menu.
 *   4. MOTION    → snappy 150ms transitions; nav links lift on hover (opacity), CTA lifts
 *                  (brightness); reduced-motion respected. Nothing specified in the source docs.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * FAITHFUL TO SPEC: 80px bar height (design.md "Navigation Bar (Dark)"). This is a
 * nav-specific dimension, not a shared spacing token — the token scale has no 80px entry
 * (--spacing-section is 80px but means the gap between page sections, a different concept),
 * so it lives here as one named constant rather than a raw literal repeated inline.
 */
const NAV_HEIGHT_PX = 80;

type NavLink = { label: string; href: string };

/**
 * Nav link set — every href resolves today (page, hash, or external).
 *   - Loop     homepage how-it-works band
 *   - Modes    adoption ladder A–D (D labeled roadmap)
 *   - Receipts public explorer
 *   - Pricing  per-call tool prices
 *   - Docs     Mintlify (docs.untch.xyz)
 */
const NAV_LINKS: readonly NavLink[] = [
  { label: "Loop", href: "/#how-it-works" },
  { label: "Modes", href: "/#modes" },
  { label: "Receipts", href: "/explorer" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "https://docs.untch.xyz" },
];

/**
 * NEW DECISION (confirm) — primary CTA. Copy is the PRD's own canonical primary CTA
 * ("Create a spend policy"), replacing Impilo's "Request Demo" (Untch has no demo-booking
 * flow). Destination is /dashboard, the working operator dashboard.
 */
const PRIMARY_CTA = { label: "Create a spend policy", href: "/dashboard" } as const;

/** Shared focus ring in the system's interactive/link color (Clinical Cyan). */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clinical-cyan " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

/** NEW DECISION (confirm) — motion. Nav links rest slightly muted and lift to full on hover. */
const NAV_LINK_CLASS =
  "text-body opacity-70 transition-opacity duration-150 ease-out " +
  "hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none " +
  FOCUS_RING;

/** NEW DECISION (confirm) — motion. Pill lifts on hover via a brightness filter (no shadow, per spec). */
const CTA_CLASS =
  "rounded-buttons bg-action px-6 py-4 text-body transition duration-150 ease-out " +
  "hover:brightness-110 active:brightness-95 motion-reduce:transition-none " +
  FOCUS_RING;

type BarPosition = "top" | "middle" | "bottom";

/** Hamburger bar → morphs to an X on open. Token color (Cloud White); percentage/step utilities only. */
function barClass(open: boolean, pos: BarPosition): string {
  const base =
    "absolute left-0 right-0 h-0.5 bg-cloud-white transition duration-150 ease-out motion-reduce:transition-none";
  if (pos === "middle") return `${base} top-1/2 -translate-y-1/2 ${open ? "opacity-0" : "opacity-100"}`;
  if (pos === "top") return `${base} ${open ? "top-1/2 -translate-y-1/2 rotate-45" : "top-1.5"}`;
  return `${base} ${open ? "bottom-1/2 translate-y-1/2 -rotate-45" : "bottom-1.5"}`;
}

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  // Escape closes the mobile menu. Subscribing to a browser event is a legitimate Effect;
  // it only runs while the menu is open and cleans up after itself.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    // FAITHFUL TO SPEC: Deep Iris canvas background. Sticky + solid canvas fill so the bar
    // stays readable over scrolled content (spec allows "transparent / Deep Iris-canvas"; on a
    // Deep Iris page the two look identical, so the canvas fill is chosen for the sticky case).
    <header className="sticky top-0 z-50 bg-canvas">
      <div
        className="mx-auto flex items-center justify-between px-6 md:grid md:grid-cols-[1fr_auto_1fr]"
        style={{ maxWidth: layout.pageMaxWidth, height: NAV_HEIGHT_PX }}
      >
        {/* Logo: seal-gate mark (public/untch-logo.png) + wordmark at title-sm — desktop + mobile bar. */}
        <Link
          href="/"
          aria-label="Untch home"
          className={`flex items-center gap-2.5 text-title-sm transition-opacity duration-150 ease-out hover:opacity-80 motion-reduce:transition-none md:justify-self-start ${FOCUS_RING}`}
          style={{ color: "var(--color-text)" }}
        >
          <Image
            src="/untch-logo.png"
            alt=""
            width={30}
            height={30}
            priority
            className="h-[30px] w-[30px] shrink-0"
          />
          Untch
        </Link>

        {/* DECISION 2 — center nav links (desktop). FAITHFUL: centered, body role, Cloud White. */}
        <nav aria-label="Primary" className="hidden gap-8 md:flex md:justify-self-center">
          {NAV_LINKS.map((link) =>
            link.href.startsWith("http") ? (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className={NAV_LINK_CLASS}
                style={{ color: "var(--color-text)" }}
              >
                {link.label}
              </a>
            ) : (
              <Link key={link.href} href={link.href} className={NAV_LINK_CLASS} style={{ color: "var(--color-text)" }}>
                {link.label}
              </Link>
            ),
          )}
        </nav>

        <div className="flex items-center gap-4 md:justify-self-end">
          {/* DECISION 3 — primary CTA pill (desktop). FAITHFUL: pill geometry, right-aligned, no shadow. */}
          <Link
            href={PRIMARY_CTA.href}
            className={`hidden md:inline-flex md:items-center ${CTA_CLASS}`}
            style={{ color: "var(--color-text)" }}
          >
            {PRIMARY_CTA.label}
          </Link>

          {/* DECISION 4 — mobile trigger (< 768px). 44px tap target (bars stay 24px). */}
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="site-mobile-menu"
            onClick={() => setOpen((value) => !value)}
            className={`-mr-2 flex h-11 w-11 items-center justify-center md:hidden ${FOCUS_RING}`}
          >
            <span className="relative block h-6 w-6">
              <span className={barClass(open, "top")} />
              <span className={barClass(open, "middle")} />
              <span className={barClass(open, "bottom")} />
            </span>
          </button>
        </div>
      </div>

      {/* DECISION 4 — mobile menu panel. Token surface (Deep Iris) + hairline border, not a
          mobile-only style island. DECISION 5 — snappy 150ms open/close, reduced-motion aware. */}
      <nav
        id="site-mobile-menu"
        aria-label="Mobile"
        aria-hidden={!open}
        className={
          "absolute left-0 right-0 top-full flex flex-col gap-2 border-b bg-canvas px-6 pb-6 pt-2 " +
          "transition duration-150 ease-out motion-reduce:transition-none md:hidden " +
          (open ? "visible translate-y-0 opacity-100" : "pointer-events-none invisible -translate-y-1 opacity-0")
        }
        style={{ borderColor: "var(--color-border)" }}
      >
        {NAV_LINKS.map((link) =>
          link.href.startsWith("http") ? (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              tabIndex={open ? 0 : -1}
              className={`text-body py-3 opacity-80 transition-opacity duration-150 ease-out hover:opacity-100 motion-reduce:transition-none ${FOCUS_RING}`}
              style={{ color: "var(--color-text)" }}
            >
              {link.label}
            </a>
          ) : (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              tabIndex={open ? 0 : -1}
              className={`text-body py-3 opacity-80 transition-opacity duration-150 ease-out hover:opacity-100 motion-reduce:transition-none ${FOCUS_RING}`}
              style={{ color: "var(--color-text)" }}
            >
              {link.label}
            </Link>
          ),
        )}
        <Link
          href={PRIMARY_CTA.href}
          onClick={() => setOpen(false)}
          tabIndex={open ? 0 : -1}
          className={`mt-2 inline-flex items-center justify-center ${CTA_CLASS}`}
          style={{ color: "var(--color-text)" }}
        >
          {PRIMARY_CTA.label}
        </Link>
      </nav>
    </header>
  );
}
