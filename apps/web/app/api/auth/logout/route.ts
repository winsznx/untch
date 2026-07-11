import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../../../lib/auth/session";
import { clearCookie } from "../../../../lib/auth/server";

/** Sign out — clear the session cookie. The wallet stays connected in the browser; only identity drops. */
export async function POST(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", clearCookie);
  return res;
}
