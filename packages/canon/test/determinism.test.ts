import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashCanonicalJson } from "../src/canonicalize";
import { hashSpendIntent } from "../src/spendIntent";
import { FIXED_INTENT, FIXED_JSON } from "./determinism-inputs";

/**
 * Cross-process determinism (D0.5 brief: "test by hashing fixtures twice in separate
 * processes"). Both surfaces must be pure functions of their input — identical bytes across
 * runs, processes, and machines — or the shared-hash guarantee (§9) is worthless.
 */

const CHILD = fileURLToPath(new URL("./determinism-child.ts", import.meta.url));

function runChild(): { canonJson: string; spendIntent: string } {
  const out = execFileSync(process.execPath, ["--import", "tsx", CHILD], { encoding: "utf8" });
  return JSON.parse(out);
}

describe("cross-process determinism", () => {
  test("two separate processes produce identical hashes, matching the in-process result", () => {
    const inProcess = {
      canonJson: hashCanonicalJson(FIXED_JSON),
      spendIntent: hashSpendIntent(FIXED_INTENT),
    };
    const run1 = runChild();
    const run2 = runChild();

    assert.deepEqual(run1, run2, "two fresh processes disagreed — hashing is not deterministic");
    assert.deepEqual(run1, inProcess, "child process disagreed with in-process hashing");
  });

  test("in-process repetition is stable (no hidden mutable state)", () => {
    assert.equal(hashCanonicalJson(FIXED_JSON), hashCanonicalJson(FIXED_JSON));
    assert.equal(hashSpendIntent(FIXED_INTENT), hashSpendIntent(FIXED_INTENT));
  });
});
