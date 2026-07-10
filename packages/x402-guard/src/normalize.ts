/**
 * Deterministic, security-preserving field normalization.
 *
 * The Challenge Binding Check compares the AUTHORIZED binding against the PRESENTED one with exact
 * string equality. To avoid false REJECTs on purely cosmetic differences (a checksummed vs lowercase
 * address, `GET` vs `get`, a default `:443`), both sides pass through the SAME normalizer first.
 *
 * The rule is strict: normalize ONLY case and other semantically-irrelevant representation. Never
 * canonicalize in a way that could collapse two genuinely different values into one (that would hide
 * an attack). Amounts, nonces, expiries and policy ids are compared as raw trimmed strings — no
 * numeric coercion, so `"100"` and `"100.0"` and `"0x64"` stay distinct.
 */

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;

/** Lowercase a 0x address; leave anything that isn't a 20-byte hex address untouched (so it mismatches). */
export function normAddress(value: string): string {
  const v = value.trim();
  return HEX_ADDRESS.test(v) ? v.toLowerCase() : v;
}

/** Lowercase a 32-byte 0x hash; leave non-hashes untouched. */
export function normHash(value: string): string {
  const v = value.trim();
  return HEX_32.test(v) ? v.toLowerCase() : v;
}

/** Uppercase + trim an HTTP method. */
export function normMethod(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Normalize a URL for comparison: lowercase scheme + host, drop the default port and any fragment,
 * collapse a bare-root `/` path — but keep path, query, and their casing EXACTLY (a different path or
 * query is a real context swap and must survive). Non-URL strings are returned trimmed, unchanged.
 */
export function normUrl(value: string): string {
  const raw = value.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const scheme = u.protocol.toLowerCase();
  const host = u.hostname.toLowerCase();
  const defaultPort =
    (scheme === "https:" && u.port === "443") || (scheme === "http:" && u.port === "80");
  const port = u.port && !defaultPort ? `:${u.port}` : "";
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  return `${scheme}//${host}${port}${path}${u.search}`;
}

/** Trim; used for amount / nonce / expiry / policyId / metadataHash where the raw value is the value. */
export function normRaw(value: string): string {
  return value.trim();
}
