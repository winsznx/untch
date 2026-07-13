import { cookies } from "next/headers";
import { readSession, SESSION_COOKIE, type OperatorSession } from "./session";

/**
 * next/headers wiring over the pure session core. `getServerSession` is what server components and
 * route handlers call to know who (if anyone) is signed in. Cookie flags are centralized here so the
 * nonce and session cookies are set consistently everywhere.
 */

export async function getServerSession(): Promise<OperatorSession | null> {
  const store = await cookies();
  return readSession(store.get(SESSION_COOKIE)?.value);
}

const isProd = process.env.NODE_ENV === "production";

/** HttpOnly, Lax, Secure-in-prod cookie options for a given max-age (seconds). */
export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProd,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** The options that clear a cookie (maxAge 0). */
export const clearCookie = { httpOnly: true, sameSite: "lax" as const, secure: isProd, path: "/", maxAge: 0 };
