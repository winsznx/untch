import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";

export const metadata: Metadata = {
  title: "Untch header / nav — review",
  description: "Visual review page for the Untch site header / navigation component.",
};

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

type Decision = {
  n: string;
  title: string;
  flag: "FAITHFUL TO SPEC" | "NEW DECISION — CONFIRM";
  body: string;
};

const DECISIONS: Decision[] = [
  {
    n: "1",
    title: "Logo",
    flag: "FAITHFUL TO SPEC",
    body: "Seal-gate mark (white ring + clinical cyan aperture) from internal/brand, served as /untch-logo.png, plus text wordmark at title-sm (24px / 600). Same mark on mobile and desktop.",
  },
  {
    n: "2",
    title: "Nav links",
    flag: "NEW DECISION — CONFIRM",
    body: "Product, Receipts, Docs, Pricing. Grounded in what is true about Untch: the product, the public receipts explorer (S6), Mintlify docs, and real per-call plus audit-SKU pricing. Hrefs are structural. The destination pages are not built yet.",
  },
  {
    n: "3",
    title: "Primary CTA",
    flag: "NEW DECISION — CONFIRM",
    body: "\"Create a spend policy\" — the PRD's own canonical primary CTA — replacing Impilo's \"Request Demo\" (Untch has no demo-booking flow). Points at /dashboard.",
  },
  {
    n: "4",
    title: "Mobile collapse",
    flag: "NEW DECISION — CONFIRM",
    body: "Below 768px the center links and CTA collapse into a hamburger menu built from the same tokens (Deep Iris surface, hairline border, pill CTA). Resize the window under 768px, or narrow it, to see it work.",
  },
  {
    n: "5",
    title: "Motion",
    flag: "NEW DECISION — CONFIRM",
    body: "Snappy 150ms transitions consistent with the sparse, hard-cut aesthetic: nav links lift on hover (opacity), the CTA lifts on hover (brightness), the menu opens with a quick fade-and-slide. Reduced-motion preference is respected.",
  },
  {
    n: "—",
    title: "Bar frame",
    flag: "FAITHFUL TO SPEC",
    body: "Deep Iris canvas background, 80px height, logo left, center links, pill CTA right, body-role link text, 9999px pill on the CTA, no shadow on the nav pill. All taken directly from design.md and the do/don't list.",
  },
];

function ReviewPanel() {
  return (
    <div
      className="rounded-cards"
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-signal)",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-signal)", letterSpacing: "0.28px" }}>
        WHAT TO REVIEW — five open decisions, flagged, plus the faithful frame
      </div>
      <p style={{ fontSize: 14, lineHeight: 1.44, color: "var(--color-inverse-canvas)" }}>
        Impilo&rsquo;s spec covers the bar frame but answers none of the five items below. Each is a real,
        reasoned proposal for confirmation, not something silently invented and presented as if specified.
        The same list is in <code style={{ fontFamily: mono, fontSize: 13, color: "var(--color-data)" }}>apps/web/README.md</code>.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {DECISIONS.map((d) => {
          const isNew = d.flag === "NEW DECISION — CONFIRM";
          return (
            <div
              key={d.title}
              className="rounded-inputs"
              style={{
                background: "var(--color-canvas)",
                border: "1px solid var(--color-border)",
                padding: 16,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "baseline" }}>
                <span style={{ fontSize: 18, fontWeight: 600 }}>
                  {d.n === "—" ? "" : `${d.n}. `}
                  {d.title}
                </span>
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 12,
                    letterSpacing: "0.24px",
                    color: isNew ? "var(--color-signal)" : "var(--color-positive)",
                  }}
                >
                  {d.flag}
                </span>
              </div>
              <p style={{ fontSize: 14, lineHeight: 1.44, color: "var(--color-inverse-canvas)" }}>{d.body}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function HeaderReview() {
  return (
    <>
      <SiteHeader />

      <main style={{ color: "var(--color-text)" }}>
        <div
          style={{
            maxWidth: 1200,
            margin: "0 auto",
            padding: "80px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 80,
          }}
        >
          {/* Placeholder page body for header review only — NOT the hero component.
              Copy is the PRD's real website hero, used so nothing here reads as filler. */}
          <section style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <div style={{ fontSize: 12, letterSpacing: "0.24px", color: "var(--color-data)" }}>
              UNTCH &middot; COMPONENT REVIEW &middot; HEADER / NAV
            </div>
            <h1 style={{ fontSize: 66, lineHeight: 1, letterSpacing: "-2.64px", fontWeight: 600, maxWidth: 900 }}>
              Autonomous agents can spend. Untch keeps the money under control.
            </h1>
            <p
              style={{
                fontSize: 18,
                lineHeight: 1.44,
                letterSpacing: "-0.54px",
                maxWidth: 720,
                color: "var(--color-inverse-canvas)",
              }}
            >
              Give every agent a budget, a policy, a proof requirement, and a receipt trail. Untch checks every
              payment before it moves and anchors every decision on X Layer.
            </p>
            <p style={{ fontSize: 13, lineHeight: 1.44, color: "var(--color-inverse-muted)", fontFamily: mono }}>
              This text is placeholder page body, present only so the header can be reviewed in context. It is not
              the hero component and no other component is built here yet.
            </p>
          </section>

          <ReviewPanel />

          {/* Scroll room so the sticky bar behaviour is observable. */}
          <section style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <h2 style={{ fontSize: 46, lineHeight: 1, letterSpacing: "-1.84px", fontWeight: 600 }}>
              Scroll to check the sticky bar
            </h2>
            {[
              "No policy, no payment.",
              "Agent money, untouched until cleared.",
              "Every agent payment, checked before it moves.",
              "Where autonomous spend gets cleared.",
              "Funds stay untouched until the rules pass.",
            ].map((line) => (
              <p
                key={line}
                style={{
                  fontSize: 24,
                  lineHeight: 1.44,
                  letterSpacing: "-0.72px",
                  fontWeight: 600,
                  color: "var(--color-inverse-canvas)",
                  paddingBottom: 48,
                  borderBottom: "1px solid var(--color-border-soft)",
                }}
              >
                {line}
              </p>
            ))}
          </section>
        </div>
      </main>
    </>
  );
}
