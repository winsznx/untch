import { isAddress, parseUnits } from "viem";

/**
 * Surface A — PRD §9 domain normalization rules.
 *
 * RFC 8785 (`./canonicalize`) fixes JSON *encoding*; these helpers fix domain *values*
 * before they enter that encoding, so the same logical fact always hashes to the same
 * bytes. Each rule below is a §9 requirement and is exercised in `test/domain.test.ts`.
 *
 * NUMERIC POLICY (the load-bearing decision — see README): every money amount and every
 * uint256 value is carried in canonical JSON as a **decimal string of integer base units**,
 * never a JSON number. JSON numbers are IEEE-754 doubles: they lose precision above 2^53
 * and serialize differently across languages. Strings of base-unit integers are exact and
 * language-neutral. `canonUint256` is the guard that enforces this at runtime by rejecting
 * `number` inputs outright.
 */

const UINT256_MAX = (1n << 256n) - 1n;

/**
 * §9: "Addresses normalized to lowercase hex for hashing (EIP-55 for display)."
 * Accepts any-case 20-byte hex address; returns it lowercased. Checksum case is display-only
 * and must never affect a hash.
 */
export function canonAddress(address: string): `0x${string}` {
  if (!isAddress(address, { strict: false })) {
    throw new TypeError(`canonAddress: not a 20-byte hex address: ${address}`);
  }
  return address.toLowerCase() as `0x${string}`;
}

/**
 * NUMERIC POLICY guard. Accepts a non-negative integer as a `bigint` or an already-decimal
 * string; returns its canonical decimal string (no leading zeros, no `+`). Rejects `number`
 * so a lossy JSON number can never reach a hash, and rejects out-of-range / non-integer /
 * negative values.
 */
export function canonUint256(value: bigint | string): string {
  let v: bigint;
  if (typeof value === "bigint") {
    v = value;
  } else if (typeof value === "string") {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new TypeError(`canonUint256: not a non-negative integer string: ${value}`);
    }
    v = BigInt(value);
  } else {
    throw new TypeError(
      "canonUint256: refusing a JS number — pass a bigint or decimal string (numeric policy)",
    );
  }
  if (v < 0n || v > UINT256_MAX) {
    throw new RangeError(`canonUint256: out of uint256 range: ${v}`);
  }
  return v.toString(10);
}

/**
 * §9: "Token amounts normalized to integer base units (per-token decimals from the verified
 * token list)." Converts a human-readable decimal amount (e.g. "1.5") plus that token's
 * decimals into the canonical base-unit string (e.g. USDT 6dp → "1500000"). The output is a
 * `canonUint256` string; callers put THIS into canonical JSON, never the display amount.
 */
export function moneyToBaseUnits(displayAmount: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError(`moneyToBaseUnits: invalid token decimals: ${decimals}`);
  }
  return canonUint256(parseUnits(displayAmount, decimals));
}

/**
 * §9: "Timestamps ISO-8601 UTC (`Z`)." Normalizes a `Date` or parseable date string to
 * `YYYY-MM-DDTHH:MM:SSZ` at UTC, second resolution. Sub-second precision is intentionally
 * dropped: hashed timestamps are second-resolution UTC by policy, so two records that differ
 * only in milliseconds hash identically and clock-format quirks (`+00:00` vs `Z`, offsets)
 * cannot fork a hash.
 */
export function canonTimestamp(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  if (Number.isNaN(ms)) {
    throw new TypeError(`canonTimestamp: not a valid date: ${String(value)}`);
  }
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * §9: "Resource URLs normalized (lowercase scheme/host, default ports stripped, path
 * preserved, query params sorted) before paramsHash/taskHash computation."
 *
 * Implementation: WHATWG `URL` lowercases scheme + host and drops default ports (80/443) on
 * its own; on top of that we sort query parameters by (name, value) so parameter order can
 * never fork a hash, and we drop the fragment (never sent on the wire, never part of the
 * resource identity). Path case is preserved.
 */
export function canonUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new TypeError(`canonUrl: not an absolute URL: ${url}`);
  }
  const params = [...u.searchParams.entries()].sort(([an, av], [bn, bv]) =>
    an < bn ? -1 : an > bn ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
  );
  const query = params.length
    ? "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";
  const port = u.port ? `:${u.port}` : "";
  return `${u.protocol}//${u.hostname}${port}${u.pathname}${query}`;
}
