"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { NavGroup } from "@/lib/nav";

/**
 * Only what this component reads. The layout passes the search index, whose entries carry more than
 * this; asking for a wider type than we use would force the caller to fabricate fields.
 */
type Item = { readonly slug: string; readonly title: string };

/**
 * The mobile navigation trigger and drawer.
 *
 * It lives in the TOP BAR, not in the page body. Previously it rendered inside `.main`, which put a
 * "Menu" button and a redundant `<select>` in a stack above the article — so on a phone the first
 * two things below the header were navigation controls doing the same job, neither of them attached
 * to the header they belong to.
 *
 * Active state comes from `usePathname()` rather than a prop. That is what allows the component to
 * sit in the layout at all: the layout is a server component with no notion of which page renders.
 */
export function MobileNav({ items, groups }: { items: readonly Item[]; groups: readonly NavGroup[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const activeSlug = pathname === "/" ? "index" : pathname.replace(/^\//, "");

  // A drawer that survived navigation would cover the page the reader just picked.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    // The article must not scroll behind an open drawer.
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  /**
   * The drawer is PORTALLED to <body>, and it has to be.
   *
   * This component renders inside `<header class="topbar">`, and that header carries
   * `backdrop-filter: blur(10px)`. A `backdrop-filter` (like `transform` and `filter`) makes the
   * element a CONTAINING BLOCK for `position: fixed` descendants — so `inset: 56px 0 0 0` resolved
   * against the 56px-tall header rather than the viewport, and the drawer collapsed to a sliver whose
   * first line ("START HERE") bled over the article.
   *
   * Portalling to <body> escapes that containing block entirely. Moving the markup out of the header
   * in the layout would work too, but this keeps the trigger and the thing it triggers in one
   * component, where the relationship is obvious.
   *
   * Rendered only after mount: `document` does not exist during the server pass.
   */
  const overlay = (
    <>
      {open ? <div className="drawer-scrim" onClick={() => setOpen(false)} aria-hidden="true" /> : null}
      <nav className={`drawer ${open ? "open" : ""}`} aria-hidden={!open} aria-label="Documentation">
        {groups.map((g) => (
          <div key={g.group} className="sidebar-group">
            <p className="sidebar-group-title">{g.group}</p>
            {g.pages.map((slug) => {
              const item = items.find((i) => i.slug === slug);
              const href = slug === "index" ? "/" : `/${slug}`;
              return (
                <a key={slug} href={href} className={slug === activeSlug ? "active" : undefined}>
                  {item?.title ?? slug}
                </a>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );

  return (
    <>
      <button
        type="button"
        className="menu-btn"
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {open ? (
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          ) : (
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          )}
        </svg>
      </button>

      {mounted ? createPortal(overlay, document.body) : null}
    </>
  );
}
