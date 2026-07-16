import { readFileSync } from "node:fs";
import path from "node:path";
import { getDocsRoot } from "./docs-root";

export type NavGroup = {
  readonly group: string;
  readonly pages: readonly string[];
};

export type DocsConfig = {
  readonly name: string;
  readonly description: string;
  readonly navigation: { readonly groups: readonly NavGroup[] };
  readonly navbar: {
    readonly links: readonly { readonly label: string; readonly href: string }[];
    readonly primary: { readonly label: string; readonly href: string };
  };
};

let cached: DocsConfig | null = null;

export function loadDocsConfig(): DocsConfig {
  if (cached) return cached;
  const raw = readFileSync(path.join(getDocsRoot(), "docs.json"), "utf8");
  cached = JSON.parse(raw) as DocsConfig;
  return cached;
}

/** All page slugs in sidebar order (e.g. "index", "concepts/policy"). */
export function allSlugs(): string[] {
  const cfg = loadDocsConfig();
  return cfg.navigation.groups.flatMap((g) => [...g.pages]);
}

/** URL path for a slug: index → "/", else "/concepts/policy". */
export function slugToHref(slug: string): string {
  if (slug === "index") return "/";
  return `/${slug}`;
}

/** Parse URL segments into a content slug. */
export function segmentsToSlug(segments: string[] | undefined): string {
  if (!segments || segments.length === 0) return "index";
  return segments.join("/");
}
