/**
 * @untch/design-tokens: the single source of truth for Untch's visual foundation
 * (colors, typography scale, spacing, radii, shadows). Adopted from the Impilo style
 * reference and reconciled per internal/untch-design-reference.md §4b/§4c.
 *
 * Consumers import the typed manifest from here; Tailwind consumers import
 * "@untch/design-tokens/theme.css" (generated from this manifest by gen-theme).
 */
export * from "./tokens";
