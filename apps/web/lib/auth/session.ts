import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Address } from "viem";

/**
 * Session + nonce crypto for SIWE sign-in — a stateless, HMAC-signed cookie scheme (no session DB).
 *
 * Two short-lived signed blobs:
 *   • the NONCE cookie — a single-use SIWE nonce the server minted, so a signature can't be replayed
 *     and the message the operator signed is one this server actually issued;
 *   • the SESSION cookie — the proven identity {operatorId, address, chainId} + expiry, set only after
 *     the SIWE signature verifies.
 *
 * Both are HMAC-SHA256 over the payload with `AUTH_SECRET`. The core here is pure (it takes and returns
 * cookie strings) so it is equally usable from route handlers, server components, and tests; the
 * next/headers wiring lives in server.ts.
 */

const NONCE_TTL_MS = 10 * 60_000; // 10 min — matches the SIWE expiration window.
const SESSION_TTL_MS = 24 * 60 * 60_000; // 24 h operator session.

export const NONCE_COOKIE = "untch_siwe_nonce";
export const SESSION_COOKIE = "untch_session";

function secret(): string {
  const s = process.env.AUTH_SECRET?.trim();
  if (s) return s;
  // Dev/preview fallback: a per-process ephemeral secret. Sessions don't survive a restart, which is
  // correct for local dev and forces a real AUTH_SECRET in any deployed environment (sessions there
  // MUST survive across serverless invocations, so an unset secret is a misconfiguration, not a default).
  if (!globalThis.__untchDevSecret) globalThis.__untchDevSecret = randomBytes(32).toString("hex");
  return globalThis.__untchDevSecret;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Wrap a JSON payload as `<b64url(json)>.<b64url(hmac)>`. */
function seal(obj: unknown): string {
  const body = b64url(JSON.stringify(obj));
  return `${body}.${sign(body)}`;
}

/** Verify + parse a sealed blob. Returns null on any tamper/format failure (never throws). */
function open<T>(token: string | undefined): T | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

// ── Nonce ────────────────────────────────────────────────────────────────────────────────────────

interface NonceBlob {
  readonly nonce: string;
  readonly issuedAt: number;
}

export interface IssuedNonce {
  readonly nonce: string;
  readonly cookieValue: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/** Mint a single-use SIWE nonce and its signed cookie value. */
export function issueNonce(nonce: string, now = Date.now()): IssuedNonce {
  return {
    nonce,
    cookieValue: seal({ nonce, issuedAt: now } satisfies NonceBlob),
    issuedAt: new Date(now),
    expiresAt: new Date(now + NONCE_TTL_MS),
  };
}

/** The nonce a valid, unexpired nonce cookie carries, or null. */
export function readNonce(cookieValue: string | undefined, now = Date.now()): string | null {
  const blob = open<NonceBlob>(cookieValue);
  if (!blob) return null;
  if (now - blob.issuedAt > NONCE_TTL_MS) return null;
  return blob.nonce;
}

// ── Session ──────────────────────────────────────────────────────────────────────────────────────

export interface OperatorSession {
  /** Stable operator id (lowercased wallet) — the dashboard channel's bound handle and the approver id. */
  readonly operatorId: string;
  readonly address: Address;
  readonly chainId: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** Derive the operator id from a wallet — one wallet, one operator identity. */
export function operatorIdFor(address: Address): string {
  return `op_${address.toLowerCase()}`;
}

export function createSession(address: Address, chainId: number, now = Date.now()): string {
  const session: OperatorSession = {
    operatorId: operatorIdFor(address),
    address,
    chainId,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  return seal(session);
}

/** The live operator session a valid, unexpired session cookie carries, or null. */
export function readSession(cookieValue: string | undefined, now = Date.now()): OperatorSession | null {
  const session = open<OperatorSession>(cookieValue);
  if (!session) return null;
  if (now > session.expiresAt) return null;
  return session;
}

export const COOKIE_MAX_AGE = { nonce: NONCE_TTL_MS / 1000, session: SESSION_TTL_MS / 1000 } as const;

declare global {
  // eslint-disable-next-line no-var
  var __untchDevSecret: string | undefined;
}
