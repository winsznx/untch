import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { newAccountId, newDraftId, normaliseAddress, resolveScope } from "../src/accounts";

/**
 * The parts of the account model that hold without a database.
 *
 * The store's behaviour — uniqueness, the refusal to move an address between accounts, the refusal to
 * default to a policy an account does not hold — is enforced by constraints, so testing it against
 * anything other than Postgres would be testing a reimplementation of Postgres. That suite is
 * `accounts-pg.test.ts`. What is here is the part that is genuinely logic.
 */
describe("account identifiers", () => {
  test("an account id carries no identity, no ordering and no address", () => {
    const a = newAccountId();
    assert.match(a, /^acct_[a-z0-9]{26}$/, "the shape the schema CHECK enforces");
    // Not a serial: a serial leaks how many accounts exist and lets one be guessed from another.
    assert.notEqual(a, newAccountId());
    assert.ok(!/@/.test(a), "an id that could contain an email is an id someone will put one in");
  });

  test("ids are drawn from a large enough space that collision is not a design assumption", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) seen.add(newAccountId());
    assert.equal(seen.size, 5_000);
  });

  test("draft ids are distinguishable from account ids at a glance", () => {
    assert.match(newDraftId(), /^pdft_[0-9a-f]{24}$/);
  });
});

describe("address normalisation", () => {
  /**
   * Two spellings of one address are two identities as far as a unique index is concerned, which
   * would let the same wallet bind to two accounts and both bindings look correct.
   */
  test("EVM addresses are lowercased so one wallet cannot become two", () => {
    const mixed = "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba";
    assert.equal(normaliseAddress("evm", mixed), mixed.toLowerCase());
    assert.equal(normaliseAddress("evm", `  ${mixed}  `), mixed.toLowerCase());
  });

  test("Solana addresses keep their case, because base58 is case-significant", () => {
    const sol = "FSW47vDcXcJfN9G6h1jFmRr9kQpXbYzE2sTuVwXyZaBc";
    assert.equal(normaliseAddress("solana", sol), sol);
    assert.notEqual(normaliseAddress("solana", sol), sol.toLowerCase());
  });
});

describe("the migration path off policy-partition tenancy", () => {
  /**
   * The property that makes this migration safe to ship: a policy with no account behaves EXACTLY as
   * it does today. Not as a degraded mode — as the same mode. Every existing intent and receipt stays
   * keyed by the partition it was written with, so no published receipt can break.
   */
  test("a policy with no account still resolves to the tenant it always had", () => {
    const scope = resolveScope("42", null);
    assert.equal(scope.tenantId, "policy:42");
    assert.equal(scope.policyId, "42");
    assert.equal(scope.accountId, null);
  });

  test("adopting a policy into an account adds a fact and changes no key", () => {
    const account = {
      accountId: "acct_abcdefghijklmnopqrstuvwxyz",
      status: "ACTIVE" as const,
      displayName: null,
      defaultPolicyId: null,
      lastUsedPolicyId: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      createdBy: "siwe",
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedBy: "siwe",
    };
    const before = resolveScope("42", null);
    const after = resolveScope("42", account);

    assert.equal(after.tenantId, before.tenantId, "the partition every existing row is keyed by must not move");
    assert.equal(after.accountId, account.accountId);
  });
});
