import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VERIFY_RESULT_CODE, verifyDelivery } from "../src/index";
import { INTENT_HASH, ZERO_HASH, commit, goodMarketData, marketDataCriteria, now } from "./helpers";

/**
 * The Proof Engine orchestrator (§7.3). Covers every terminal state this slice can emit and asserts
 * the on-chain codes (verifyResultCode / proofTier) so the verify receipt records a REAL result.
 */

describe("verifyDelivery outcomes", () => {
  test("VERIFY_PASSED: conformant delivery → RELEASE, verifyResult=PASS, proofTier=0", () => {
    // #given a conformant delivery against committed criteria
    const criteria = marketDataCriteria();
    // #when verified at the default (T0) required tier
    const out = verifyDelivery({
      intentHash: INTENT_HASH,
      acceptanceHash: commit(criteria),
      criteria,
      delivery: { payload: goodMarketData() },
      now,
    });
    // #then it passes with the RELEASE recommendation and the real on-chain codes
    assert.equal(out.final, "VERIFY_PASSED");
    assert.equal(out.recommendation, "RELEASE");
    assert.equal(out.verifyResultCode, VERIFY_RESULT_CODE.PASS);
    assert.equal(out.proofTier, 0);
    assert.equal(out.hygieneEvent, false);
    assert.equal(out.verifiedAt, "2026-07-11T12:00:00.000Z");
  });

  test("VERIFY_FAILED: a schema violation → WITHHOLD, verifyResult=FAIL, diffs surfaced", () => {
    // #given a payload violating the schema
    const criteria = marketDataCriteria();
    const out = verifyDelivery({
      intentHash: INTENT_HASH,
      acceptanceHash: commit(criteria),
      criteria,
      delivery: { payload: { symbol: "okb", price: -1 } },
      now,
    });
    // #then it withholds, records FAIL, and exposes the diffs at the top level too
    assert.equal(out.final, "VERIFY_FAILED");
    assert.equal(out.recommendation, "WITHHOLD");
    assert.equal(out.verifyResultCode, VERIFY_RESULT_CODE.FAIL);
    assert.ok(out.diffs.length > 0);
  });

  test("VERIFY_SKIPPED_UNCOMMITTED: a zero acceptanceHash is a logged buyer-hygiene event, not a pass", () => {
    // #given no acceptanceHash committed at intent time
    const out = verifyDelivery({
      intentHash: INTENT_HASH,
      acceptanceHash: ZERO_HASH,
      delivery: { payload: goodMarketData() },
      now,
    });
    // #then it is the hygiene event — distinct from PASS, with its own code and NONE recommendation
    assert.equal(out.final, "VERIFY_SKIPPED_UNCOMMITTED");
    assert.equal(out.recommendation, "NONE");
    assert.equal(out.hygieneEvent, true);
    assert.equal(out.verifyResultCode, VERIFY_RESULT_CODE.SKIPPED_UNCOMMITTED);
    // #and the T0 line explicitly says SKIPPED_UNCOMMITTED — never a silent zero
    assert.equal(out.tierResults[0]?.result, "SKIPPED_UNCOMMITTED");
    assert.notEqual(out.verifyResultCode, VERIFY_RESULT_CODE.PASS);
  });

  test("committed but no criteria presented → FAIL (spec withheld), never a pass", () => {
    // #given a non-zero committed acceptanceHash but no criteria doc supplied
    const out = verifyDelivery({
      intentHash: INTENT_HASH,
      acceptanceHash: commit(marketDataCriteria()),
      delivery: { payload: goodMarketData() },
      now,
    });
    // #then it fails on criteria binding
    assert.equal(out.final, "VERIFY_FAILED");
    assert.equal(out.verifyResultCode, VERIFY_RESULT_CODE.FAIL);
    assert.ok(out.diffs.some((d) => d.check === "criteriaBinding"));
  });

  test("VERIFY_TIER_NOT_IMPLEMENTED: a policy requiring a stubbed tier never returns a silent PASS", () => {
    // #given a conformant T0 delivery but a policy requiring tier 1 (stubbed)
    const criteria = marketDataCriteria();
    const out = verifyDelivery({
      intentHash: INTENT_HASH,
      acceptanceHash: commit(criteria),
      criteria,
      delivery: { payload: goodMarketData() },
      requiredTier: 1,
      now,
    });
    // #then T0 passes, but the overall result honestly reports the unmet tier, and WITHHOLDs
    assert.equal(out.tierResults[0]?.result, "PASS");
    assert.equal(out.final, "VERIFY_TIER_NOT_IMPLEMENTED");
    assert.equal(out.recommendation, "WITHHOLD");
    assert.equal(out.verifyResultCode, VERIFY_RESULT_CODE.NOT_IMPLEMENTED);
    assert.notEqual(out.verifyResultCode, VERIFY_RESULT_CODE.PASS);
  });
});
