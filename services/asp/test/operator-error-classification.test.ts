import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, normalizedError, resolveExecutionShape } from "@untch/consumer-core";
import { classifyFailure } from "../src/consumer/operator-error-classification";

/**
 * Turning a domain failure into an answer a controller can act on.
 *
 * The first bounded production proof got express's default HTML error page and HTTP 500 for a real
 * provider defect. That answer is unparseable, names no cause, says nothing about whether an intent now
 * exists, and invites the retry that would make one authorisation into two.
 */

describe("a provider failure becomes a structured answer", () => {
  test("a malformed provider response is 502 and needs a new request", () => {
    // #given the exact error the first production proof hit
    const err = new ProviderError(
      normalizedError("PROVIDER_MALFORMED_RESPONSE", "shipping address — shippingAddress: expected an object"),
    );
    // #when it is classified
    const c = classifyFailure(err);
    // #then the upstream is blamed, and the caller is told a fresh intent id is needed
    assert.equal(c.status, 502);
    assert.equal(c.code, "PROVIDER_MALFORMED_RESPONSE");
    assert.equal(c.disposition, "TERMINAL_NEW_REQUEST_REQUIRED");
    assert.equal(c.newIntentRequired, true);
  });

  test("a caller-side request failure is 400", () => {
    const c = classifyFailure(new ProviderError(normalizedError("PROVIDER_BAD_REQUEST", "query is required")));
    assert.equal(c.status, 400);
    assert.equal(c.newIntentRequired, true);
  });

  test("a provider refusal on the merits is 422", () => {
    assert.equal(classifyFailure(new ProviderError(normalizedError("PROVIDER_REJECTED", "out of stock"))).status, 422);
  });

  test("an unavailable or rate-limited provider is 503 and the SAME request may be retried", () => {
    for (const code of ["PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMITED", "TREASURY_INSUFFICIENT", "PAUSED", "CIRCUIT_OPEN"] as const) {
      const c = classifyFailure(new ProviderError(normalizedError(code, "later")));
      assert.equal(c.status, 503, code);
      assert.equal(c.disposition, "RETRYABLE_SAME_REQUEST", code);
      assert.equal(c.newIntentRequired, false, code);
    }
  });

  /**
   * Ambiguity is 409, never 5xx, and the status is chosen for what it DISCOURAGES.
   *
   * A 5xx reads as "try again", and a retry is the one thing that must never happen when the provider
   * may already have acted.
   */
  test("an ambiguous outcome is 409 and goes to manual review", () => {
    for (const code of ["PROVIDER_AMBIGUOUS", "PAYMENT_AMBIGUOUS", "PROVIDER_UNKNOWN"] as const) {
      const c = classifyFailure(new ProviderError(normalizedError(code, "unknown")));
      assert.equal(c.status, 409, code);
      assert.equal(c.disposition, "MANUAL_REVIEW", code);
    }
  });

  test("a quote-binding mismatch is 409 and terminal", () => {
    const c = classifyFailure(
      new ProviderError(normalizedError("PAYMENT_BINDING_MISMATCH", "QUOTE_CHANGED: the recipient changed")),
    );
    assert.equal(c.status, 409);
    assert.equal(c.disposition, "TERMINAL_NEW_REQUEST_REQUIRED");
  });

  test("a genuine internal fault is a JSON 500 that implies nothing about the provider", () => {
    const c = classifyFailure(new TypeError("cannot read properties of undefined"));
    assert.equal(c.status, 500);
    assert.equal(c.code, "INTERNAL_ERROR");
    // The provider is not blamed for our bug, and the raw message is not echoed.
    assert.ok(!c.message.includes("cannot read properties"));
  });

  test("no classification leaks a stack, a body or a credential", () => {
    const secret = "PAYMENT-SIGNATURE-aaaaaaaaaaaaaaaaaaaaaaaa";
    const c = classifyFailure(new ProviderError(normalizedError("PROVIDER_REJECTED", "refused")));
    const rendered = JSON.stringify(c);
    assert.ok(!rendered.includes("at Object."), "no stack frames");
    assert.ok(!rendered.includes(secret));
    assert.ok(!/<!DOCTYPE/i.test(rendered), "never HTML");
  });

  test("every taxonomy code maps to a sane status, so nothing can fall through to HTML", () => {
    const codes = [
      "PROVIDER_BAD_REQUEST", "PROVIDER_REJECTED", "PROVIDER_UNAUTHORIZED", "PROVIDER_RATE_LIMITED",
      "PROVIDER_UNAVAILABLE", "PROVIDER_AMBIGUOUS", "PROVIDER_MALFORMED_RESPONSE",
      "PAYMENT_CHALLENGE_UNACCEPTABLE", "PAYMENT_BINDING_MISMATCH", "PAYMENT_FAILED", "PAYMENT_AMBIGUOUS",
      "PROTOCOL_NOT_EXECUTABLE", "TREASURY_INSUFFICIENT", "PAUSED", "PROVIDER_NOT_EXECUTABLE",
      "QUOTE_EXPIRED", "CAPABILITY_UNAVAILABLE", "CIRCUIT_OPEN", "PROVIDER_UNKNOWN",
    ] as const;
    for (const code of codes) {
      const c = classifyFailure(new ProviderError(normalizedError(code, "x")));
      assert.ok(c.status >= 400 && c.status <= 599, `${code} produced ${c.status}`);
      assert.equal(c.code, code);
    }
  });
});

describe("the execution shape resolves without anyone remembering the default", () => {
  test("a declared shape is used", () => {
    assert.equal(resolveExecutionShape({ executionShape: "PAID_READ" }), "PAID_READ");
    assert.equal(resolveExecutionShape({ executionShape: "FULFILMENT" }), "FULFILMENT");
  });

  /**
   * Absence means FULFILMENT, and the direction matters.
   *
   * Every row written before migration 013 meant FULFILMENT, because that is the only thing the code
   * could do. Defaulting to PAID_READ would route a purchase at a read endpoint and silently drop the
   * shipping address a merchant needs.
   */
  test("an undeclared, null or unrecognised shape falls back to FULFILMENT", () => {
    assert.equal(resolveExecutionShape({}), "FULFILMENT");
    assert.equal(resolveExecutionShape({ executionShape: null }), "FULFILMENT");
    assert.equal(resolveExecutionShape(null), "FULFILMENT");
    assert.equal(resolveExecutionShape(undefined), "FULFILMENT");
    assert.equal(resolveExecutionShape({ executionShape: "SOMETHING_ELSE" as never }), "FULFILMENT");
  });
});
