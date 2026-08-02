import "server-only";
import { cookies } from "next/headers";
import { ACCOUNT_COOKIE, ASP_BASE, readAccountSession, type AccountSession } from "./seal";

/**
 * The bridge between the dashboard's session and the ASP's ACCOUNT session.
 *
 * WHY THERE ARE TWO SESSIONS AND NOT ONE
 *
 * The dashboard's `untch_session` proves a wallet signed in HERE. The ASP's account session proves a
 * wallet signed in THERE, against a nonce the ASP itself minted, and it is the only thing the ASP
 * will accept as authority over an account's approvals and policies. Reusing the dashboard cookie as
 * an ASP credential would mean the ASP trusting a claim from a different service about who signed
 * what — the same category of mistake as trusting a marketplace agent id from a header.
 *
 * So the wallet signs twice, and the second signature is the one the ASP verifies. That is a real
 * cost in clicks and it buys the property that matters: nothing but a signature over the ASP's own
 * nonce ever creates an account or authorises a decision.
 *
 * WHY THE BEARER NEVER REACHES THE BROWSER
 *
 * It is an authority token for money decisions. It lives in an httpOnly, same-site cookie sealed with
 * the same HMAC scheme as the dashboard session, and every call that uses it is made server-side. A
 * token in `localStorage` is a token any injected script can take, and the approval centre is
 * precisely the surface where that would matter.
 */

export * from "./seal";

export async function getAccountSession(): Promise<AccountSession | null> {
  return readAccountSession((await cookies()).get(ACCOUNT_COOKIE)?.value);
}

export interface AspResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly body: T;
}

/**
 * Call the ASP with the account bearer.
 *
 * Never throws on a non-2xx: the approval surface has to RENDER a refusal — an expired approval, a
 * superseded quote, a cross-account 404 — and an exception would turn each of those into an error
 * page that says nothing about which of them happened.
 */
export async function aspFetch<T = Record<string, unknown>>(
  path: string,
  session: AccountSession | null,
  init: RequestInit = {},
): Promise<AspResult<T>> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (session) headers.set("authorization", `Bearer ${session.bearer}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");

  try {
    const res = await fetch(`${ASP_BASE}${path}`, {
      ...init,
      headers,
      // Approvals change under you. A cached list would show a decided request as pending and offer a
      // button that cannot work.
      cache: "no-store",
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { code: "ASP_NON_JSON", message: text.slice(0, 400) };
    }
    return { ok: res.ok, status: res.status, body: body as T };
  } catch (err) {
    return {
      ok: false,
      status: 503,
      body: { code: "ASP_UNREACHABLE", message: `could not reach ${ASP_BASE}: ${(err as Error).message}` } as T,
    };
  }
}
