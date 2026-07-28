/**
 * Runtime validation for provider responses.
 *
 * Every byte a merchant sends us is untrusted input. It is validated here BEFORE it becomes a domain
 * object, and the validators are total: a field that fails is a `PROVIDER_MALFORMED_RESPONSE`, never
 * a silent `undefined` that surfaces three layers later as a purchase for the wrong amount.
 *
 * Hand-rolled rather than reaching for zod. Zod is already in the tree transitively (via
 * @okxweb3/x402-core) but is not a declared dependency of any Untch package, and the repository's
 * standing preference is to add a runtime dependency only when it earns its place. The surface here
 * is a dozen shapes; the validators below are ~150 lines and have no supply-chain footprint.
 *
 * The other reason to own this: `str()` runs provider text through the same sanitizer the error
 * taxonomy uses, so product titles and merchant messages are stripped of control characters at the
 * boundary. Prompt-injection content in a product description stays as inert data either way — the
 * control plane never feeds it to a model — but a title carrying ANSI escapes should not reach an
 * operator's terminal, and a bolted-on schema library would not do that for us.
 */

import { normalizedError, ProviderError, sanitizeProviderText } from "@untch/consumer-core";

export class ValidationError extends Error {
  constructor(
    public readonly path: string,
    reason: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = "ValidationError";
  }
}

/** Turn any validation failure into the normalized untrusted-response error. */
export function validated<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new ProviderError(
        normalizedError("PROVIDER_MALFORMED_RESPONSE", `${what} — ${err.message}`),
      );
    }
    throw err;
  }
}

export function obj(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ValidationError(path, `expected an object, got ${describe(v)}`);
  }
  return v as Record<string, unknown>;
}

export function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new ValidationError(path, `expected an array, got ${describe(v)}`);
  return v;
}

/** A required string. Sanitized: provider text never reaches a domain object with control chars. */
export function str(v: unknown, path: string, max = 2000): string {
  if (typeof v !== "string") throw new ValidationError(path, `expected a string, got ${describe(v)}`);
  return sanitizeProviderText(v, max);
}

export function optStr(v: unknown, path: string, max = 2000): string | null {
  if (v === null || v === undefined) return null;
  return str(v, path, max);
}

export function int(v: unknown, path: string): number {
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
    const n = Number.parseInt(v.trim(), 10);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new ValidationError(path, `expected a safe integer, got ${describe(v)}`);
}

/**
 * A monetary amount in ATOMIC units, as a decimal string. Accepts a string or a safe integer and
 * returns a bigint. Explicitly REFUSES a float: a provider that sends `19.99` where an atomic amount
 * belongs has either mis-specified its API or is quoting display units, and guessing which would put
 * a factor of a million into a purchase.
 */
export function atomic(v: unknown, path: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) {
      throw new ValidationError(path, `expected an integer atomic amount, got the float ${v}`);
    }
    return BigInt(v);
  }
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  throw new ValidationError(path, `expected an atomic amount (integer string), got ${describe(v)}`);
}

/** A DISPLAY decimal string, kept as a string so the caller parses it against a known asset. */
export function decimalString(v: unknown, path: string): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ValidationError(path, `expected a finite number, got ${v}`);
    // A provider that quotes 19.99 as a JSON number has already lost precision at its own
    // serializer. Render it back with enough digits to be exact for any sane currency, then let
    // parseMoney reject anything the asset cannot hold.
    return v.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (typeof v === "string") {
    const t = v.trim().replace(/^\$/, "");
    if (!/^-?\d+(\.\d+)?$/.test(t)) {
      throw new ValidationError(path, `expected an exact decimal, got ${JSON.stringify(v)}`);
    }
    return t;
  }
  throw new ValidationError(path, `expected a decimal amount, got ${describe(v)}`);
}

export function bool(v: unknown, path: string): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new ValidationError(path, `expected a boolean, got ${describe(v)}`);
}

export function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  const s = str(v, path, 100);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new ValidationError(path, `expected one of ${allowed.join("|")}, got ${JSON.stringify(s)}`);
  }
  return s as T;
}

/** A URL the response claims. Validated as absolute https so it can never be a javascript: or file:. */
export function httpsUrl(v: unknown, path: string): string {
  const s = str(v, path, 2048);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ValidationError(path, "not a valid absolute URL");
  }
  if (u.protocol !== "https:") throw new ValidationError(path, `scheme ${u.protocol} is not permitted`);
  return u.toString();
}

export function optHttpsUrl(v: unknown, path: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  return httpsUrl(v, path);
}

export function get(o: Record<string, unknown>, key: string): unknown {
  return o[key];
}

/** Read a nested path, returning undefined rather than throwing on a missing intermediate. */
export function dig(v: unknown, ...path: readonly string[]): unknown {
  let cur: unknown = v;
  for (const key of path) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array(${v.length})`;
  return typeof v;
}
