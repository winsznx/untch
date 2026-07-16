"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { NavGroup } from "@/lib/nav";

type Item = { slug: string; href: string; title: string; group: string };

export function MobileNav({
  items,
  activeSlug,
  groups,
}: {
  items: Item[];
  activeSlug: string;
  groups: readonly NavGroup[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="menu-btn" onClick={() => setOpen((v) => !v)}>
        {open ? "Close menu" : "Menu"}
      </button>
      <div className="mobile-nav">
        <select
          value={activeSlug}
          aria-label="Jump to page"
          onChange={(e) => {
            const slug = e.target.value;
            router.push(slug === "index" ? "/" : `/${slug}`);
          }}
        >
          {groups.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.pages.map((slug) => {
                const item = items.find((i) => i.slug === slug);
                return (
                  <option key={slug} value={slug}>
                    {item?.title ?? slug}
                  </option>
                );
              })}
            </optgroup>
          ))}
        </select>
      </div>
      <div className={`drawer ${open ? "open" : ""}`}>
        {groups.map((g) => (
          <div key={g.group} className="sidebar-group">
            <p className="sidebar-group-title">{g.group}</p>
            {g.pages.map((slug) => {
              const item = items.find((i) => i.slug === slug);
              const href = slug === "index" ? "/" : `/${slug}`;
              return (
                <a
                  key={slug}
                  href={href}
                  className={slug === activeSlug ? "active" : undefined}
                  onClick={() => setOpen(false)}
                  style={{
                    display: "block",
                    padding: "0.4rem 0.5rem",
                    color: slug === activeSlug ? "var(--text)" : "var(--muted)",
                  }}
                >
                  {item?.title ?? slug}
                </a>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
