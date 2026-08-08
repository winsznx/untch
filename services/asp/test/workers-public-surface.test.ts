import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { looksPublic, looksPublicVerify } from "../src/public-dto/preflight";
import { looksPublicVerify as verifyShape } from "../src/public-dto/verify";
import { workerPaymentAuthorizationHeader } from "../src/workers/public-surface";

/**
 * The published contract must reach the published handler.
 *
 * Express serves one route per tool and branches on body shape. The Cloudflare port kept only the
 * protocol arm, so a buyer sending exactly what we advertise —
 * `{policyId, provider, capability, task, maxSpend, currency, deadline}` — reached a handler demanding
 * `intentHash` and was answered INTENT_REQUIRED. Found by paying for it against a real registered
 * policy, not by reading the code: the route existed, priced correctly, challenged correctly, and
 * answered the wrong contract, so every audit that counted status codes walked straight past it.
 */

const PAID = readFileSync(new URL("../src/workers/paid-routes.ts", import.meta.url), "utf8");

describe("both paid routes branch the way Express does", () => {
  for (const [tool, guard, handler] of [
    ["preflight", "looksPublic(body)", "runPublicPreflight"],
    ["verify", "looksPublicVerify(body)", "runPublicVerify"],
  ] as const) {
    test(`${tool} tries the published shape first`, () => {
      assert.ok(PAID.includes(guard), `${tool} must detect the published shape`);
      assert.ok(PAID.includes(handler), `${tool} must be able to serve it`);
    });
  }

  /**
   * The fallback must survive. `create_spend_intent` callers already hold a protocol intent, and
   * routing them to the public handler would silently ignore evidence they deliberately sent.
   */
  test("the protocol handlers are still reachable", () => {
    assert.ok(PAID.includes("handlePreflightPayment"), "a caller holding an intent must still be served");
    assert.ok(PAID.includes("handleVerifyDelivery"));
  });

  /** Wrong decision beats no decision only in the other direction: refuse rather than half-serve. */
  test("the public branch is skipped when this deployment cannot open a session", () => {
    assert.match(PAID, /looksPublic\(body\) && publicArgs/, "no secret means the protocol handler answers");
  });
});

describe("the two shapes cannot be confused", () => {
  const published = { policyId: "1", provider: "untch", capability: "c", task: "t", maxSpend: "1.00" };

  test("a published preflight request is detected", () => {
    assert.equal(looksPublic(published), true);
  });

  /** A protocol intent carries `owner` and `taskHash` and none of the four public fields. */
  test("a protocol intent is not mistaken for one", () => {
    assert.equal(looksPublic({ policyId: "1", intentHash: "0xabc" }), false);
    assert.equal(looksPublic({ intent: { owner: "0x1", taskHash: "0x2" } }), false);
  });

  test("verify routes on intentId alone, and defers when protocol material is present", () => {
    assert.equal(verifyShape({ intentId: "int_1" }), true);
    assert.equal(verifyShape({ intentId: "int_1", policyId: "1" }), false, "deliberate evidence must not be ignored");
  });
});

describe("the payment reaches the handler as evidence", () => {
  const req = (h: Record<string, string>) => new Request("https://asp.untch.xyz/preflight_payment", { method: "POST", headers: h });

  test("both header spellings are read, in the SDK's precedence order", () => {
    assert.equal(workerPaymentAuthorizationHeader(req({ "x-payment": "b" })), "b");
    assert.equal(workerPaymentAuthorizationHeader(req({ "payment-signature": "a", "x-payment": "b" })), "a");
  });

  test("absent is null, not an empty string a parser would treat as present", () => {
    assert.equal(workerPaymentAuthorizationHeader(req({})), null);
    assert.equal(workerPaymentAuthorizationHeader(req({ "x-payment": "   " })), null);
  });
});

describe("a paid decision cannot succeed without recording itself", () => {
  const SURFACE = readFileSync(new URL("../src/workers/public-surface.ts", import.meta.url), "utf8");

  /**
   * Typed nullable for an instance with no database, where a paid decision refuses rather than
   * returning a success nothing remembers. This deployment has Postgres, so both are supplied.
   */
  test("evidenceTx and serviceCalls are both wired", () => {
    assert.match(SURFACE, /evidenceTx:\s*evidenceTxFor\(/);
    assert.match(SURFACE, /serviceCalls:\s*new PgServiceCallStore/);
  });

  test("the transaction releases its client even when the body throws", () => {
    assert.match(SURFACE, /finally\s*\{\s*client\.release\(\);/s, "a leaked connection exhausts Hyperdrive's budget");
    assert.match(SURFACE, /ROLLBACK/);
  });

  /** An approval that read as work performed would be a demo pretending to be a payment. */
  test("execution is reported as disabled, since no executor is wired here", () => {
    assert.match(SURFACE, /executionEnabled:\s*false/);
  });
});
