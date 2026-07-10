import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Single-use approval codes (§27). Every escalation embeds one; only its sha256 hash is ever stored,
 * so a leaked database row can't be used to forge an approval, and a code is compared in constant time
 * to avoid a timing side-channel. TTL = the escalation timeout (the code lives exactly as long as the
 * escalation is answerable — an approval after expiry is rejected, §7.2).
 */

/** Generate a fresh code. URL/callback-safe (base32-ish hex), short enough for a Telegram button payload. */
export function generateCode(): string {
  return randomBytes(12).toString("hex");
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Constant-time compare of a presented code against a stored hash. Non-throwing; false on any mismatch. */
export function codeMatchesHash(code: string, expectedHash: string): boolean {
  const presented = Buffer.from(hashCode(code), "hex");
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, "hex");
  } catch {
    return false;
  }
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
