import { NextResponse, type NextRequest } from "next/server";
import { checkSameOrigin } from "../../../../lib/auth/csrf";
import { cookieOptions } from "../../../../lib/auth/server";
import {
  ACCOUNT_COOKIE,
  ACCOUNT_TTL,
  ACCOUNT_TTL_SECONDS,
  LINK_COOKIE_NAME,
  LINK_TTL_SECONDS,
  readPendingLink,
  sealAccountSession,
  sealPendingLink,
} from "../../../../lib/account/seal";
import { aspFetch } from "../../../../lib/account/asp";

/**
 * Link this wallet to an Untch account, in two steps against the ASP's own nonce.
 *
 * POST with no body  → starts a link. Returns the message the wallet must sign and stashes the
 *                      request id and one-time code in a short, httpOnly cookie. The code never
 *                      reaches the page, so a link cannot be completed by anything that only read
 *                      the screen.
 * POST {message,signature} → completes it. The ASP verifies the signature against the nonce IT
 *                      minted, creates or resolves the account, and returns a session token that is
 *                      sealed into an httpOnly cookie here.
 *
 * The dashboard's own SIWE session is not accepted as a substitute at any point. It proves a wallet
 * signed in HERE, and the ASP has no reason to take this service's word for that.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return NextResponse.json({ ok: false, code: "CROSS_ORIGIN", reason: origin.reason }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { message?: string; signature?: string; address?: string; chainId?: number }
    | null;

  if (!body?.message || !body?.signature) {
    /**
     * The address is sent to START, so the ASP composes the message it will later verify.
     *
     * The first version of this route expected a `message` field the ASP has never returned: link/start
     * hands back a nonce and a domain and leaves the caller to reproduce `buildLinkMessage` exactly.
     * Any client that formatted one line differently would produce a signature over a message the
     * server never authored, and it would surface as an opaque signature rejection rather than as the
     * drift it is. The server composes it now, and the browser signs what it was given.
     */
    if (typeof body?.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
      return NextResponse.json(
        {
          ok: false,
          code: "ADDRESS_REQUIRED",
          message: "connect a wallet first: the message names the address that will sign it",
        },
        { status: 400 },
      );
    }

    const started = await aspFetch<Record<string, unknown>>("/consumer/account/link/start", null, {
      method: "POST",
      body: JSON.stringify({
        requestedScopes: ["identity", "policy-authority"],
        address: body.address,
        ...(typeof body.chainId === "number" ? { chainId: body.chainId } : {}),
      }),
    });
    if (!started.ok) {
      return NextResponse.json({ ok: false, ...started.body }, { status: started.status });
    }
    const linkRequestId = String(started.body.linkRequestId ?? "");
    const code = String(started.body.oneTimeCode ?? started.body.code ?? "");
    const siweMessage = typeof started.body.siweMessage === "string" ? started.body.siweMessage : "";
    if (!linkRequestId || !code || !siweMessage) {
      return NextResponse.json(
        { ok: false, code: "LINK_START_INCOMPLETE", message: "the ASP did not return a link request, a code and a message" },
        { status: 502 },
      );
    }
    const res = NextResponse.json({
      ok: true,
      step: "sign",
      // The message and what it establishes. The one-time code is NOT here: it goes to the cookie, so
      // completing a link needs the browser session rather than merely what was on screen.
      message: siweMessage,
      authorityRequested: started.body.authorityRequested ?? null,
      expiresAt: started.body.expiresAt ?? null,
    });
    res.cookies.set(
      LINK_COOKIE_NAME,
      sealPendingLink({ linkRequestId, code, expiresAt: Date.now() + LINK_TTL_SECONDS * 1000 }),
      cookieOptions(LINK_TTL_SECONDS),
    );
    return res;
  }

  const pending = readPendingLink(req.cookies.get(LINK_COOKIE_NAME)?.value);
  if (!pending) {
    return NextResponse.json(
      { ok: false, code: "LINK_EXPIRED", message: "that link request has expired. Start again." },
      { status: 400 },
    );
  }

  const completed = await aspFetch<Record<string, unknown>>("/consumer/account/link/complete", null, {
    method: "POST",
    body: JSON.stringify({
      linkRequestId: pending.linkRequestId,
      code: pending.code,
      message: body.message,
      signature: body.signature,
    }),
  });
  if (!completed.ok) {
    return NextResponse.json({ ok: false, ...completed.body }, { status: completed.status });
  }

  const bearer = String(completed.body.token ?? completed.body.sessionToken ?? "");
  const accountId = String(completed.body.accountId ?? "");
  const address = String(completed.body.address ?? "");
  if (!bearer || !accountId) {
    return NextResponse.json(
      { ok: false, code: "LINK_NO_SESSION", message: "the link completed but returned no account session" },
      { status: 502 },
    );
  }

  const res = NextResponse.json({ ok: true, accountId, address });
  res.cookies.set(
    ACCOUNT_COOKIE,
    sealAccountSession({ accountId, address, bearer, expiresAt: Date.now() + ACCOUNT_TTL }),
    cookieOptions(ACCOUNT_TTL_SECONDS),
  );
  res.cookies.set(LINK_COOKIE_NAME, "", { ...cookieOptions(0), maxAge: 0 });
  return res;
}
