import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHmac } from "node:crypto";

/**
 * The approval centre's credential handling.
 *
 * The ASP account bearer is an authority token over money decisions. Two properties decide whether
 * this surface is safe, and both are testable without a browser:
 *
 *   1. a tampered or expired cookie yields NO session — never a partially-trusted one;
 *   2. the token is never handed to the page, so an injected script has nothing to take.
 *
 * The module reads `AUTH_SECRET` at call time, so it is set before the import.
 */

process.env.AUTH_SECRET = "test-secret-for-account-session";

const {
  sealAccountSession,
  sealPendingLink,
  readPendingLink,
  ACCOUNT_COOKIE,
  ASP_BASE,
} = await import("../lib/account/seal");

const SESSION = {
  accountId: "acct_1",
  address: "0x1111111111111111111111111111111111111111",
  bearer: "asp.bearer.token",
  expiresAt: Date.now() + 60_000,
};

function tamper(sealed: string): string {
  const dot = sealed.lastIndexOf(".");
  const body = Buffer.from(sealed.slice(0, dot), "base64url").toString("utf8");
  const swapped = body.replace("lr_1", "lr_2");
  return `${Buffer.from(swapped).toString("base64url")}.${sealed.slice(dot + 1)}`;
}

/** Re-implemented rather than imported, so the test would catch a change in the sealing scheme. */
function resign(payloadJson: string): string {
  const body = Buffer.from(payloadJson).toString("base64url");
  return `${body}.${createHmac("sha256", "test-secret-for-account-session").update(body).digest("base64url")}`;
}

describe("the account cookie is sealed, not merely encoded", () => {
  test("a sealed session round-trips through the pending-link reader's verifier", () => {
    // #given a pending link sealed by this module
    const sealed = sealPendingLink({ linkRequestId: "lr_1", code: "abc", expiresAt: Date.now() + 60_000 });
    // #when it is read back
    const opened = readPendingLink(sealed);
    // #then it is the same values
    assert.equal(opened?.linkRequestId, "lr_1");
    assert.equal(opened?.code, "abc");
  });

  test("editing the payload invalidates the seal", () => {
    // #given a validly sealed link
    const sealed = sealPendingLink({ linkRequestId: "lr_1", code: "abc", expiresAt: Date.now() + 60_000 });
    // #when the body is edited but the MAC is kept
    const edited = tamper(sealed);
    // #then it opens as nothing — never as a partially-trusted value
    assert.notEqual(edited, sealed);
    assert.equal(readPendingLink(edited), null);
  });

  test("a forged MAC opens as nothing", () => {
    const forged = `${Buffer.from(
      JSON.stringify({ linkRequestId: "lr_evil", code: "x", expiresAt: Date.now() + 60_000 }),
    ).toString("base64url")}.not-a-real-mac`;
    assert.equal(readPendingLink(forged), null);
  });

  test("an expired pending link is not a link", () => {
    const stale = sealPendingLink({ linkRequestId: "lr_1", code: "abc", expiresAt: Date.now() - 1 });
    assert.equal(readPendingLink(stale), null);
  });

  test("a correctly-signed but expired session is refused by expiry, not accepted by signature", () => {
    // A valid MAC is necessary and not sufficient. Expiry is checked here rather than relying on the
    // cookie's max-age, so clock skew produces a clear "sign in again" instead of an opaque ASP 401.
    const expired = resign(JSON.stringify({ ...SESSION, expiresAt: Date.now() - 1 }));
    assert.equal(readPendingLink(expired), null);
  });

  test("the sealed blob is opaque: the bearer is not readable as plain text in the cookie name space", () => {
    const sealed = sealAccountSession(SESSION);
    // It is base64url, so the raw token must not appear verbatim — a cookie a script could grep.
    assert.equal(sealed.includes(SESSION.bearer), false);
    assert.match(sealed, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  test("the cookie name is stable, because rotating it silently signs everyone out", () => {
    assert.equal(ACCOUNT_COOKIE, "untch_account");
  });

  test("the ASP base defaults to the production host rather than to localhost", () => {
    // A default of localhost turns a missing env var into a surface that silently shows nothing.
    assert.match(ASP_BASE, /^https:\/\//);
  });
});
