import jcs from "canonicalize";
import { keccak256, stringToBytes, type Hex } from "viem";

/**
 * Surface A — canonical JSON hashing (PRD §9).
 *
 * `canonicalize` is a thin, owned wrapper over the RFC 8785 (JSON Canonicalization
 * Scheme) reference implementation. We wrap rather than call the library directly so the
 * project has one boundary to (a) pin behavior, (b) fail loudly on non-serializable input,
 * and (c) swap the underlying implementation without touching call sites. The wrapper is
 * re-verified against the RFC's own test vectors in `test/rfc8785.vectors.test.ts`.
 *
 * Determinism note: RFC 8785 fixes object-key order (UTF-16 code-unit sort), number
 * formatting (ECMAScript `Number::toString`), and string escaping. The output is therefore
 * byte-identical across runs, processes, machines, and any conforming implementation in any
 * language — which is exactly what makes the resulting keccak hash cross-implementation
 * safe.
 */

/** The RFC 8785 default export is `(input: unknown) => string | undefined`. */
type JcsFn = (input: unknown) => string | undefined;

const serialize = jcs as unknown as JcsFn;

/**
 * Return the RFC 8785 canonical JSON string for `value`.
 *
 * @throws if `value` (or, at the top level, a value that JSON cannot represent — `undefined`,
 * a function, or a symbol) has no canonical form. Nested `undefined`/functions follow
 * `JSON.stringify` semantics (object members dropped, array holes become `null`); callers
 * that need those rejected should validate before hashing.
 */
export function canonicalize(value: unknown): string {
  const out = serialize(value);
  if (out === undefined) {
    throw new TypeError(
      "canonicalize: value has no RFC 8785 canonical form (top-level undefined, function, or symbol)",
    );
  }
  return out;
}

/**
 * `hashCanonicalJson(value) = keccak256(utf8(canonicalize(value)))`.
 *
 * The hash is taken over the UTF-8 bytes of the canonical JSON string. Use this for every
 * hash-bearing JSON record in §9 — policies, acceptance criteria, redacted metadata. The
 * caller is responsible for putting domain values into canonical form first (lowercased
 * addresses, base-unit money **strings**, ISO-8601 `Z` timestamps, normalized URLs) using
 * the helpers in `./domain` — see the numeric policy in the package README.
 */
export function hashCanonicalJson(value: unknown): Hex {
  return keccak256(stringToBytes(canonicalize(value)));
}
