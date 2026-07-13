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
import { X_LAYER_TESTNET_ID } from "../../../../lib/chain/chains";

/**
 * Verify a SIWE sign-in: the message's nonce must be the one this server minted (from the nonce cookie),
 * the signature must verify, and the chain must be X Layer testnet. On success, mint the session cookie
 * and burn the nonce cookie (single use). This establishes IDENTITY only; on-chain writes still each need
 * their own signed transaction.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as { message?: string; signature?: string } | null;
  if (!body?.message || !body?.signature) {
    return NextResponse.json({ ok: false, reason: "message and signature required" }, { status: 400 });
  }

  const expectedNonce = readNonce(req.cookies.get(NONCE_COOKIE)?.value);
  if (!expectedNonce) {
    return NextResponse.json({ ok: false, reason: "no valid nonce; request a new one" }, { status: 400 });
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
    chainId: X_LAYER_TESTNET_ID,
  });
  res.cookies.set(SESSION_COOKIE, createSession(result.address, X_LAYER_TESTNET_ID), cookieOptions(COOKIE_MAX_AGE.session));
  res.cookies.set(NONCE_COOKIE, "", clearCookie);
  return res;
}
