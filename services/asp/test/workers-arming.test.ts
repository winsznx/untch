import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DisarmedError,
  FINANCIAL_OPERATIONS,
  armingState,
  assertArmed,
  disarmedResponse,
} from "../src/workers/arming";
import type { SchemaVerdict } from "@untch/consumer-core";

/**
 * The cutover switch.
 *
 * While Railway is the writer, this Worker must refuse anything that moves money or creates authority.
 * Two processes issuing authority against one budget is a split brain nobody can reconcile afterwards,
 * so the default is off and arming is a deliberate act.
 */

const SCHEMA_OK: SchemaVerdict = { ok: true, applied: 35, head: "035_wallet_scope_downgrade.sql" };
const SCHEMA_BEHIND: SchemaVerdict = {
  ok: false,
  reason: "SCHEMA_BEHIND_BUNDLE",
  detail: "missing 036",
  applied: 35,
  head: "035_wallet_scope_downgrade.sql",
  expectedHead: "036_later.sql",
  missing: ["036_later.sql"],
};

describe("a Worker is disarmed unless every condition holds", () => {
  test("all three conditions met arms it", () => {
    const s = armingState({ attested: true, schema: SCHEMA_OK, armedFlag: "1" });
    assert.equal(s.armed, true);
    assert.deepEqual(s.refusals, []);
  });

  test("an unattested bundle is refused even when everything else is ready", () => {
    const s = armingState({ attested: false, schema: SCHEMA_OK, armedFlag: "1" });
    assert.equal(s.armed, false);
    assert.deepEqual(s.refusals, ["UNATTESTED"]);
  });

  test("a schema behind the bundle is refused even when armed and attested", () => {
    const s = armingState({ attested: true, schema: SCHEMA_BEHIND, armedFlag: "1" });
    assert.equal(s.armed, false);
    assert.deepEqual(s.refusals, ["SCHEMA_NOT_READY"]);
  });

  test("an unverified schema is refused — absent is not the same as fine", () => {
    const s = armingState({ attested: true, schema: null, armedFlag: "1" });
    assert.deepEqual(s.refusals, ["SCHEMA_NOT_READY"]);
  });

  /** The cutover switch itself. This is the one that stays off while Railway writes. */
  test("without the operator flag it stays disarmed however healthy it is", () => {
    const s = armingState({ attested: true, schema: SCHEMA_OK, armedFlag: undefined });
    assert.equal(s.armed, false);
    assert.deepEqual(s.refusals, ["NOT_ARMED"]);
  });

  /**
   * A truthy check would arm on "false", "0" and "no". The safer reading of an ambiguous value is the
   * one that refuses, so only the exact string arms.
   */
  test("only the exact string 1 arms it", () => {
    for (const flag of ["", "0", "false", "no", "true", "yes", "on", "1 ", "01", "enabled"]) {
      const s = armingState({ attested: true, schema: SCHEMA_OK, armedFlag: flag });
      const shouldArm = flag.trim() === "1";
      assert.equal(s.armed, shouldArm, `flag ${JSON.stringify(flag)} must ${shouldArm ? "arm" : "not arm"}`);
    }
  });

  test("every failing condition is reported, not just the first", () => {
    const s = armingState({ attested: false, schema: SCHEMA_BEHIND, armedFlag: undefined });
    assert.deepEqual(s.refusals, ["UNATTESTED", "SCHEMA_NOT_READY", "NOT_ARMED"]);
  });
});

describe("financial operations refuse while disarmed", () => {
  const disarmed = armingState({ attested: true, schema: SCHEMA_OK, armedFlag: undefined });
  const armed = armingState({ attested: true, schema: SCHEMA_OK, armedFlag: "1" });

  for (const op of FINANCIAL_OPERATIONS) {
    test(`${op} throws while disarmed and proceeds when armed`, () => {
      assert.throws(() => assertArmed(disarmed, op), DisarmedError);
      assert.doesNotThrow(() => assertArmed(armed, op));
    });
  }

  test("the refusal names the operation and every reason, and carries no secret", async () => {
    let caught: DisarmedError | null = null;
    try {
      assertArmed(armingState({ attested: false, schema: null, armedFlag: undefined }), "mint-x402-authorization");
    } catch (e) {
      caught = e as DisarmedError;
    }
    assert.ok(caught);

    const res = disarmedResponse(caught!);
    assert.equal(res.status, 503, "a deployment posture, not the caller's mistake");
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "DEPLOYMENT_NOT_ARMED");
    assert.equal(body.operation, "mint-x402-authorization");
    assert.deepEqual(body.refusals, ["UNATTESTED", "SCHEMA_NOT_READY", "NOT_ARMED"]);
    assert.equal(body.retryable, false, "retrying will not arm it");

    const text = JSON.stringify(body);
    for (const secret of ["password", "token", "key", "secret", "postgres://", "postgresql://"]) {
      assert.ok(!text.toLowerCase().includes(secret), `the refusal must not mention ${secret}`);
    }
  });

  /**
   * The list is a DENY-list on purpose. A new read route is then open by default and a new financial
   * route has to be added here deliberately — the opposite arrangement means every forgotten route is
   * armed by accident.
   */
  test("minting an x402 authorization is one of the named financial operations", () => {
    assert.ok(FINANCIAL_OPERATIONS.includes("mint-x402-authorization"));
    assert.ok(FINANCIAL_OPERATIONS.includes("settle-payment"));
    assert.ok(FINANCIAL_OPERATIONS.includes("act-on-approval"));
    assert.ok(FINANCIAL_OPERATIONS.includes("create-reservation"));
  });
});
