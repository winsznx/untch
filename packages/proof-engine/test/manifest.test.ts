import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  IMPLEMENTED_TIERS,
  STUBBED_TIERS,
  verifyDelivery,
} from "../src/index";
import { INTENT_HASH, commit, goodMarketData, marketDataCriteria, now } from "./helpers";

/**
 * The tier manifest test — the exact analogue of the policy engine's rule manifest. It pins which §13
 * tiers are REAL (T0) and which are STUBBED (T1–T4), from two independent sources that must agree:
 *   1. the exported IMPLEMENTED_TIERS / STUBBED_TIERS constants, and
 *   2. what actually appears in a live VerifyOutcome's tier ladder (the `implemented:false` entries).
 * So nobody can later mistake this slice for the complete Proof Engine.
 */

describe("tier manifest", () => {
  test("exactly one tier (T0) is implemented", () => {
    assert.deepEqual([...IMPLEMENTED_TIERS], ["T0"]);
    assert.equal(IMPLEMENTED_TIERS.length, 1);
  });

  test("exactly four tiers (T1–T4) are stubbed, in order; the sets are disjoint", () => {
    assert.deepEqual([...STUBBED_TIERS], ["T1", "T2", "T3", "T4"]);
    const overlap = IMPLEMENTED_TIERS.filter((t) => (STUBBED_TIERS as readonly string[]).includes(t));
    assert.deepEqual(overlap, []);
  });

  test("a live verify ladder marks implemented:false on EXACTLY the STUBBED_TIERS set, and T0 is real", () => {
    // #when a real T0 verification runs
    const criteria = marketDataCriteria();
    const out = verifyDelivery({
      intentHash: INTENT_HASH,
      acceptanceHash: commit(criteria),
      criteria,
      delivery: { payload: goodMarketData() },
      now,
    });
    // #then the ladder is the full §13 set, T0 first
    assert.deepEqual(out.tierResults.map((t) => t.tier), ["T0", "T1", "T2", "T3", "T4"]);
    // #and implemented:false is on exactly the stub set (same order)
    const stubbed = out.tierResults.filter((t) => t.implemented === false).map((t) => t.tier);
    assert.deepEqual(stubbed, [...STUBBED_TIERS]);
    // #and every stub reports NOT_IMPLEMENTED — never a silent PASS
    assert.ok(out.tierResults.filter((t) => t.implemented === false).every((t) => t.result === "NOT_IMPLEMENTED"));
    // #and the real tier (T0) carries no implemented flag (matches §7.3 shape)
    const real = out.tierResults.filter((t) => t.implemented === undefined).map((t) => t.tier);
    assert.deepEqual(real, [...IMPLEMENTED_TIERS]);
  });
});
