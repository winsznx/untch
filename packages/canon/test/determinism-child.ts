import { hashCanonicalJson } from "../src/canonicalize";
import { hashSpendIntent } from "../src/spendIntent";
import { FIXED_INTENT, FIXED_JSON } from "./determinism-inputs";

/**
 * Determinism probe — computes both surfaces' hashes for the shared fixed inputs in a FRESH
 * process and prints them as JSON. `determinism.test.ts` runs this twice and compares, proving
 * the hashes do not depend on process state, module load order, or map/iteration ordering.
 */
process.stdout.write(
  JSON.stringify({
    canonJson: hashCanonicalJson(FIXED_JSON),
    spendIntent: hashSpendIntent(FIXED_INTENT),
  }),
);
