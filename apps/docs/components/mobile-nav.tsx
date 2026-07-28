"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
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
}
