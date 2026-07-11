# @untch/design-tokens

The single source of truth for Untch's visual foundation: colors, the typography
scale, spacing, radii, and shadows. Tokens only. No components, no landing page, no
dashboard. Those get built on top of this once the specimen page below has been
reviewed by eye and confirmed.

The tokens are adopted from the Impilo style reference (`internal/design.md` plus
`internal/designguide.md`) and reconciled per the owner-signed decisions in
`internal/untch-design-reference.md` §4b and §4c.

## How it is structured

- `src/tokens.ts` is authoritative. Every value lives here as a typed manifest.
- `theme.css` is generated from `tokens.ts` by `src/gen-theme.ts`. It is a Tailwind v4
  `@theme static` block. Do not hand-edit it. Change `tokens.ts` and run
  `pnpm --filter @untch/design-tokens gen:theme`.
- Because both the utilities and the specimen render from one manifest, what you see on
  the specimen page is exactly what components receive. There is no second copy to drift.

`@theme static` is used on purpose: a foundation is meant to be referenced, so every
token variable is always emitted to `:root` and stays reachable by raw `var(...)` even
where Tailwind cannot scan for usage (inline styles, JS). It is not tree-shaken.

Every color is referenceable two ways:

- the raw Impilo token, for example `--color-deep-iris` / `bg-deep-iris`
- the Untch semantic alias, for example `--color-canvas` / `bg-canvas`

## Font substitution and its caveat (read this)

The design reference specifies Gilroy. Gilroy was never licensed, so it is not used.

- Primary: **Manrope**, the reference doc's own stated free substitute.
- Fallback: **Plus Jakarta Sans**, the documented secondary.

Both are loaded with `next/font` (self-hosted, subset, `display: swap`). There are no
runtime external font requests. The build fetches the files once and serves them from
`/_next/static/media`.

Caveat, stated plainly and carried forward from the task brief: the tracking
(letter-spacing) values in the scale below were tuned for Gilroy's letterforms. Manrope
has different glyph shapes and spacing. The values are implemented exactly as documented
because they are the best available starting point, but they are not a guaranteed match.
The large display sizes are where this shows most. The specimen page renders the whole
scale at real size and includes a tracking check (each display size with the documented
tracking and with zero tracking) so a human can judge the fit before anything is built on
top. If the negative tracking reads as too tight on Manrope, adjust the values in
`tokens.ts` and regenerate. That is the one thing this checkpoint exists to catch.

## Typography scale (settled)

Eleven sizes, matching the reference doc's own size list. Line-heights are design.md's
canonical values. Weights follow §4c: 600 for display, headings, and `title-sm`; 500 for
all small text. `heading-sm` was renamed to `title-sm` to remove the naming trap (it was
never a headline by the system's own line-height logic).

| Role | Size | Line height | Tracking | Weight | Tier |
|------|------|-------------|----------|--------|------|
| display-xl | 124px | 0.92 | -9.3px | 600 | display |
| display | 92px | 0.92 | -6.9px | 600 | display |
| heading-xl | 66px | 1.00 | -2.64px | 600 | heading |
| heading-lg | 54px | 1.00 | -2.16px | 600 | heading |
| heading | 46px | 1.00 | -1.84px | 600 | heading |
| title-sm | 24px | 1.44 | -0.72px | 600 | body |
| subheading | 18px | 1.44 | -0.54px | 500 | body |
| body | 17px | 1.44 | -0.51px | 500 | body |
| body-sm | 14px | 1.44 | 0.28px | 500 | body |
| caption-lg | 13px | 1.44 | 0.26px | 500 | body |
| caption | 12px | 1.44 | 0.24px | 500 | body |

In Tailwind these are `text-display-xl` down to `text-caption`. Each utility carries its
size, line-height, letter-spacing, and font-weight together.

## Color semantic remapping

Fifteen tokens. Each keeps its original Impilo name and hex (used byte-for-byte per §4b)
and maps to an Untch semantic meaning in Untch's own vocabulary (policies, receipts,
trust, agents, chain), never healthcare.

| Impilo name | Hex | Impilo role | Untch semantic | Untch meaning |
|-------------|-----|-------------|----------------|---------------|
| Deep Iris | `#16165c` | Page canvas, primary surface | `canvas` | Base app and dashboard background |
| Iris Shadow | `#232269` | Elevated card surfaces | `surface` | Raised panel: intent stream, escalation inbox, ledger card |
| Iris Glow | `#403cd5` | Mid-tone accent, footer, metric blocks | `surface-raised` | Highlighted block: blocked-waste widget, footer, key metric fill |
| Iris Pulse | `#5350cc` | Filled buttons, selected nav | `action` | Primary filled action and active state |
| Iris Border | `#4846c6` | Card border outlines | `border` | Card hairline outline on the dark canvas |
| Iris Veil | `#524fe1` | Secondary border accent | `border-soft` | Secondary hairline separator |
| Lilac Mist | `#b1a6f6` | Line-art illustration stroke | `illustration` | Line-art stroke for vault, agent, and chain motifs (not medical devices, per §4c) |
| Clinical Cyan | `#00b1ff` | Data, links, chart strokes | `data` | Receipt and chain data, inline links, chart strokes, interactive borders |
| Cyan Soft | `#59b4ff` | Secondary cyan accent | `data-soft` | Secondary data accent, softer labels |
| Mint Vital | `#00ffaa` | Positive accent (health-locked) | `positive` | Cleared, verified, approved states. Never error. See Open flag |
| Teal Signal | `#2ee9ff` | Key data callout emphasis | `signal` | Headline metric that needs to pop |
| Cloud White | `#ffffff` | Primary text on dark, button text | `text` | Primary text on the dark canvas |
| Pearl | `#f4f4f6` | Light-section background, low-emphasis text | `inverse-canvas` | Light-section background; also low-emphasis body text on dark |
| Ash | `#d8d8e3` | Muted text and borders on light | `inverse-muted` | Muted text and secondary borders in light sections |
| Fog | `#9494a9` | Hairline dividers, disabled borders | `divider` | Dividers, disabled borders, low-contrast separators |

## Spacing

Base unit is 4px, which is Tailwind's default spacing step, so the design's curated
values map straight onto the standard numeric utilities: 8px is `space-2`, 24px is
`space-6`, 116px is `space-29`, 220px is `space-55`. The curated scale is
`8, 12, 16, 20, 24, 32, 36, 40, 48, 116, 220` (px).

Four layout values ship as named tokens: `--container-page` (1200px),
`--spacing-section` (80px), `--spacing-card` (24px), `--spacing-element` (8px).

## Border radius: canonical values only

Confirmed: nothing here uses a fractional value. The original Impilo CSS export carried
fractional artifacts from a rem-rounding pass. The design's named table states the true
integer values, which are the ones used. The specimen labels each canonical radius with
the artifact it replaces so this can be checked directly.

| Token | Canonical | Fractional artifact not used | Role |
|-------|-----------|------------------------------|------|
| `--radius-icons` | 7px | 6.9984px | Icon containers |
| `--radius-inputs` | 16px | 15.9984px | Inputs |
| `--radius-cards` | 24px | 24.0048px | Cards |
| `--radius-cards-elevated` | 32px | 31.9968px | Elevated cards |
| `--radius-tags` | 9999px | 1425.6px | Tags (full pill) |
| `--radius-buttons` | 9999px | 1425.6px | Buttons (full pill) |

## Shadow and elevation

Depth comes from tonal violet surfaces and hairline borders, not drop shadows. Cards
carry no box-shadow. The only shadow in the system is the primary CTA's ambient violet
glow: `--shadow-cta-glow: 0 0 20px rgba(60, 57, 185, 0.4)` (`shadow-cta-glow`). The
elevation rules are listed on the specimen and in `tokens.ts` (`elevationRules`).

## Open flag (not specified by the reference doc, do not treat as settled)

The reference doc gives the remapping principle (§4b, tokens byte-for-byte with Untch's
own vocabulary; §4c, medical motifs swapped for vault, agent, and chain) but it does not
contain an explicit per-color semantic table or names for the two folded-in type rows.
Two things below are therefore a conservative derivation, flagged for owner confirmation
rather than presented as settled:

1. **The Untch semantic labels for each color.** These apply the §4b principle to each
   Impilo role. Most translate directly. The one that needs a real decision is **Mint
   Vital**: in Impilo its meaning is locked to positive health signals, which does not
   exist in Untch. It is mapped to `positive` (cleared, verified, approved), never error.
   Confirm this reading.
2. **The names `body` (17px) and `caption-lg` (13px).** §4c folds these two rows in but
   does not name them. `body` is taken from design.md's own repeated "body at 17px"
   usage. `caption-lg` is a descriptive name for the 13px caption-tier size. The specimen
   marks both as "name derived, not in reference doc." Rename in `tokens.ts` if preferred.

## Stack

No Next.js, React, or Tailwind pin existed anywhere in this repo before this work, so
there was no prior convention to match. The current stable line is pinned:

- Next.js `16.2.10` (latest stable; past the CVE-2025-29927 middleware-bypass line)
- React / React DOM `19.2.7`
- Tailwind CSS `4.3.2` (v4, which matches the design export's `@theme` format)

`pnpm audit --prod` reports no known vulnerabilities. One transitive `postcss` advisory
(pulled in by Next's own tree, a build-time CSS-stringify issue) is force-patched to
`>=8.5.16` via `pnpm.overrides` in the root `package.json`.

## Viewing the specimen

The specimen page renders every token for visual review. It is at the root of the web
app.

```
pnpm install
pnpm --filter @untch/web dev
# open http://localhost:3000
```

Or build and serve the production output:

```
pnpm --filter @untch/web build
pnpm --filter @untch/web start
# open http://localhost:3000
```
