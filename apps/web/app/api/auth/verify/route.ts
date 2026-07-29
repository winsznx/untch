import { NextResponse, type NextRequest } from "next/server";
import type { Hex } from "viem";
import {
  COOKIE_MAX_AGE,
  createSession,
  NONCE_COOKIE,
  operatorIdFor,
  readNonce,
  SESSION_COOKIE,
} from "../../../../lib/auth/session";
import { clearCookie, cookieOptions } from "../../../../lib/auth/server";
import { verifySiweSignin } from "../../../../lib/auth/verify";
import { REQUIRED_CHAIN_ID } from "../../../../lib/wallet/network";

/**
 * Verify a SIWE sign-in: the message's nonce must be the one this server minted (from the nonce cookie),
 * the signature must verify. Session is bound to the product chain. This establishes IDENTITY only;
 * on-chain writes still each need their own signed transaction.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as { message?: string; signature?: string } | null;
  if (!body?.message || !body?.signature) {
    return NextResponse.json({ ok: false, reason: "message and signature required" }, { status: 400 });
  }

  const expectedNonce = readNonce(req.cookies.get(NONCE_COOKIE)?.value);
  if (!expectedNonce) {
    return NextResponse.json({ ok: false, reason: "no valid nonce. Request a new one" }, { status: 400 });
  }

  const expectedDomain = req.headers.get("host") ?? new URL(req.url).host;
  const result = await verifySiweSignin({
    message: body.message,
    signature: body.signature as Hex,
    expectedNonce,
    expectedDomain,
  });
  if (!result.ok || !result.address) {
    return NextResponse.json({ ok: false, reason: result.reason ?? "verification failed" }, { status: 401 });
  }

  const res = NextResponse.json({
    ok: true,
    address: result.address,
    operatorId: operatorIdFor(result.address),
    chainId: REQUIRED_CHAIN_ID,
  });
  res.cookies.set(SESSION_COOKIE, createSession(result.address, REQUIRED_CHAIN_ID), cookieOptions(COOKIE_MAX_AGE.session));
  res.cookies.set(NONCE_COOKIE, "", clearCookie);
  return res;
}
