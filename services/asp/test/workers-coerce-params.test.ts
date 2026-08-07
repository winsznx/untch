import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { coerceObjectParams } from "../src/workers/coerce-params";


/**
 * Declared types, honoured — because `--param` cannot produce anything but strings.
 *
 * Found by buying `preflight_payment` with `--param useDefaultPolicy=true`. The quote reported
 * `missingParams: []`, the call went through, and the handler answered POLICY_ID_REQUIRED: it checks
 * `typeof b.useDefaultPolicy === "boolean"` and the CLI had sent the string `"true"`. Every boolean or
 * numeric parameter on every tool was unreachable from the standard client.
 *
 * (The buyer was not charged — the failing-handler guard held — but they were refused for supplying
 * exactly what the contract asked for.)
 */
describe("a declared type is honoured, so CLI strings reach the handler", () => {
  const schema = {
    properties: {
      useDefaultPolicy: { type: "boolean" },
      count: { type: "integer" },
      ratio: { type: "number" },
      idea: { type: "string" },
    },
  } as const;

  test("a boolean declared by the contract arrives as a boolean", () => {
    const out = coerceObjectParams({ useDefaultPolicy: "true" }, schema) as Record<string, unknown>;
    assert.equal(out.useDefaultPolicy, true);
    assert.equal((coerceObjectParams({ useDefaultPolicy: "false" }, schema) as never as Record<string, unknown>).useDefaultPolicy, false);
  });

  test("numbers and integers likewise", () => {
    const out = coerceObjectParams({ count: "3", ratio: "0.5" }, schema) as Record<string, unknown>;
    assert.equal(out.count, 3);
    assert.equal(out.ratio, 0.5);
  });

  /** A string field stays a string even when it looks numeric — the contract is the authority. */
  test("a declared string is never coerced", () => {
    const out = coerceObjectParams({ idea: "123" }, schema) as Record<string, unknown>;
    assert.equal(out.idea, "123");
  });

  test("an undeclared field keeps the old, careful behaviour", () => {
    const out = coerceObjectParams({ other: "123" }, schema) as Record<string, unknown>;
    assert.equal(out.other, "123", "without a declared type, inventing one would be a guess");
  });

  /** Left alone so the handler refuses it with its own message rather than seeing NaN. */
  test("an unparseable value is passed through untouched", () => {
    const out = coerceObjectParams({ count: "many", useDefaultPolicy: "yes" }, schema) as Record<string, unknown>;
    assert.equal(out.count, "many");
    assert.equal(out.useDefaultPolicy, "yes");
  });

  test("with no schema at all, nothing new is coerced", () => {
    const out = coerceObjectParams({ useDefaultPolicy: "true", count: "3" }) as Record<string, unknown>;
    assert.equal(out.useDefaultPolicy, "true");
    assert.equal(out.count, "3");
  });
});
