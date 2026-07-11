import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryScoreDataSource } from "../src/datasource-memory";
import { scoreVendor, scoreBuyer } from "../src/score";
import { SCORE_DISCLAIMER } from "../src/disclaimer";
import type { WalletProfileProvider } from "../src/rpc";
import {
  agentIdOf,
  approvedOrder,
  blockedOrder,
  failVerify,
  passVerify,
  vendorIdOf,
} from "./helpers";

const V = vendorIdOf("api.vendor.example");
const A = agentIdOf(42n);
const FIXED_NOW = () => 1_700_100_000_000;

const goodWallet: WalletProfileProvider = {
  async signals(address) {
    return { address, txCount: 300, balanceWei: 5_000_000n, isContract: false };
  },
};

test("scoreVendor: three cold-start features are tagged, weightApplied 0, and never presented as observed", async () => {
  const ds = new MemoryScoreDataSource();
  for (let i = 0; i < 12; i++) ds.addOrder(approvedOrder(V, A));
  for (let i = 0; i < 6; i++) ds.addVerify(passVerify(V, A, "store-committed"));

  const r = await scoreVendor(ds, V, { nowMs: FIXED_NOW, walletProvider: goodWallet, persist: true });

  const cold = r.features.filter((f) => f.source === "cold-start-prior");
  assert.deepEqual(
    cold.map((f) => f.key).sort(),
    ["claims_consistency", "price_sanity", "rating_quality"],
  );
  for (const f of cold) {
    assert.equal(f.implemented, false, `${f.key} must be flagged implemented:false`);
    assert.equal(f.weightApplied, 0, `${f.key} must be renormalized out of the point estimate`);
    assert.match(f.note, /PRIOR, not observed/);
  }
  assert.deepEqual(
    r.coldStartFeatures.slice().sort(),
    ["claims_consistency", "price_sanity", "rating_quality"],
  );

  const real = r.features.filter((f) => f.source === "observed");
  assert.equal(real.length, 4);
  const realWeight = real.reduce((s, f) => s + f.weightApplied, 0);
  assert.ok(Math.abs(realWeight - 1) < 1e-9, "observed weights renormalize to 1");
});

test("scoreVendor: disclaimer present, and LCB is conservative vs a good raw score (cold-start widening)", async () => {
  const ds = new MemoryScoreDataSource();
  // A genuinely strong vendor: many orders, all committed passes, no disputes, active wallet.
  for (let i = 0; i < 40; i++) ds.addOrder(approvedOrder(V, A));
  for (let i = 0; i < 20; i++) ds.addVerify(passVerify(V, A, "store-committed"));

  const r = await scoreVendor(ds, V, { nowMs: FIXED_NOW, walletProvider: goodWallet });

  assert.equal(r.disclaimer, SCORE_DISCLAIMER);
  assert.ok(r.score > 75, `strong vendor should score high, got ${r.score}`);
  // The three missing marketplace features widen σ ⇒ LCB is pulled well below the raw score.
  assert.ok(r.lcb < r.score - 14, `LCB ${r.lcb} should be ≥14pt below score ${r.score}`);
  assert.ok(r.uncertainty.renormalizedAwayWeight > 0.34, "0.35 of the weight is renormalized away");
  assert.ok(r.sigma > 12, `σ should carry the missing-signal term, got ${r.sigma}`);
  assert.equal(r.band, r.band); // band derived from LCB, not score
});

test("scoreVendor: dispute-heavy vendor scores lower than a clean one", async () => {
  const clean = new MemoryScoreDataSource();
  const dirty = new MemoryScoreDataSource();
  for (let i = 0; i < 20; i++) {
    clean.addOrder(approvedOrder(V, A));
    dirty.addOrder(approvedOrder(V, A));
  }
  for (let i = 0; i < 10; i++) {
    clean.addVerify(passVerify(V, A, "store-committed"));
    dirty.addVerify(failVerify(V, A, "store-committed"));
  }
  const rc = await scoreVendor(clean, V, { nowMs: FIXED_NOW, walletProvider: goodWallet });
  const rd = await scoreVendor(dirty, V, { nowMs: FIXED_NOW, walletProvider: goodWallet });
  assert.ok(rd.lcb < rc.lcb, `dirty LCB ${rd.lcb} < clean LCB ${rc.lcb}`);
});

test("scoreBuyer: fully-real hygiene, disclaimer present, bad hygiene lowers the score", async () => {
  const clean = new MemoryScoreDataSource();
  for (let i = 0; i < 10; i++) clean.addOrder(approvedOrder(V, A));
  const cleanScore = await scoreBuyer(clean, A, { nowMs: FIXED_NOW });
  assert.equal(cleanScore.disclaimer, SCORE_DISCLAIMER);
  assert.equal(cleanScore.coldStartFeatures.length, 0, "buyer hygiene has no cold-start features");
  assert.ok(cleanScore.features.every((f) => f.source === "observed"), "all buyer features are observed");

  const messy = new MemoryScoreDataSource();
  for (let i = 0; i < 5; i++) messy.addOrder(approvedOrder(V, A));
  for (let i = 0; i < 5; i++) messy.addOrder(blockedOrder(V, A)); // 50% out-of-policy attempts
  const messyScore = await scoreBuyer(messy, A, { nowMs: FIXED_NOW });
  assert.ok(messyScore.score < cleanScore.score, `messy ${messyScore.score} < clean ${cleanScore.score}`);
});

test("scoreVendor persists a snapshot recoverable for the epoch (anchor input)", async () => {
  const ds = new MemoryScoreDataSource();
  for (let i = 0; i < 5; i++) ds.addOrder(approvedOrder(V, A));
  const r = await scoreVendor(ds, V, { nowMs: FIXED_NOW, walletProvider: goodWallet, persist: true });
  const snaps = await ds.snapshotsForEpoch("VENDOR", r.epoch);
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0]!.subjectId, V);
  assert.equal(snaps[0]!.lcb, r.lcb);
});
