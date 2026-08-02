import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertNotOperatorRole,
  isUntchRoleAddress,
  RoleCollisionError,
  ROLE_DISTINCTIONS,
  rolesOf,
  UNTCH_ROLE_ADDRESSES,
} from "../src/role-addresses";

/**
 * The failure these tests exist for happened in review, not in production, and it was one line: the
 * policy-draft route defaulted a user's governed agent to `MAINNET_WRITER_ADDRESS` — the receipt
 * writer. Nothing enforces `policy.agent` on chain, so it would have moved no money wrongly. It would
 * have written a permanent, public, false statement into a record whose only value is being true.
 *
 * Everything below is about making that shape of mistake fail loudly instead of quietly.
 */

const DEPLOYER = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const RECEIPT_WRITER = "0xeedda7d18a34a93f3a722eb4446a526af515457a";
const A_USER = "0x1111111111111111111111111111111111111111";

describe("an operational address cannot fill a user's role", () => {
  test("a user wallet passes", () => {
    // #given an address that is not ours
    // #when it is offered as a policy owner
    // #then nothing is thrown
    assert.doesNotThrow(() => assertNotOperatorRole(A_USER, "the owner of a user's policy"));
    assert.equal(isUntchRoleAddress(A_USER), false);
  });

  test("the deployer is refused as a policy owner, and the message names both roles it fills", () => {
    assert.throws(
      () => assertNotOperatorRole(DEPLOYER, "the owner of a user's policy"),
      (err: unknown) => {
        assert.ok(err instanceof RoleCollisionError);
        assert.equal(err.code, "OPERATOR_ADDRESS_REFUSED");
        assert.match(err.message, /deployer and marketplace-pay-to/);
        assert.match(err.message, /the owner of a user's policy/, "the intended use is in the message, so the fix is obvious");
        return true;
      },
    );
  });

  test("the receipt writer is refused as a governed agent — the exact defect this closes", () => {
    assert.throws(
      () => assertNotOperatorRole(RECEIPT_WRITER, "the agent a user's policy governs"),
      (err: unknown) => {
        assert.ok(err instanceof RoleCollisionError);
        assert.match(err.message, /receipt-writer/);
        assert.match(err.message, /witnesses spending/);
        return true;
      },
    );
  });

  test("case and whitespace do not get an address past the guard", () => {
    assert.throws(() => assertNotOperatorRole(DEPLOYER.toUpperCase().replace("0X", "0x"), "an owner"), RoleCollisionError);
    assert.throws(() => assertNotOperatorRole(`  ${RECEIPT_WRITER}  `, "an owner"), RoleCollisionError);
  });

  test("an address filling two roles reports both, rather than the first one found", () => {
    const roles = rolesOf(DEPLOYER).map((r) => r.role);
    assert.deepEqual(roles.sort(), ["deployer", "marketplace-pay-to"]);
  });

  test("every listed address is lowercased, so a lookup cannot miss on case alone", () => {
    for (const r of UNTCH_ROLE_ADDRESSES) {
      assert.equal(r.address, r.address.toLowerCase(), `${r.role} is not lowercased`);
      assert.match(r.address, /^0x[0-9a-f]{40}$/);
      assert.ok(r.what.length > 20, `${r.role} has no explanation of what it is for`);
    }
  });

  test("the five roles a payment touches are each described", () => {
    for (const key of ["policyOwner", "governedAgent", "serviceRecipient", "marketplacePayTo", "operatorOrDeployer"]) {
      assert.ok((ROLE_DISTINCTIONS[key] ?? "").length > 40, `${key} has no distinction recorded`);
    }
    // The one that decides everything: owner is msg.sender, permanently.
    assert.match(ROLE_DISTINCTIONS.policyOwner ?? "", /msg\.sender/);
    // And the one that is a claim rather than a control, so nobody mistakes it for enforcement.
    assert.match(ROLE_DISTINCTIONS.governedAgent ?? "", /no contract enforces it/);
  });
});
