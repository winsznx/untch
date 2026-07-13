import { NextResponse } from "next/server";
import { generateSiweNonce } from "viem/siwe";
import { COOKIE_MAX_AGE, issueNonce, NONCE_COOKIE } from "../../../../lib/auth/session";
import { cookieOptions } from "../../../../lib/auth/server";

/** Mint a single-use SIWE nonce and stash it in a signed HttpOnly cookie for /verify to check. */
export async function GET(): Promise<NextResponse> {
  const issued = issueNonce(generateSiweNonce());
  const res = NextResponse.json({ nonce: issued.nonce, expiresAt: issued.expiresAt.toISOString() });
  res.cookies.set(NONCE_COOKIE, issued.cookieValue, cookieOptions(COOKIE_MAX_AGE.nonce));
  return res;
}
