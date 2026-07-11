import Link from "next/link";

/**
 * Site footer — NEW INVENTION (confirm). §4d records that the design files specify only the
 * footer background color (Iris Glow); no layout, columns, links, or content exist to translate.
 * So the structure below is a genuine decision within the token system.
 *
 * FAITHFUL TO SPEC: the one specified value, Iris Glow background (`--color-surface-raised`),
 * plus the system's geometry and type roles. Depth from tonal fill, no drop shadow.
 *
 * NEW DECISIONS (confirm):
 *  - Three link columns (Product / Developers / Proof), grounded in what is true about Untch.
 *  - Wordmark placeholder + the PRD tagline and the no-custody line (I4) verbatim.
 *  - Link destinations are structural; several pages do not exist yet (see apps/web/README.md).
 */

type FooterLink = { label: string; href: string; external?: boolean };

const COLUMNS: { heading: string; links: FooterLink[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "Product", href: "/product" },
      { label: "Public receipts", href: "/explorer" },
      { label: "Pricing", href: "/pricing" },
      { label: "Open dashboard", href: "/app" },
    ],
  },
  {
    heading: "Developers",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Payment middleware", href: "/docs" },
      { label: "Bureau methodology", href: "/methodology" },
      { label: "MCP tools", href: "/docs" },
    ],
  },
  {
    heading: "Proof",
    links: [
      { label: "Receipts explorer", href: "/explorer" },
      { label: "Deployed contracts", href: "/explorer" },
      { label: "Verify on X Layer", href: "https://www.oklink.com/x-layer", external: true },
    ],
  },
];

const LINK_CLASS =
  "text-body-sm opacity-80 transition-opacity duration-150 ease-out hover:opacity-100 motion-reduce:transition-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clinical-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised";

function FooterLinkItem({ link }: { link: FooterLink }) {
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS} style={{ color: "var(--color-text)" }}>
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} className={LINK_CLASS} style={{ color: "var(--color-text)" }}>
      {link.label}
    </Link>
  );
}

export function SiteFooter() {
  return (
    <footer className="bg-surface-raised">
      <div className="mx-auto max-w-page px-6 py-16">
        <div className="flex flex-col gap-12 lg:flex-row lg:justify-between">
          <div className="flex max-w-sm flex-col gap-4">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
              Untch
            </span>
            <p className="text-body" style={{ color: "var(--color-text)" }}>
              The model never touches the money.
            </p>
            <p className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
              Accounts payable for autonomous agents. Untch keeps agent funds untouched until policy, proof,
              and spend limits clear the payment.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
            {COLUMNS.map((col) => (
              <div key={col.heading} className="flex flex-col gap-4">
                <span
                  className="text-caption uppercase"
                  style={{ color: "var(--color-inverse-canvas)", letterSpacing: "0.24px" }}
                >
                  {col.heading}
                </span>
                <nav className="flex flex-col gap-3">
                  {col.links.map((link) => (
                    <FooterLinkItem key={link.label + link.href} link={link} />
                  ))}
                </nav>
              </div>
            ))}
          </div>
        </div>

        <div
          className="mt-14 flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between"
          style={{ borderColor: "var(--color-border-soft)" }}
        >
          <span className="text-caption" style={{ color: "var(--color-inverse-canvas)" }}>
            © 2026 Untch
          </span>
          <span className="text-caption" style={{ color: "var(--color-inverse-canvas)" }}>
            Untch never takes custody. The owner can pause or withdraw without us.
          </span>
        </div>
      </div>
    </footer>
  );
}
