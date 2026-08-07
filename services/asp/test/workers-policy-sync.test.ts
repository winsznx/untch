import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * The three writes that turn a registered policy into one its own account can see.
 *
 * The Worker's `policy_sync` stopped at `syncRegistration`, which stores the policy in the policy repo
 * and nothing more. A real user registered a policy on chain — confirmed transaction, receipt status
 * 0x1, owned by their own wallet — and then found `GET /consumer/policies` empty, `defaultPolicyId`
 * null, and `PUT /consumer/account/default-policy` answering POLICY_NOT_FOUND. Sync had reported
 * success.
 *
 * Express does `markDraftConfirmed` → `linkPolicy` → first-policy default. The Worker did none of
 * them. Nothing failed; the account simply never learned it owned anything.
 *
 * Checked against the source because the alternative is a Postgres harness for a route whose whole
 * defect was an omission — and an omission is exactly what a mock-heavy test tends to reproduce
 * rather than catch.
 */

const SYNC = (() => {
  const src = readFileSync(new URL("../src/workers/policy-routes.ts", import.meta.url), "utf8");
  const begin = src.indexOf("pattern: POLICY_SYNC_ROUTE");
  assert.ok(begin > 0, "the sync route must exist");
  return src.slice(begin);
})();

describe("policy_sync makes the policy reachable from the account", () => {
  for (const [what, pattern, why] of [
    [
      "records the id the chain issued against the draft",
      /markDraftConfirmed\(/,
      "without it the draft never learns its policyId and a re-sync cannot recognise itself",
    ],
    [
      "links the policy to the account",
      /linkPolicy\(/,
      "this is the omission that made a registered policy invisible: policiesFor() stayed empty",
    ],
    [
      "makes the first policy the default",
      /setDefaultPolicy\(/,
      "an account with one policy and no default fails its next preflight for no actionable reason",
    ],
  ] as const) {
    test(what, () => assert.match(SYNC, pattern, why));
  }

  /**
   * The account must not be able to adopt a registration it did not draft. Without the comparison a
   * caller could sync any registerPolicy transaction against their own draft and have the resulting
   * policy linked to them, rules and all.
   */
  test("refuses a transaction that anchored a different policy than the draft describes", () => {
    assert.match(SYNC, /POLICY_HASH_MISMATCH/);
  });

  /**
   * A fresh draft has no `policyId` — it exists only once the chain has confirmed the registration.
   * The first version read it unconditionally and passed `undefined` to `loadStored` on every genuine
   * sync.
   */
  test("only looks for an existing policy when the draft actually carries an id", () => {
    assert.match(SYNC, /policyId\?: string \| null/);
  });

  test("the default is not silently displaced by a later policy", () => {
    assert.match(
      SYNC,
      /if \(!fresh\?\.defaultPolicyId\)/,
      "replacing an existing default on every sync would move a user's spending rules without them asking",
    );
  });
});

/**
 * DRAFT → SUBMITTED, the transition the port dropped.
 *
 * `markDraftConfirmed` refuses anything that is not SUBMITTED, deliberately — a draft with no
 * broadcast transaction has nothing to confirm. Express moves the draft there first; the Worker did
 * not, so a real registration against a real confirmed transaction threw that refusal as an unhandled
 * error and answered 500. Found by registering a policy on X Layer and trying to sync it: gas paid,
 * policy on chain, and no way to record which transaction carried it.
 *
 * Asserted against the source for the same reason as the writes above — the defect was an omission,
 * and ORDER matters here: marking it submitted after the confirm attempt would be no fix at all.
 */
describe("a freshly broadcast draft can be confirmed", () => {
  test("the draft is marked submitted, carrying the transaction that registered it", () => {
    assert.match(
      SYNC,
      /markDraftSubmitted\(\{[^}]*registerTx:\s*txHash/s,
      "sync must record which transaction carried the registration",
    );
  });

  test("it happens BEFORE syncRegistration, or the confirm still refuses", () => {
    const submitted = SYNC.indexOf("markDraftSubmitted");
    const sync = SYNC.indexOf("syncRegistration");
    assert.ok(submitted > -1 && sync > -1);
    assert.ok(submitted < sync, "marking it submitted after the confirm attempt would fix nothing");
  });

  /** Only a DRAFT. Re-marking a SUBMITTED or CONFIRMED draft would rewrite which tx registered it. */
  test("only a DRAFT is moved", () => {
    assert.match(SYNC, /status\s*===\s*"DRAFT"/, "an already-submitted draft must not be re-stamped");
  });
});
