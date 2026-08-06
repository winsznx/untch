/**
 * Discord's Ed25519 interaction signature, verified on Workers.
 *
 * WHY THIS IS A SEPARATE FILE RATHER THAN A BRANCH INSIDE THE EXISTING ONE
 *
 * The Node implementation calls `crypto.verify(null, …)` with a hand-built SPKI wrapper, because
 * `node:crypto` will not accept a bare 32-byte Ed25519 key. Workers has no such call. It has WebCrypto,
 * which supports Ed25519 natively and imports the raw 32 bytes directly — so the SPKI prefix is not
 * ported, it is deleted, because it was never part of the protocol.
 *
 * The primitive differs. NOTHING ELSE DOES. The refusal vocabulary, the ordering of the checks and the
 * five-minute freshness window are identical to `verifyDiscordSignature` in
 * `consumer/discord-interactions.ts`, and a shared test asserts the two agree refusal-for-refusal.
 * That is the property worth protecting: two implementations of a signature check that disagree about
 * which requests are valid is strictly worse than either one alone.
 *
 * WHAT THE SIGNATURE IS FOR
 *
 * Discord signs `timestamp + rawBody` with the application's public key. A valid signature is Discord
 * asserting "this user, in this message, pressed this button", so identity never comes from the body —
 * it comes from bytes that were signed. Which means the exact bytes must survive to this function.
 * Parsing to JSON and re-serialising changes them: key order, whitespace and unicode escapes are all
 * free to move, and the signature would never verify again.
 */

/** Discord rejects a signature older than this; so do we, so a captured request cannot be held. */
export const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

export type DiscordSignatureRefusal =
  | "SIGNATURE_MISSING"
  | "SIGNATURE_MALFORMED"
  | "PUBLIC_KEY_MALFORMED"
  | "TIMESTAMP_MALFORMED"
  | "TIMESTAMP_STALE"
  | "SIGNATURE_INVALID";

export type DiscordSignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: DiscordSignatureRefusal };

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Verify Discord's Ed25519 signature over `timestamp + rawBody`.
 *
 * Fails closed on every malformed input rather than throwing: a thrown error inside a signature check
 * becomes a 500, and Discord reads a 500 as "try again", which turns a forged request into a retry
 * loop. A refusal is the correct answer and the one this returns.
 */
export async function verifyDiscordSignatureWorkers(args: {
  readonly publicKeyHex: string;
  readonly signatureHex: string | undefined;
  readonly timestamp: string | undefined;
  readonly rawBody: Uint8Array;
  readonly nowMs: number;
}): Promise<DiscordSignatureVerdict> {
  if (!args.signatureHex || !args.timestamp) return { ok: false, refusal: "SIGNATURE_MISSING" };
  if (!/^[0-9a-fA-F]{128}$/.test(args.signatureHex)) return { ok: false, refusal: "SIGNATURE_MALFORMED" };
  if (!/^[0-9a-fA-F]{64}$/.test(args.publicKeyHex)) return { ok: false, refusal: "PUBLIC_KEY_MALFORMED" };

  /**
   * The timestamp is covered by the signature, so it cannot be edited — but a VALID captured request
   * could otherwise be replayed indefinitely. Discord's own window is five minutes.
   */
  const tsSec = Number(args.timestamp);
  if (!Number.isFinite(tsSec)) return { ok: false, refusal: "TIMESTAMP_MALFORMED" };
  if (Math.abs(args.nowMs - tsSec * 1000) > MAX_SIGNATURE_AGE_MS) {
    return { ok: false, refusal: "TIMESTAMP_STALE" };
  }

  try {
    /** Raw 32 bytes. WebCrypto supports Ed25519 directly, so no SPKI wrapper is needed. */
    const key = await crypto.subtle.importKey("raw", hexToBytes(args.publicKeyHex), { name: "Ed25519" }, false, [
      "verify",
    ]);

    const timestampBytes = new TextEncoder().encode(args.timestamp);
    const signed = new Uint8Array(timestampBytes.length + args.rawBody.length);
    signed.set(timestampBytes, 0);
    signed.set(args.rawBody, timestampBytes.length);

    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(args.signatureHex), signed);
    return ok ? { ok: true } : { ok: false, refusal: "SIGNATURE_INVALID" };
  } catch {
    return { ok: false, refusal: "SIGNATURE_INVALID" };
  }
}

/** Raised when a body has already been consumed before verification. See `readRawBodyOnce`. */
export const DISCORD_RAW_BODY_CONSUMED = "DISCORD_RAW_BODY_CONSUMED" as const;

/**
 * Read the exact bytes Discord signed, exactly once.
 *
 * THE FAILURE THIS EXISTS TO MAKE LOUD
 *
 * On Express the equivalent bug is a JSON body parser mounted above the route: `req.body` arrives as a
 * parsed object, the original bytes are gone, and every signature fails forever with no indication of
 * why. The Node handler names that case `DISCORD_RAW_BODY_CONSUMED` rather than refusing quietly.
 *
 * On Workers the shape is different but the bug is identical: a `Request` body is a one-shot stream, so
 * any middleware, router or framework that calls `.json()` or `.text()` first leaves `bodyUsed` true
 * and the bytes unrecoverable. This refuses with the same named error rather than verifying against an
 * empty buffer — which would look like Discord sending bad signatures.
 */
export async function readRawBodyOnce(
  request: Request,
): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly refusal: typeof DISCORD_RAW_BODY_CONSUMED }> {
  if (request.bodyUsed) return { ok: false, refusal: DISCORD_RAW_BODY_CONSUMED };
  return { ok: true, bytes: new Uint8Array(await request.arrayBuffer()) };
}
