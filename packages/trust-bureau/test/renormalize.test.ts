import assert from "node:assert/strict";
import { test } from "node:test";
import { renormalize, type RenormalizeInput } from "../src/renormalize";
import { COLD_START_PRIOR_STD, VENDOR_FEATURES } from "../src/weights";

/**
 * The §12 "Data-source fallback" math — the part the task insists is implemented for real, not skipped:
 * cold-start features are renormalized OUT of the point estimate and σ is widened by a term proportional
 * to the weight that was renormalized away.
 */

function vendorInputs(realValue: number, realSigma: number): RenormalizeInput[] {
  return VENDOR_FEATURES.map((f) => ({
    key: f.key,
    value: realValue,
    sigma: realSigma,
    baseWeight: f.baseWeight,
    observed: f.real,
  }));
}

test("real feature weights renormalize to sum to 1 over observed; cold-start get weight 0", () => {
  const out = renormalize(vendorInputs(80, 4));
  const realKeys = VENDOR_FEATURES.filter((f) => f.real).map((f) => f.key);
  const coldKeys = VENDOR_FEATURES.filter((f) => !f.real).map((f) => f.key);

  const realWeightSum = realKeys.reduce((s, k) => s + out.weightApplied[k]!, 0);
  assert.ok(Math.abs(realWeightSum - 1) < 1e-9, `renormalized real weights must sum to 1, got ${realWeightSum}`);
  for (const k of coldKeys) assert.equal(out.weightApplied[k], 0, `${k} must be renormalized out`);

  // track_record_depth base 0.20 over real weight 0.65 ⇒ 0.3077…
  assert.ok(Math.abs(out.weightApplied["track_record_depth"]! - 0.2 / 0.65) < 1e-9);
});

test("renormalizing three cold-start features away injects the exact §12 missing-signal variance", () => {
  const out = renormalize(vendorInputs(80, 4));
  // W_missing = 0.35 of 1.0 total ⇒ fMissing = 0.35.
  assert.ok(Math.abs(out.uncertainty.renormalizedAwayWeight - 0.35) < 1e-9);
  const expectedMissingVar = 0.35 * COLD_START_PRIOR_STD * COLD_START_PRIOR_STD;
  assert.ok(
    Math.abs(out.uncertainty.missingSignalVariance - expectedMissingVar) < 1e-6,
    `missing-signal variance should be 0.35·${COLD_START_PRIOR_STD}²`,
  );
});

test("point estimate is the renormalized weighted average of ONLY the observed features", () => {
  // Give each real feature a distinct value; cold-start values must not move the score.
  const inputs: RenormalizeInput[] = VENDOR_FEATURES.map((f, i) => ({
    key: f.key,
    value: f.real ? 40 + i * 10 : 0, // cold-start value 0 — if it leaked in, the score would crater
    sigma: 4,
    baseWeight: f.baseWeight,
    observed: f.real,
  }));
  const out = renormalize(inputs);
  // Expected = Σ (wᵢ/0.65)·valueᵢ over the 4 real features.
  let expected = 0;
  for (const f of VENDOR_FEATURES) if (f.real) expected += (f.baseWeight / 0.65) * inputs.find((x) => x.key === f.key)!.value;
  assert.ok(Math.abs(out.score - expected) < 1e-9, `score ${out.score} vs expected ${expected}`);
  assert.ok(out.score >= 40, "cold-start 0-values did not leak into the point estimate");
});

test("more missing weight ⇒ strictly wider σ (monotonic tightening)", () => {
  const oneMissing = renormalize([
    { key: "a", value: 80, sigma: 3, baseWeight: 0.5, observed: true },
    { key: "b", value: 80, sigma: 3, baseWeight: 0.1, observed: false },
  ]);
  const moreMissing = renormalize([
    { key: "a", value: 80, sigma: 3, baseWeight: 0.5, observed: true },
    { key: "b", value: 80, sigma: 3, baseWeight: 0.5, observed: false },
  ]);
  assert.ok(moreMissing.uncertainty.sigma > oneMissing.uncertainty.sigma);
});

test("no observed features at all ⇒ hard cold start: neutral score, maximal missing variance", () => {
  const out = renormalize([
    { key: "a", value: 80, sigma: 3, baseWeight: 0.5, observed: false },
    { key: "b", value: 80, sigma: 3, baseWeight: 0.5, observed: false },
  ]);
  assert.equal(out.score, 50);
  assert.equal(out.uncertainty.renormalizedAwayWeight, 1);
  assert.equal(out.uncertainty.sigma, COLD_START_PRIOR_STD);
});
