import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { loadDocsConfig } from "@/lib/nav";
import { buildSearchIndex } from "@/lib/content";
import { SearchBox } from "@/components/search";
import { ThemeToggle, THEME_INIT_SCRIPT } from "@/components/theme-toggle";
import "./globals.css";

const cfg = loadDocsConfig();

export const metadata: Metadata = {
  title: {
    default: `${cfg.name} docs`,
    template: `%s · ${cfg.name}`,
  },
  description: cfg.description,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const searchIndex = buildSearchIndex();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="brand">
              <Image src="/logo.svg" alt="" width={28} height={28} priority />
              Untch docs
            </Link>
            <SearchBox index={searchIndex} />
            <ThemeToggle />
            <nav className="top-links" aria-label="Product">
              {cfg.navbar.links.map((l) => (
                <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">
                  {l.label}
                </a>
              ))}
              <a className="cta" href={cfg.navbar.primary.href}>
                {cfg.navbar.primary.label}
              </a>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}