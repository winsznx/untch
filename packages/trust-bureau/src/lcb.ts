import { Z_DEFAULT } from "./weights";

/**
 * The §12 enforcement primitive: the lower-confidence bound LCB = score − z·σ, clamped to the [0,100]
 * score range. Enforcement reads the LCB, NEVER the raw score — a high score with high uncertainty
 * must not clear a floor a low-uncertainty score of the same value would.
 *
 * Boundary behavior this function guarantees (and the tests pin):
 *   • σ = 0            ⇒ LCB = score exactly (no uncertainty ⇒ no discount).
 *   • very large σ     ⇒ LCB drops to the 0 floor (enforcement tightens automatically toward block).
 *   • cold-start       ⇒ the wide σ the renormalization injects pulls the LCB well below the raw score
 *                        even when the score itself looks fine — a conservative, not a punitive, floor.
 */
export function lcb(score: number, sigma: number, z: number = Z_DEFAULT): number {
  if (!Number.isFinite(score) || !Number.isFinite(sigma) || !Number.isFinite(z)) {
    throw new Error(`lcb: non-finite input (score=${score}, sigma=${sigma}, z=${z})`);
  }
  if (sigma < 0) throw new Error(`lcb: sigma must be ≥ 0, got ${sigma}`);
  const raw = score - z * sigma;
  return clamp01to100(raw);
}

/** Clamp a value into the [0,100] score range. */
export function clamp01to100(v: number): number {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}
