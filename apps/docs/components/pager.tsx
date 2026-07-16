import Link from "next/link";
import { allSlugs, slugToHref } from "@/lib/nav";
import { loadPage } from "@/lib/content";

export function Pager({ slug }: { slug: string }) {
  const slugs = allSlugs();
  const i = slugs.indexOf(slug);
  const prev = i > 0 ? slugs[i - 1] : null;
  const next = i >= 0 && i < slugs.length - 1 ? slugs[i + 1] : null;

  if (!prev && !next) return null;

  return (
    <nav className="pager" aria-label="Adjacent pages">
      <div>
        {prev ? (
          <Link href={slugToHref(prev)}>
            ← {loadPage(prev)?.title ?? prev}
          </Link>
        ) : (
          <span />
        )}
      </div>
      <div style={{ textAlign: "right" }}>
        {next ? (
          <Link href={slugToHref(next)}>
            {loadPage(next)?.title ?? next} →
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
