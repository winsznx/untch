import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, stringToBytes } from "viem";
import { canonicalize, hashCanonicalJson } from "../src/canonicalize";

/**
 * Surface A — RFC 8785 (JCS) conformance.
 *
 * We wrap the RFC 8785 reference implementation (`canonicalize`), so per the D0.5 brief we
 * re-run the RFC's own behaviors against the wrapper to guard against wrapper bugs and
 * version drift. Each vector below exercises a specific RFC 8785 §3.2 requirement; the
 * expected strings were byte-verified against the reference implementation and hand-checked
 * against the spec. Lineage: erdtman/canonicalize's published testdata
 * (arrays/french/structures/unicode/weird) covers the same requirement set.
 *
 * Passing these = any conforming RFC 8785 implementation, in any language, produces the same
 * bytes for the same value, which is what makes `hashCanonicalJson` cross-implementation safe.
 */

interface Vector {
  name: string;
  input: unknown;
  /** Expected RFC 8785 canonical form. Non-ASCII written with \u escapes for source safety. */
  expected: string;
}

const VECTORS: Vector[] = [
  { name: "empty object", input: {}, expected: "{}" },
  { name: "empty array", input: [], expected: "[]" },
  {
    name: "literals preserved (true/false/null)",
    input: { a: true, b: false, c: null },
    expected: '{"a":true,"b":false,"c":null}',
  },
  {
    name: "object keys sorted; array order preserved; nested sorted",
    input: { b: 1, a: 2, nested: { d: 3, c: 4 }, arr: [3, 1, 2] },
    expected: '{"a":2,"arr":[3,1,2],"b":1,"nested":{"c":4,"d":3}}',
  },
  {
    name: "numeric-looking keys sort lexicographically, not numerically",
    input: { "10": 1, "2": 1, "1": 1 },
    expected: '{"1":1,"10":1,"2":1}',
  },
  {
    name: "ES6 number formatting (trailing-zero drop, -0 => 0, 1e21 exponential)",
    input: { z: 1.0, y: -0, x: 1e21, w: 0.1, v: 100, u: -5, t: 1.5 },
    expected: '{"t":1.5,"u":-5,"v":100,"w":0.1,"x":1e+21,"y":0,"z":1}',
  },
  {
    name: "string escaping: short escapes \\b\\t\\n\\f\\r, escape \" and \\, leave / and printable Unicode literal",
    input: { s: " \b\t\n\f\r\"\\/é\u{1F600}" },
    expected: '{"s":" \\b\\t\\n\\f\\r\\"\\\\/é\u{1F600}"}',
  },
  {
    name: "key ordering is UTF-16 code unit, not code point (non-BMP surrogate edge)",
    // a=U+0061, é=U+00E9, 😀=U+1F600 (first UTF-16 unit 0xD83D), U+F8FF.
    // By code point 😀(0x1F600) > ; by UTF-16 unit 0xD83D < 0xF8FF, so 😀 sorts FIRST.
    input: { "é": 1, a: 2, "": 3, "\u{1F600}": 4 },
    expected: '{"a":2,"é":1,"\u{1F600}":4,"":3}',
  },
];

describe("RFC 8785 (JCS) conformance", () => {
  for (const v of VECTORS) {
    test(v.name, () => {
      assert.equal(canonicalize(v.input), v.expected);
    });
  }

  test("canonical form is independent of source key insertion order", () => {
    assert.equal(canonicalize({ a: 1, b: 2, c: 3 }), canonicalize({ c: 3, b: 2, a: 1 }));
    assert.equal(
      canonicalize({ z: { m: 1, a: 2 }, a: [1, 2] }),
      canonicalize({ a: [1, 2], z: { a: 2, m: 1 } }),
    );
  });

  test("canonicalize is stable across repeated calls (in-process determinism)", () => {
    const obj = { b: [3, 2, 1], a: { "2": "x", "1": "y" } };
    assert.equal(canonicalize(obj), canonicalize(obj));
  });

  test("rejects values with no canonical form (top-level undefined)", () => {
    assert.throws(() => canonicalize(undefined), TypeError);
  });

  test("hashCanonicalJson = keccak256(utf8(canonical)) and is order-independent", () => {
    const expectedHash = keccak256(stringToBytes('{"a":2,"b":1}'));
    assert.equal(hashCanonicalJson({ b: 1, a: 2 }), expectedHash);
    assert.equal(hashCanonicalJson({ a: 2, b: 1 }), expectedHash);
  });
});
