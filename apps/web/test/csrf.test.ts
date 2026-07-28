import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NextRequest } from "next/server";
import { checkSameOrigin } from "../lib/auth/csrf";

/**
 * The dashboard's mutating routes authenticate with a cookie session, which means an attacker's page
 * can make the browser send that cookie. `SameSite=Lax` already stops a cross-site POST, so this is
 * defence in depth — but it is depth worth having: Lax lives on a cookie set in another file, and it
 * treats every subdomain as same-site, which is inside its boundary and outside this one.
 */

function req(headers: Record<string, string>, urlHost = "app.untch.xyz"): NextRequest {
  const h = new Headers(headers);
  return {
    headers: h,
    nextUrl: { host: urlHost } as NextRequest["nextUrl"],
  } as unknown as NextRequest;
}

describe("same-origin check", () => {
  test("a same-origin POST passes", () => {
    // #given a request the dashboard itself made
    const r = checkSameOrigin(req({ origin: "https://app.untch.xyz", host: "app.untch.xyz" }));
    // #then it is allowed
    assert.equal(r.ok, true);
  });

  test("a cross-origin POST is refused and names the origin", () => {
    // #given an attacker page that got the browser to send the session cookie
    const r = checkSameOrigin(req({ origin: "https://evil.example", host: "app.untch.xyz" }));
    // #then it is refused, and the reason says where it came from
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /evil\.example/);
  });

  test("a SUBDOMAIN is refused — this is the case SameSite=Lax lets through", () => {
    // Lax considers any subdomain same-site. A compromised or attacker-registered subdomain is
    // therefore inside Lax's boundary; it must not be inside this one.
    const r = checkSameOrigin(req({ origin: "https://evil.untch.xyz", host: "app.untch.xyz" }));
    assert.equal(r.ok, false);
  });

  test("the FORWARDED host is authoritative behind TLS termination", () => {
    // Railway terminates TLS, so nextUrl.host is the internal address and would never match a real
    // browser Origin. Getting this wrong would refuse every legitimate request.
    const r = checkSameOrigin(
      req({ origin: "https://app.untch.xyz", "x-forwarded-host": "app.untch.xyz", host: "internal:8080" }, "internal:8080"),
    );
    assert.equal(r.ok, true);
  });

  test("Referer is the fallback when Origin is absent", () => {
    const r = checkSameOrigin(req({ referer: "https://app.untch.xyz/dashboard/escalations", host: "app.untch.xyz" }));
    assert.equal(r.ok, true);
  });

  test("a cross-origin Referer is refused", () => {
    const r = checkSameOrigin(req({ referer: "https://evil.example/attack", host: "app.untch.xyz" }));
    assert.equal(r.ok, false);
  });

  test("Origin WINS over a conflicting Referer", () => {
    // Origin is sent by the browser on every cross-origin state-changing request and cannot be set
    // by page content. Preferring Referer would let a crafted Referer override the honest signal.
    const r = checkSameOrigin(
      req({ origin: "https://evil.example", referer: "https://app.untch.xyz/", host: "app.untch.xyz" }),
    );
    assert.equal(r.ok, false);
  });

  test("a request with NEITHER header is refused, not allowed by default", () => {
    // A same-origin browser POST from this app always carries Origin. A bare request is either a
    // non-browser client — which should use the ASP's bearer API — or a stripped one.
    const r = checkSameOrigin(req({ host: "app.untch.xyz" }));
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /no Origin or Referer/);
  });

  test("a malformed Origin does not throw and does not pass", () => {
    const r = checkSameOrigin(req({ origin: "not a url", host: "app.untch.xyz" }));
    assert.equal(r.ok, false);
  });

  test("a null Origin (sandboxed iframe, redirect) does not pass", () => {
    const r = checkSameOrigin(req({ origin: "null", host: "app.untch.xyz" }));
    assert.equal(r.ok, false);
  });
});
