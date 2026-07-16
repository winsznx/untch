import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { getDocsRoot } from "./docs-root";
import { allSlugs } from "./nav";

export type DocPage = {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
};

function fileForSlug(slug: string): string {
  const root = getDocsRoot();
  if (slug === "index") return path.join(root, "index.mdx");
  return path.join(root, `${slug}.mdx`);
}

export function loadPage(slug: string): DocPage | null {
  const file = fileForSlug(slug);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  const { data, content } = matter(raw);
  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim()
      : slug === "index"
        ? "Untch documentation"
        : slug.split("/").pop() ?? slug;
  const description = typeof data.description === "string" ? data.description : "";
  return { slug, title, description, body: content.trim() };
}

export function loadAllPages(): DocPage[] {
  return allSlugs()
    .map((s) => loadPage(s))
    .filter((p): p is DocPage => p !== null);
}

/** Lightweight search index for client filter (title + description + body snippet). */
export type SearchEntry = {
  readonly slug: string;
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly text: string;
};

export function buildSearchIndex(): SearchEntry[] {
  return loadAllPages().map((p) => ({
    slug: p.slug,
    href: p.slug === "index" ? "/" : `/${p.slug}`,
    title: p.title,
    description: p.description,
    text: `${p.title} ${p.description} ${p.body}`.toLowerCase(),
  }));
}
