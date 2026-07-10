import assert from "node:assert/strict";
import { test } from "node:test";
import { codeMatchesHash, generateCode, hashCode } from "../src/codes";

test("hashCode is deterministic and hides the plaintext", () => {
  const code = "deadbeefdeadbeefdeadbeef";
  assert.equal(hashCode(code), hashCode(code));
  assert.notEqual(hashCode(code), code);
  assert.equal(hashCode(code).length, 64); // sha256 hex
});

test("codeMatchesHash is true for the right code, false for a wrong one", () => {
  const code = generateCode();
  const h = hashCode(code);
  assert.equal(codeMatchesHash(code, h), true);
  assert.equal(codeMatchesHash(generateCode(), h), false);
});

test("codeMatchesHash never throws on malformed stored hash", () => {
  assert.equal(codeMatchesHash("abc", "not-hex-zzzz"), false);
  assert.equal(codeMatchesHash("abc", ""), false);
});

test("generateCode is unique enough and hex", () => {
  const a = generateCode();
  const b = generateCode();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]+$/);
});
