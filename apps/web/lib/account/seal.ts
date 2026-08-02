import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sealing for the ASP account session, kept free of any server-only import.
 *
 * Split out of `asp.ts` so it can be unit-tested under plain node. That is not a testing convenience
 * dressed up as a design: the sealing scheme is the whole security property of this surface — a
 * tampered cookie must yield NO session rather than a partially-trusted one — and a property that
 * cannot be tested without a Next.js runtime is a property nobody checks.
 */

export const ACCOUNT_COOKIE = "untch_account";
export const LINK_COOKIE_NAME = "untch_account_link";
/** Shorter than the ASP's own 30-minute session, so a stale cookie fails here rather than there. */
export const ACCOUNT_TTL = 25 * 60_000;
const LINK_TTL_MS = 10 * 60_000;
export const LINK_TTL_SECONDS = LINK_TTL_MS / 1000;
export const ACCOUNT_TTL_SECONDS = ACCOUNT_TTL / 1000;

export const ASP_BASE = process.env.NEXT_PUBLIC_ASP_BASE_URL?.trim() || "https://asp.untch.xyz";

function secret(): string {
  const s = process.env.AUTH_SECRET?.trim();
  if (s) return s;
  if (!globalThis.__untchDevSecret) {
    // Same fallback the dashboard session uses: ephemeral per process, so a deployed environment
    // without AUTH_SECRET loses sessions on restart instead of quietly running with a known key.
    globalThis.__untchDevSecret = createHmac("sha256", "dev").update(String(process.pid)).digest("hex");
  }
  return globalThis.__untchDevSecret;
}

function seal(obj: unknown): string {
  const body = Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${body}.${createHmac("sha256", secret()).update(body).digest("base64url")}`;
}

export function open<T>(token: string | undefined): T | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(createHmac("sha256", secret()).update(body).digest("base64url"));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export interface AccountSession {
  readonly accountId: string;
  readonly address: string;
  readonly bearer: string;
  readonly expiresAt: number;
}

/** An in-flight link: what the ASP handed back, held only long enough for the wallet to sign. */
export interface PendingLink {
  readonly linkRequestId: string;
  readonly code: string;
  readonly expiresAt: number;
}

export function sealAccountSession(s: AccountSession): string {
  return seal(s);
}

export function sealPendingLink(p: PendingLink): string {
  return seal(p);
}

export function readPendingLink(raw: string | undefined): PendingLink | null {
  const p = open<PendingLink>(raw);
  return p && typeof p.linkRequestId === "string" && typeof p.code === "string" && p.expiresAt > Date.now()
    ? p
    : null;
}

/** A sealed account session, or null. Expiry is checked here, not left to the cookie's max-age. */
export function readAccountSession(raw: string | undefined): AccountSession | null {
  const s = open<AccountSession>(raw);
  if (!s || typeof s.bearer !== "string" || typeof s.accountId !== "string" || s.expiresAt <= Date.now()) return null;
  return s;
}
