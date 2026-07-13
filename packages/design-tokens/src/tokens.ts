/**
 * Untch design tokens. The single source of truth.
 *
 * Values are adopted byte-for-byte from the Impilo style reference
 * (internal/design.md + internal/designguide.md), reconciled per the
 * owner-signed decisions in internal/untch-design-reference.md §4b/§4c:
 *   - design.md line-heights are canonical
 *   - designguide.md's extra 17px and 13px rows are folded in
 *   - heading-sm renamed to title-sm at weight 600; small text at weight 500
 *
 * theme.css (the Tailwind v4 @theme block) is GENERATED from this file by
 * src/gen-theme.ts. Never hand-edit theme.css; edit here and regenerate.
 *
 * The `untchSemantic` fields apply the reference doc's remapping PRINCIPLE
 * (§4b: tokens byte-for-byte, Untch's own vocabulary, medical motifs swapped
 * for vault/agent/chain per §4c). The reference doc does not contain an
 * explicit per-color semantic table, so these labels are a conservative
 * derivation flagged for owner confirmation. See README, "Open flag".
 */

export interface ColorToken {
  impiloName: string;
  hex: string;
  impiloRole: string;
  cssVar: string;
  semanticVar: string;
  untchSemantic: string;
  untchMeaning: string;
  group: "brand" | "accent" | "neutral";
}

export const colors: ColorToken[] = [
  {
    impiloName: "Deep Iris",
    hex: "#16165c",
    impiloRole: "Page canvas, hero background, primary surface",
    cssVar: "--color-deep-iris",
    semanticVar: "--color-canvas",
    untchSemantic: "canvas",
    untchMeaning: "Base app surface: page and dashboard background",
    group: "brand",
  },
  {
    impiloName: "Iris Shadow",
    hex: "#232269",
    impiloRole: "Elevated card surfaces on dark canvas",
    cssVar: "--color-iris-shadow",
    semanticVar: "--color-surface",
    untchSemantic: "surface",
    untchMeaning: "Raised panel: intent stream, escalation inbox, ledger card",
    group: "neutral",
  },
  {
    impiloName: "Iris Glow",
    hex: "#403cd5",
    impiloRole: "Mid-tone accent surface, footer background, highlighted metric blocks",
    cssVar: "--color-iris-glow",
    semanticVar: "--color-surface-raised",
    untchSemantic: "surface-raised",
    untchMeaning: "Highlighted block: blocked-waste widget, footer, key metric fill",
    group: "brand",
  },
  {
    impiloName: "Iris Pulse",
    hex: "#5350cc",
    impiloRole: "Filled buttons, selected navigation, focused conversion moments",
    cssVar: "--color-iris-pulse",
    semanticVar: "--color-action",
    untchSemantic: "action",
    untchMeaning: "Primary filled action and active state: Create a spend policy",
    group: "brand",
  },
  {
    impiloName: "Iris Border",
    hex: "#4846c6",
    impiloRole: "Card border outlines, subtle surface edges on dark mode",
    cssVar: "--color-iris-border",
    semanticVar: "--color-border",
    untchSemantic: "border",
    untchMeaning: "Card hairline outline on the dark canvas",
    group: "brand",
  },
  {
    impiloName: "Iris Veil",
    hex: "#524fe1",
    impiloRole: "Body and card border accent, secondary surface outline",
    cssVar: "--color-iris-veil",
    semanticVar: "--color-border-soft",
    untchSemantic: "border-soft",
    untchMeaning: "Secondary hairline separator, lighter than the card border",
    group: "brand",
  },
  {
    impiloName: "Lilac Mist",
    hex: "#b1a6f6",
    impiloRole: "Line-art illustration stroke, decorative SVG fills, wireframe graphics",
    cssVar: "--color-lilac-mist",
    semanticVar: "--color-illustration",
    untchSemantic: "illustration",
    untchMeaning: "Line-art stroke; vault, agent, and chain motifs (not medical devices, per §4c)",
    group: "accent",
  },
  {
    impiloName: "Clinical Cyan",
    hex: "#00b1ff",
    impiloRole: "Data highlights, chart strokes, icon accents, inline links, interactive borders",
    cssVar: "--color-clinical-cyan",
    semanticVar: "--color-data",
    untchSemantic: "data",
    untchMeaning: "Receipt and chain data, chart strokes, inline links, interactive borders",
    group: "accent",
  },
  {
    impiloName: "Cyan Soft",
    hex: "#59b4ff",
    impiloRole: "Secondary cyan accent, softer data labels, gradient endpoints",
    cssVar: "--color-cyan-soft",
    semanticVar: "--color-data-soft",
    untchSemantic: "data-soft",
    untchMeaning: "Secondary data accent, softer labels paired with data",
    group: "accent",
  },
  {
    impiloName: "Mint Vital",
    hex: "#00ffaa",
    impiloRole: "Green outline accent for tags, dividers, focused UI edges (locked to positive, never error)",
    cssVar: "--color-mint-vital",
    semanticVar: "--color-positive",
    untchSemantic: "positive",
    untchMeaning: "Cleared / verified / approved states: policy passed, delivery verified. Never error (reinterpreted from Impilo's health-locked meaning, confirm)",
    group: "accent",
  },
  {
    impiloName: "Teal Signal",
    hex: "#2ee9ff",
    impiloRole: "Highlight accent for key data callouts and chart emphasis",
    cssVar: "--color-teal-signal",
    semanticVar: "--color-signal",
    untchSemantic: "signal",
    untchMeaning: "Key data callout that needs to pop: headline metric emphasis",
    group: "accent",
  },
  {
    impiloName: "Cloud White",
    hex: "#ffffff",
    impiloRole: "Primary text on dark, button text, high-contrast headings, button fills in light sections",
    cssVar: "--color-cloud-white",
    semanticVar: "--color-text",
    untchSemantic: "text",
    untchMeaning: "Primary text on the dark canvas and button text",
    group: "neutral",
  },
  {
    impiloName: "Pearl",
    hex: "#f4f4f6",
    impiloRole: "Light-section background (inversion), soft icon strokes, low-emphasis body text on dark",
    cssVar: "--color-pearl",
    semanticVar: "--color-inverse-canvas",
    untchSemantic: "inverse-canvas",
    untchMeaning: "Light-section background; also low-emphasis body text on the dark canvas",
    group: "neutral",
  },
  {
    impiloName: "Ash",
    hex: "#d8d8e3",
    impiloRole: "Muted text on light sections, secondary borders, low-emphasis labels",
    cssVar: "--color-ash",
    semanticVar: "--color-inverse-muted",
    untchSemantic: "inverse-muted",
    untchMeaning: "Muted text and secondary borders inside light sections",
    group: "neutral",
  },
  {
    impiloName: "Fog",
    hex: "#9494a9",
    impiloRole: "Hairline dividers, disabled borders, low-contrast separators",
    cssVar: "--color-fog",
    semanticVar: "--color-divider",
    untchSemantic: "divider",
    untchMeaning: "Hairline dividers, disabled borders, low-contrast separators",
    group: "neutral",
  },
];

export type TypeTier = "display" | "heading" | "body";

export interface TypeToken {
  name: string;
  px: number;
  lineHeight: number;
  letterSpacingPx: number;
  trackingEm: number;
  weight: 500 | 600;
  tier: TypeTier;
  sample: string;
  /** true when the reference doc folds the row in without naming it (name is our derivation) */
  nameFlagged?: boolean;
}

/**
 * Full settled scale. 11 sizes, matching design.md's font "Sizes" list exactly:
 * 12, 13, 14, 17, 18, 24, 46, 54, 66, 92, 124.
 *
 * Line-heights: design.md canonical (1.44 body / 1.00 heading / 0.92 display).
 * Tracking: from design.md's letter-spacing buckets:
 *   +0.0200em (12-14) / -0.0300em (17-24) / -0.0400em (46-66) / -0.0750em (92+).
 * Weights: 600 for display, headings, and title-sm (§4c); 500 for all small text.
 *
 * CAVEAT: these tracking values were tuned for Gilroy's letterforms. Applied to
 * Manrope they are the best available starting point, not guaranteed correct.
 * The specimen page renders them at size so a human can verify by eye.
 */
export const typeScale: TypeToken[] = [
  {
    name: "display-xl",
    px: 124,
    lineHeight: 0.92,
    letterSpacingPx: -9.3,
    trackingEm: -0.075,
    weight: 600,
    tier: "display",
    sample: "Untch",
  },
  {
    name: "display",
    px: 92,
    lineHeight: 0.92,
    letterSpacingPx: -6.9,
    trackingEm: -0.075,
    weight: 600,
    tier: "display",
    sample: "The model never touches the money.",
  },
  {
    name: "heading-xl",
    px: 66,
    lineHeight: 1,
    letterSpacingPx: -2.64,
    trackingEm: -0.04,
    weight: 600,
    tier: "heading",
    sample: "Autonomous agents can spend.",
  },
  {
    name: "heading-lg",
    px: 54,
    lineHeight: 1,
    letterSpacingPx: -2.16,
    trackingEm: -0.04,
    weight: 600,
    tier: "heading",
    sample: "Untch keeps the money under control.",
  },
  {
    name: "heading",
    px: 46,
    lineHeight: 1,
    letterSpacingPx: -1.84,
    trackingEm: -0.04,
    weight: 600,
    tier: "heading",
    sample: "Every agent payment, checked before it moves.",
  },
  {
    name: "title-sm",
    px: 24,
    lineHeight: 1.44,
    letterSpacingPx: -0.72,
    trackingEm: -0.03,
    weight: 600,
    tier: "body",
    sample: "Create a spend policy",
  },
  {
    name: "subheading",
    px: 18,
    lineHeight: 1.44,
    letterSpacingPx: -0.54,
    trackingEm: -0.03,
    weight: 500,
    tier: "body",
    sample: "Give every agent a budget, a policy, a proof requirement, and a receipt trail.",
  },
  {
    name: "body",
    px: 17,
    lineHeight: 1.44,
    letterSpacingPx: -0.51,
    trackingEm: -0.03,
    weight: 500,
    tier: "body",
    sample: "Untch checks every payment before it moves and anchors every decision on X Layer.",
    nameFlagged: true,
  },
  {
    name: "body-sm",
    px: 14,
    lineHeight: 1.44,
    letterSpacingPx: 0.28,
    trackingEm: 0.02,
    weight: 500,
    tier: "body",
    sample: "Funds stay untouched until the rules pass.",
  },
  {
    name: "caption-lg",
    px: 13,
    lineHeight: 1.44,
    letterSpacingPx: 0.26,
    trackingEm: 0.02,
    weight: 500,
    tier: "body",
    sample: "Policy passed. Vendor trusted. Not a duplicate.",
    nameFlagged: true,
  },
  {
    name: "caption",
    px: 12,
    lineHeight: 1.44,
    letterSpacingPx: 0.24,
    trackingEm: 0.02,
    weight: 500,
    tier: "body",
    sample: "No policy, no payment.",
  },
];

/** Curated spacing values from design.md (base unit 4px). Reachable via Tailwind's
 *  default 4px numeric scale, e.g. 8px = space-2, 24px = space-6, 116px = space-29. */
export const spacingScale: number[] = [8, 12, 16, 20, 24, 32, 36, 40, 48, 116, 220];

export const layout = {
  pageMaxWidth: 1200,
  sectionGap: 80,
  cardPadding: 24,
  elementGap: 8,
} as const;

export interface RadiusToken {
  name: string;
  px: number;
  cssVar: string;
  role: string;
  /** the fractional artifact this canonical value replaces (comprehension-report leftover) */
  replacesArtifact?: string;
}

/**
 * Canonical radii only. The original Impilo CSS export carried fractional
 * artifacts (6.9984px, 15.9984px, 24.0048px, 31.9968px, 1425.6px) from a
 * rem-rounding pass; the design's named table states the true integer values,
 * which are the ones used here.
 */
export const radii: RadiusToken[] = [
  { name: "icons", px: 7, cssVar: "--radius-icons", role: "Icon containers", replacesArtifact: "6.9984px" },
  { name: "inputs", px: 16, cssVar: "--radius-inputs", role: "Inputs", replacesArtifact: "15.9984px" },
  { name: "cards", px: 24, cssVar: "--radius-cards", role: "Cards", replacesArtifact: "24.0048px" },
  {
    name: "cards-elevated",
    px: 32,
    cssVar: "--radius-cards-elevated",
    role: "Elevated cards",
    replacesArtifact: "31.9968px",
  },
  { name: "tags", px: 9999, cssVar: "--radius-tags", role: "Tags (full pill)", replacesArtifact: "1425.6px" },
  { name: "buttons", px: 9999, cssVar: "--radius-buttons", role: "Buttons (full pill)", replacesArtifact: "1425.6px" },
];

export interface ShadowToken {
  name: string;
  cssVar: string;
  value: string;
  role: string;
}

/**
 * Elevation model: depth comes from tonal violet surfaces and hairline borders,
 * NOT drop shadows. Cards carry no box-shadow. The single shadow token is the
 * primary CTA's ambient violet glow (#3c39b9 at 40%).
 */
export const shadows: ShadowToken[] = [
  {
    name: "cta-glow",
    cssVar: "--shadow-cta-glow",
    value: "0 0 20px rgba(60, 57, 185, 0.4)",
    role: "Primary CTA button ambient glow (the only shadow in the system)",
  },
];

export const elevationRules = [
  "Dashboard / data cards: no box-shadow. Depth is the lighter violet fill against the deeper canvas.",
  "Highlighted metric block: 1px Iris Border (#4846c6) hairline, no shadow.",
  "Navigation pill button: no shadow on the dark canvas.",
  "Primary CTA button: the cta-glow ambient violet glow, never a neutral drop shadow.",
] as const;

export const fontStack =
  'var(--font-manrope), var(--font-plus-jakarta), ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
