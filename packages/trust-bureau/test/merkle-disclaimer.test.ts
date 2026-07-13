import assert from "node:assert/strict";
import { test } from "node:test";
import { leafOf, merkleRoot, hashPair, rootOfSnapshots } from "../src/merkle";
import { SCORE_DISCLAIMER } from "../src/disclaimer";
import type { ScoreSnapshotRow } from "../src/types";

function snap(subjectId: string, score: number, sigma: number, lcb: number): ScoreSnapshotRow {
  return {
    subject: "VENDOR",
    subjectId,
    epoch: 1000,
    score,
    sigma,
    lcb,
    band: "STABLE",
    features: [],
    anchoredRoot: null,
    computedAt: "2026-01-01T00:00:00.000Z",
  };
}

const idA = "0x" + "11".repeat(32);
const idB = "0x" + "22".repeat(32);

test("merkle is deterministic and order-independent (commutative pairing)", () => {
  const a = snap(idA, 80, 13, 63);
  const b = snap(idB, 60, 15, 41);
  const r1 = rootOfSnapshots([a, b]);
  const r2 = rootOfSnapshots([b, a]);
  assert.equal(r1, r2, "root must not depend on subject order");
});

test("a single-leaf tree roots to that leaf; empty throws", () => {
  const a = snap(idA, 80, 13, 63);
  assert.equal(merkleRoot([leafOf(a)]), leafOf(a));
  assert.throws(() => merkleRoot([]), /nothing to anchor/);
});

test("changing any anchored field changes the leaf (tamper-evidence)", () => {
  const base = leafOf(snap(idA, 80, 13, 63));
  assert.notEqual(base, leafOf(snap(idA, 81, 13, 63)), "score change flips the leaf");
  assert.notEqual(base, leafOf(snap(idA, 80, 14, 63)), "σ change flips the leaf");
  assert.notEqual(base, leafOf(snap(idA, 80, 13, 62)), "lcb change flips the leaf");
});

test("hashPair is commutative", () => {
  const x = leafOf(snap(idA, 80, 13, 63));
  const y = leafOf(snap(idB, 60, 15, 41));
  assert.equal(hashPair(x, y), hashPair(y, x));
});

test("disclaimer is plain-language, present, and carries no em-dash (style rule)", () => {
  assert.ok(SCORE_DISCLAIMER.length > 40);
  assert.match(SCORE_DISCLAIMER, /operational confidence signals/);
  assert.match(SCORE_DISCLAIMER, /not legal, financial, or criminal-risk/);
  assert.ok(!SCORE_DISCLAIMER.includes("—"), "no em-dash per the standing style rule");
});
