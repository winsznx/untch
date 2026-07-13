import assert from "node:assert/strict";
import { test } from "node:test";
import { hashCanonicalJson } from "@untch/canon";
import { parsePolicyRules, PolicyValidationError } from "../src/rules";
import { sampleRules } from "./helpers";

/** parsePolicyRules — the untrusted-rules boundary. Validates the engine-required shape; preserves any
 *  extra §8 fields so the anchored hash covers exactly what was submitted. */

test("valid §8 ruleset passes and is returned unchanged (extras preserved)", () => {
  const rules = sampleRules({ anchorIntentsAbove: 2.0, timeWindows: [{ days: "*", utc: "00:00-23:59" }] });
  const parsed = parsePolicyRules(rules);
  // #then the original object is returned, so its canonical hash covers the extras too.
  assert.equal(hashCanonicalJson(parsed as unknown as Record<string, unknown>), hashCanonicalJson(rules));
  assert.equal((parsed as unknown as Record<string, unknown>).anchorIntentsAbove, 2.0);
});

test("missing required field → PolicyValidationError with the malformed code", () => {
  assert.throws(
    () => parsePolicyRules(sampleRules({ budgets: { token: "USDT" } })), // no budgets.daily
    (err: unknown) => err instanceof PolicyValidationError && err.code === "POLICY_RULES_MALFORMED",
  );
});

test("unparseable expiry → rejected at the door (engine would fail-close on it)", () => {
  assert.throws(
    () => parsePolicyRules(sampleRules({ expiry: "not-a-date" })),
    /rules.expiry is not a parseable/,
  );
});

test("wrong type for a nested field → rejected", () => {
  assert.throws(
    () => parsePolicyRules(sampleRules({ categories: { allow: "market-data", deny: [] } })),
    (err: unknown) => err instanceof PolicyValidationError,
  );
});

test("non-address in recipients → rejected", () => {
  assert.throws(
    () => parsePolicyRules(sampleRules({ recipients: { allow: ["not-an-address"], deny: [] } })),
    (err: unknown) => err instanceof PolicyValidationError,
  );
});

test("non-object input → rejected", () => {
  assert.throws(() => parsePolicyRules(null), (err: unknown) => err instanceof PolicyValidationError);
  assert.throws(() => parsePolicyRules([]), (err: unknown) => err instanceof PolicyValidationError);
});
