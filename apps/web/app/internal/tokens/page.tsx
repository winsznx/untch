import type { CSSProperties } from "react";
import {
  colors,
  typeScale,
  spacingScale,
  layout,
  radii,
  shadows,
  elevationRules,
  type ColorToken,
  type TypeToken,
} from "@untch/design-tokens";

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

function Meta({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: mono, fontSize: 12, color: "var(--color-inverse-muted)" }}>
      {children}
    </span>
  );
}

function SectionTitle({ kicker, title }: { kicker: string; title: string }) {
  return (
    <header style={{ marginBottom: 32, borderBottom: "1px solid var(--color-border)", paddingBottom: 16 }}>
      <div style={{ fontSize: 12, letterSpacing: "0.24px", color: "var(--color-data)", marginBottom: 8 }}>
        {kicker}
      </div>
      <h2 style={{ fontSize: 46, lineHeight: 1, letterSpacing: "-1.84px", fontWeight: 600 }}>{title}</h2>
    </header>
  );
}

function typeStyle(t: TypeToken): CSSProperties {
  return {
    fontSize: t.px,
    lineHeight: t.lineHeight,
    letterSpacing: `${t.letterSpacingPx}px`,
    fontWeight: t.weight,
  };
}

function TypeRow({ t }: { t: TypeToken }) {
  return (
    <div
      style={{
        padding: "24px 0",
        borderBottom: "1px solid var(--color-border-soft)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "baseline" }}>
        <code style={{ fontFamily: mono, fontSize: 13, color: "var(--color-data)" }}>text-{t.name}</code>
        <Meta>
          {t.px}px &middot; lh {t.lineHeight} &middot; tracking {t.letterSpacingPx}px ({t.trackingEm}em) &middot; weight{" "}
          {t.weight}
        </Meta>
        {t.nameFlagged ? (
          <Meta>
            <span style={{ color: "var(--color-signal)" }}>name derived, not in reference doc</span>
          </Meta>
        ) : null}
      </div>
      <div style={{ overflowX: "auto" }}>
        <div style={typeStyle(t)}>{t.sample}</div>
      </div>
    </div>
  );
}

function TrackingCompare({ t }: { t: TypeToken }) {
  const base = typeStyle(t);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 24 }}>
      <Meta>
        text-{t.name} &middot; documented tracking {t.letterSpacingPx}px (tuned for Gilroy)
      </Meta>
      <div style={{ overflowX: "auto" }}>
        <div style={base}>{t.sample}</div>
      </div>
      <Meta>same size, tracking 0 (for comparison only)</Meta>
      <div style={{ overflowX: "auto" }}>
        <div style={{ ...base, letterSpacing: "0px" }}>{t.sample}</div>
      </div>
    </div>
  );
}

function Swatch({ c }: { c: ColorToken }) {
  const flagged = c.impiloName === "Mint Vital";
  return (
    <div
      className="rounded-cards"
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div
        style={{
          height: 72,
          borderRadius: 16,
          background: c.hex,
          border: "1px solid var(--color-border-soft)",
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{c.impiloName}</div>
        <code style={{ fontFamily: mono, fontSize: 13, color: "var(--color-inverse-canvas)" }}>{c.hex}</code>
        <Meta>{c.impiloRole}</Meta>
      </div>
      <div style={{ borderTop: "1px solid var(--color-border-soft)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 14, color: "var(--color-data)" }}>
          Untch: <strong>{c.untchSemantic}</strong>
        </div>
        <Meta>{c.untchMeaning}</Meta>
        {flagged ? (
          <div style={{ fontSize: 12, color: "var(--color-signal)" }}>
            Reinterpreted from Impilo&rsquo;s health-locked meaning. Confirm.
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <code style={{ fontFamily: mono, fontSize: 12, color: "var(--color-inverse-muted)" }}>{c.cssVar}</code>
        <code style={{ fontFamily: mono, fontSize: 12, color: "var(--color-inverse-muted)" }}>{c.semanticVar}</code>
      </div>
    </div>
  );
}

function ColorGroup({ label, group }: { label: string; group: ColorToken["group"] }) {
  const items = colors.filter((c) => c.group === group);
  return (
    <div style={{ marginBottom: 40 }}>
      <h3 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.72px", marginBottom: 16 }}>
        {label} <Meta>({items.length})</Meta>
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
        {items.map((c) => (
          <Swatch key={c.impiloName} c={c} />
        ))}
      </div>
    </div>
  );
}

export default function Specimen() {
  return (
    <main
      className="bg-canvas"
      style={{ color: "var(--color-text)", minHeight: "100vh", padding: "64px 24px" }}
    >
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 80 }}>
        <header style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 12, letterSpacing: "0.24px", color: "var(--color-data)" }}>
            UNTCH &middot; DESIGN TOKENS &middot; SPECIMEN
          </div>
          <h1 style={{ fontSize: 92, lineHeight: 0.92, letterSpacing: "-6.9px", fontWeight: 600 }}>
            Token foundation
          </h1>
          <p style={{ fontSize: 17, lineHeight: 1.44, letterSpacing: "-0.51px", maxWidth: 720, color: "var(--color-inverse-canvas)" }}>
            Every design token rendered for visual review before any component is built. Colors, the full type
            scale at real size, spacing, radii, and shadows. Nothing on this page is a product surface. Confirm it
            by eye, then components can be built on top.
          </p>
          <div
            className="rounded-cards"
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-signal)",
              padding: 20,
              maxWidth: 720,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-signal)", marginBottom: 8 }}>
              Read before reviewing type
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.44, color: "var(--color-inverse-canvas)" }}>
              The typeface is Manrope (primary) with Plus Jakarta Sans as fallback. The original spec used Gilroy,
              which was never licensed. The tracking values below were tuned for Gilroy&rsquo;s letterforms. Applied
              to Manrope they are the best available starting point, not a guaranteed match. Judge the large sizes
              carefully. The tracking check further down shows each display size with and without the tracking so
              you can see the effect.
            </p>
          </div>
        </header>

        <section>
          <SectionTitle kicker="01 / TYPOGRAPHY" title="Type scale" />
          <div>
            {typeScale.map((t) => (
              <TypeRow key={t.name} t={t} />
            ))}
          </div>
        </section>

        <section>
          <SectionTitle kicker="02 / TYPOGRAPHY" title="Tracking check" />
          <p style={{ fontSize: 14, lineHeight: 1.44, color: "var(--color-inverse-canvas)", marginBottom: 32, maxWidth: 720 }}>
            The negative tracking is the part most at risk from the Gilroy to Manrope substitution. Compare the
            documented value against zero tracking at the two display sizes.
          </p>
          <TrackingCompare t={typeScale[0]!} />
          <TrackingCompare t={typeScale[1]!} />
        </section>

        <section>
          <SectionTitle kicker="03 / COLOR" title="Palette" />
          <p style={{ fontSize: 14, lineHeight: 1.44, color: "var(--color-inverse-canvas)", marginBottom: 32, maxWidth: 720 }}>
            Fifteen tokens. Each carries its original Impilo name and hex, plus the Untch semantic meaning it maps
            to. Components can reference either the raw token or the semantic alias.
          </p>
          <ColorGroup label="Brand violets" group="brand" />
          <ColorGroup label="Accents" group="accent" />
          <ColorGroup label="Neutrals" group="neutral" />
        </section>

        <section>
          <SectionTitle kicker="04 / GEOMETRY" title="Border radius" />
          <p style={{ fontSize: 14, lineHeight: 1.44, color: "var(--color-inverse-canvas)", marginBottom: 32, maxWidth: 720 }}>
            Canonical integer values only. The earlier CSS export carried fractional artifacts from a rounding pass;
            those are not used here.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 20 }}>
            {radii.map((r) => (
              <div key={r.name} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div
                  style={{
                    height: 96,
                    background: "var(--color-surface-raised)",
                    border: "1px solid var(--color-border)",
                    borderRadius: r.px,
                  }}
                />
                <div style={{ fontSize: 14, fontWeight: 600 }}>{r.name}</div>
                <code style={{ fontFamily: mono, fontSize: 13, color: "var(--color-data)" }}>
                  {r.px === 9999 ? "9999px (full pill)" : `${r.px}px`}
                </code>
                <Meta>{r.role}</Meta>
                {r.replacesArtifact ? <Meta>replaces artifact {r.replacesArtifact}</Meta> : null}
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionTitle kicker="05 / ELEVATION" title="Shadow and elevation" />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginBottom: 32 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
              <div
                className="shadow-cta-glow rounded-buttons"
                style={{ background: "var(--color-action)", color: "var(--color-text)", padding: "16px 24px", fontSize: 17 }}
              >
                Create a spend policy
              </div>
              <code style={{ fontFamily: mono, fontSize: 13, color: "var(--color-data)" }}>shadow-cta-glow</code>
              <Meta>{shadows[0]!.value}</Meta>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
              <div
                className="rounded-cards"
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  padding: 24,
                  minWidth: 220,
                  color: "var(--color-inverse-canvas)",
                  fontSize: 14,
                }}
              >
                Data card, no box-shadow
              </div>
              <code style={{ fontFamily: mono, fontSize: 13, color: "var(--color-data)" }}>no shadow</code>
              <Meta>depth from tonal fill, not shadow</Meta>
            </div>
          </div>
          <ul style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 0, listStyle: "none" }}>
            {elevationRules.map((rule) => (
              <li key={rule} style={{ fontSize: 14, lineHeight: 1.44, color: "var(--color-inverse-canvas)" }}>
                &middot; {rule}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <SectionTitle kicker="06 / SPACING" title="Spacing scale" />
          <p style={{ fontSize: 14, lineHeight: 1.44, color: "var(--color-inverse-canvas)", marginBottom: 32, maxWidth: 720 }}>
            Base unit 4px. The curated scale below reaches every design value; in Tailwind these are the standard
            4px-step utilities (8px is space-2, 24px is space-6, 116px is space-29).
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 40 }}>
            {spacingScale.map((v) => (
              <div key={v} style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <code style={{ fontFamily: mono, fontSize: 13, width: 64, color: "var(--color-inverse-muted)" }}>
                  {v}px
                </code>
                <div style={{ height: 16, width: v, background: "var(--color-data)", borderRadius: 4 }} />
              </div>
            ))}
          </div>
          <h3 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.72px", marginBottom: 16 }}>Layout tokens</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
            {[
              { name: "page max-width", value: `${layout.pageMaxWidth}px`, token: "--container-page" },
              { name: "section gap", value: `${layout.sectionGap}px`, token: "--spacing-section" },
              { name: "card padding", value: `${layout.cardPadding}px`, token: "--spacing-card" },
              { name: "element gap", value: `${layout.elementGap}px`, token: "--spacing-element" },
            ].map((l) => (
              <div
                key={l.name}
                className="rounded-inputs"
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", padding: 16 }}
              >
                <div style={{ fontSize: 14, fontWeight: 600 }}>{l.name}</div>
                <code style={{ fontFamily: mono, fontSize: 13, color: "var(--color-data)" }}>{l.value}</code>
                <div>
                  <Meta>{l.token}</Meta>
                </div>
              </div>
            ))}
          </div>
        </section>

        <footer style={{ borderTop: "1px solid var(--color-border)", paddingTop: 24 }}>
          <Meta>
            Source of truth: packages/design-tokens/src/tokens.ts &middot; Tailwind theme: @untch/design-tokens/theme.css
            (generated) &middot; Reconciliation: internal/untch-design-reference.md §4b/§4c
          </Meta>
        </footer>
      </div>
    </main>
  );
}
