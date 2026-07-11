import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hashCanonicalJson } from "@untch/canon";
import type { Hex } from "viem";
import { runT0, type AcceptanceCriteria } from "../src/index";
import { commit, goodMarketData, marketDataCriteria } from "./helpers";

/**
 * T0 — the deterministic schema/conformance checker (§13/§7.3). Every check exercised in isolation,
 * with a pass case AND a fail case, plus the boundary cases (size, regex/enum length) and the
 * exact-hash match/mismatch and criteria-binding integrity paths. No LLM anywhere (I1).
 */

describe("T0 schema/conformance", () => {
  test("PASS: a conformant payload against a full criteria doc yields PASS with no diffs", () => {
    // #given the market-data criteria and a conformant payload
    const criteria = marketDataCriteria();
    // #when T0 runs against the committed hash
    const { tier, payloadHash } = runT0(commit(criteria), criteria, { payload: goodMarketData() });
    // #then it passes, records no diffs, and reports the payload's canonical hash
    assert.equal(tier.result, "PASS");
    assert.equal(tier.diffs, undefined);
    assert.equal(payloadHash, hashCanonicalJson(goodMarketData()));
  });

  test("FAIL(schema): a payload violating the JSON Schema yields a schema diff", () => {
    // #given a payload whose price is a string, not a number
    const criteria = marketDataCriteria();
    const bad = { symbol: "OKB", price: "48.15", asOf: "2026-07-11T11:59:00Z" };
    // #when T0 runs
    const { tier } = runT0(commit(criteria), criteria, { payload: bad });
    // #then it fails with a schema diff scoped to `price`
    assert.equal(tier.result, "FAIL");
    assert.ok(tier.diffs?.some((d) => d.check === "schema" && d.path === "price"));
  });

  test("FAIL(requiredField): a missing committed field is reported", () => {
    // #given a criteria requiring `asOf` and a payload lacking it
    const criteria: AcceptanceCriteria = { requiredFields: ["symbol", "asOf"] };
    const { tier } = runT0(commit(criteria), criteria, { payload: { symbol: "OKB" } });
    // #then the missing field is a diff
    assert.equal(tier.result, "FAIL");
    assert.deepEqual(
      tier.diffs?.filter((d) => d.check === "requiredField").map((d) => d.path),
      ["asOf"],
    );
  });

  test("size boundary: exactly maxBytes passes; one byte over fails", () => {
    // #given a criteria bounding the canonical JSON to exactly the payload's own size
    const payload = { a: "x" };
    const exactBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const atLimit: AcceptanceCriteria = { sizeBounds: { maxBytes: exactBytes } };
    const overByOne: AcceptanceCriteria = { sizeBounds: { maxBytes: exactBytes - 1 } };
    // #then at the limit passes, one under the limit fails on size
    assert.equal(runT0(commit(atLimit), atLimit, { payload }).tier.result, "PASS");
    const over = runT0(commit(overByOne), overByOne, { payload });
    assert.equal(over.tier.result, "FAIL");
    assert.ok(over.tier.diffs?.some((d) => d.check === "size"));
  });

  test("regex boundary: a matching value passes; a non-matching value fails (anchored by default)", () => {
    // #given a symbol regex of 2-10 uppercase alnum
    const criteria: AcceptanceCriteria = { fieldConstraints: [{ field: "symbol", regex: "[A-Z0-9]{2,10}" }] };
    // #then an all-caps ticker passes
    assert.equal(runT0(commit(criteria), criteria, { payload: { symbol: "OKB" } }).tier.result, "PASS");
    // #and a lowercase ticker fails (anchored full-match), with a regex diff
    const bad = runT0(commit(criteria), criteria, { payload: { symbol: "okb" } });
    assert.equal(bad.tier.result, "FAIL");
    assert.ok(bad.tier.diffs?.some((d) => d.check === "regex" && d.path === "symbol"));
  });

  test("enum + length boundaries are enforced", () => {
    // #given a side enum and a 3-char-max code
    const criteria: AcceptanceCriteria = {
      fieldConstraints: [
        { field: "side", enum: ["buy", "sell"] },
        { field: "code", maxLen: 3 },
      ],
    };
    // #then an in-enum, in-length payload passes
    assert.equal(runT0(commit(criteria), criteria, { payload: { side: "buy", code: "ABC" } }).tier.result, "PASS");
    // #and an out-of-enum + too-long payload fails on both
    const bad = runT0(commit(criteria), criteria, { payload: { side: "hodl", code: "ABCD" } });
    assert.equal(bad.tier.result, "FAIL");
    assert.ok(bad.tier.diffs?.some((d) => d.check === "enum" && d.path === "side"));
    assert.ok(bad.tier.diffs?.some((d) => d.check === "maxLen" && d.path === "code"));
  });

  test("exact-hash: a deterministic deliverable matches its committed hash; a changed one does not", () => {
    // #given a deterministic payload and its committed canonical hash
    const payload = { rows: [1, 2, 3], total: 6 };
    const exactValue = hashCanonicalJson(payload);
    const criteria: AcceptanceCriteria = { exactHash: { algorithm: "keccak256-canonical-json", value: exactValue } };
    // #then the identical payload passes
    assert.equal(runT0(commit(criteria), criteria, { payload }).tier.result, "PASS");
    // #and a mutated payload fails with an exactHash diff
    const bad = runT0(commit(criteria), criteria, { payload: { rows: [1, 2, 3], total: 7 } });
    assert.equal(bad.tier.result, "FAIL");
    assert.ok(bad.tier.diffs?.some((d) => d.check === "exactHash"));
  });

  test("exact-hash works from an opaque payloadHash alone (no payload)", () => {
    // #given only a payload hash (opaque deliverable) matching the committed value
    const payloadHash = `0x${"cd".repeat(32)}` as Hex;
    const criteria: AcceptanceCriteria = {
      exactHash: { algorithm: "keccak256-canonical-json", value: payloadHash },
    };
    // #then it passes from the hash alone
    assert.equal(runT0(commit(criteria), criteria, { payloadHash }).tier.result, "PASS");
  });

  test("criteria binding: a spec that does not hash back to the committed acceptanceHash FAILS terminally", () => {
    // #given a committed hash for one criteria doc but a DIFFERENT doc presented at verify time
    const committed = commit(marketDataCriteria());
    const swapped: AcceptanceCriteria = { requiredFields: ["anything"] };
    // #when T0 runs with the swapped doc against the original committed hash
    const { tier } = runT0(committed, swapped, { payload: { anything: 1 } });
    // #then it fails on criteria binding — the presented spec is not the one committed
    assert.equal(tier.result, "FAIL");
    assert.equal(tier.diffs?.length, 1);
    assert.equal(tier.diffs?.[0]?.check, "criteriaBinding");
  });

  test("an empty criteria doc (nothing but its binding) passes for any payload", () => {
    // #given an empty spec (checks nothing but binding integrity)
    const criteria: AcceptanceCriteria = {};
    // #then any payload passes
    assert.equal(runT0(commit(criteria), criteria, { payload: { whatever: true } }).tier.result, "PASS");
  });
});
