import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPage } from "@/lib/content";
import { allSlugs, loadDocsConfig, segmentsToSlug, slugToHref } from "@/lib/nav";
import { Markdown } from "@/components/markdown";
import { Sidebar } from "@/components/sidebar";
import { Pager } from "@/components/pager";
import { MobileNav } from "@/components/mobile-nav";

type Props = { params: Promise<{ slug: string[] }> };

export function generateStaticParams() {
  return allSlugs()
    .filter((s) => s !== "index")
    .map((s) => ({ slug: s.split("/") }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug: segs } = await params;
  const slug = segmentsToSlug(segs);
  const page = loadPage(slug);
  if (!page) return { title: "Not found" };
  return {
    title: page.title,
    description: page.description || undefined,
  };
}

export default async function DocPage({ params }: Props) {
  const { slug: segs } = await params;
  const slug = segmentsToSlug(segs);
  if (slug === "index") notFound();
  const page = loadPage(slug);
  if (!page) notFound();

  const cfg = loadDocsConfig();
  const items = allSlugs().map((s) => {
    const p = loadPage(s);
    return {
      slug: s,
      href: slugToHref(s),
      title: p?.title ?? s,
      group: cfg.navigation.groups.find((g) => g.pages.includes(s))?.group ?? "",
    };
  });

  return (
    <div className="frame">
      <Sidebar activeSlug={slug} />
      <main className="main">
        <MobileNav items={items} activeSlug={slug} groups={cfg.navigation.groups} />
        {page.description ? <p className="desc">{page.description}</p> : null}
        <Markdown source={page.body} />
        <Pager slug={slug} />
      </main>
    </div>
  );
}
