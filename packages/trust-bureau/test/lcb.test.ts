import assert from "node:assert/strict";
import { test } from "node:test";
import { lcb } from "../src/lcb";
import { Z_DEFAULT } from "../src/weights";

/**
 * §12 LCB boundary cases — the enforcement primitive. These pin the exact behavior the PRD relies on:
 * no uncertainty ⇒ no discount; large uncertainty ⇒ floor; and the discount always tightens, never
 * loosens, enforcement.
 */

test("sigma = 0 ⇒ LCB equals the score exactly (no uncertainty, no discount)", () => {
  assert.equal(lcb(78, 0), 78);
  assert.equal(lcb(0, 0), 0);
  assert.equal(lcb(100, 0), 100);
  assert.equal(lcb(55.5, 0, Z_DEFAULT), 55.5);
});

test("very high sigma ⇒ LCB drops to the 0 floor (enforcement tightens automatically)", () => {
  assert.equal(lcb(90, 1000), 0);
  assert.equal(lcb(50, 80), 0, "score 50, σ 80 ⇒ 50 − 1.28·80 < 0 ⇒ clamped to 0");
});

test("LCB = score − z·σ within range, and is monotonically ≤ score for σ ≥ 0", () => {
  assert.equal(lcb(80, 10, 1.28), 80 - 1.28 * 10);
  for (const s of [10, 40, 70, 95]) {
    for (const sig of [0, 1, 5, 15]) {
      assert.ok(lcb(s, sig) <= s + 1e-9, `lcb(${s},${sig}) must be ≤ score`);
    }
  }
});

test("cold-start-shaped σ produces a conservative (but not floored) LCB when the score looks fine", () => {
  // A raw 90 with the σ a fully-missing-marketplace vendor carries (~13) still clears 70 but is pulled
  // well below the headline — the §12 "conservative LCB even when the raw score looks fine".
  const conservative = lcb(90, 13);
  assert.ok(conservative < 90 - 14, `expected a ≥14pt discount, got ${90 - conservative}`);
  assert.ok(conservative > 60, `should not be floored for a genuinely good vendor, got ${conservative}`);
});

test("rejects a negative sigma and non-finite inputs", () => {
  assert.throws(() => lcb(50, -1));
  assert.throws(() => lcb(Number.NaN, 1));
  assert.throws(() => lcb(50, Number.POSITIVE_INFINITY));
});
