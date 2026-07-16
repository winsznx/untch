import Link from "next/link";
import { loadDocsConfig, slugToHref } from "@/lib/nav";
import { loadPage } from "@/lib/content";

export function Sidebar({ activeSlug }: { activeSlug: string }) {
  const cfg = loadDocsConfig();
  return (
    <nav className="sidebar" aria-label="Documentation">
      {cfg.navigation.groups.map((g) => (
        <div key={g.group} className="sidebar-group">
          <p className="sidebar-group-title">{g.group}</p>
          {g.pages.map((slug) => {
            const page = loadPage(slug);
            const href = slugToHref(slug);
            const label = page?.title ?? slug;
            const active = slug === activeSlug;
            return (
              <Link key={slug} href={href} className={active ? "active" : undefined}>
                {label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
