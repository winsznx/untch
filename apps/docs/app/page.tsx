import type { Metadata } from "next";
import { loadPage } from "@/lib/content";
import { loadDocsConfig, allSlugs, slugToHref } from "@/lib/nav";
import { Markdown } from "@/components/markdown";
import { Sidebar } from "@/components/sidebar";
import { Pager } from "@/components/pager";
import { MobileNav } from "@/components/mobile-nav";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Untch documentation",
  description:
    "Accounts payable for autonomous agents. Policy, proof, and receipts on X Layer.",
};

export default function HomePage() {
  const page = loadPage("index");
  if (!page) notFound();
  const cfg = loadDocsConfig();
  const items = allSlugs().map((slug) => {
    const p = loadPage(slug);
    return {
      slug,
      href: slugToHref(slug),
      title: p?.title ?? slug,
      group: cfg.navigation.groups.find((g) => g.pages.includes(slug))?.group ?? "",
    };
  });

  return (
    <div className="frame">
      <Sidebar activeSlug="index" />
      <main className="main">
        <MobileNav items={items} activeSlug="index" groups={cfg.navigation.groups} />
        {page.description ? <p className="desc">{page.description}</p> : null}
        <Markdown source={page.body} />
        <Pager slug="index" />
      </main>
    </div>
  );
}
