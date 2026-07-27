import type { NextRequest } from "next/server";

/**
 * Explicit same-origin enforcement for state-changing requests.
 *
 * The session cookie is already `SameSite=Lax`, which does block a cross-site POST, so this is
 * defence in depth rather than a fix for something currently exploitable. It is worth writing down
 * anyway for two reasons: `SameSite=Lax` is a property of a cookie set somewhere else, so a future
 * change to `cookieOptions` silently removes the only CSRF defence with nothing failing; and Lax
 * treats every subdomain of the site as same-site, so a compromised or attacker-controlled subdomain
 * is inside the boundary Lax draws but outside this one.
 *
 * `Origin` is checked before `Referer` because browsers send `Origin` on every cross-origin
 * state-changing request and it cannot be spoofed by page content. A request with NEITHER header is
 * refused rather than allowed: same-origin browser POSTs from this app always carry `Origin`, so a
 * bare request is either a non-browser client — which should use the ASP's bearer API, not the
 * dashboard's cookie session — or a stripped one.
 */

export interface OriginCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

export function checkSameOrigin(req: NextRequest): OriginCheck {
  // The Host the browser actually addressed. Behind Railway's TLS terminator the forwarded host is
  // the real one; `req.nextUrl.host` reflects the internal address and would never match.
  const expected = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;

  const origin = hostOf(req.headers.get("origin"));
  if (origin !== null) {
    return origin === expected
      ? { ok: true }
      : { ok: false, reason: `cross-origin request from ${origin}` };
  }

  const referer = hostOf(req.headers.get("referer"));
  if (referer !== null) {
    return referer === expected
      ? { ok: true }
      : { ok: false, reason: `cross-origin referer ${referer}` };
  }

  return { ok: false, reason: "no Origin or Referer header on a state-changing request" };
}
