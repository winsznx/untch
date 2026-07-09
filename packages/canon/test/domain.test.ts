import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  canonAddress,
  canonTimestamp,
  canonUint256,
  canonUrl,
  moneyToBaseUnits,
} from "../src/domain";

/**
 * Surface A — PRD §9 domain normalization rules. Each `describe` block below is one §9 rule;
 * together they enforce that the same logical fact always presents identical bytes to the JCS
 * layer, regardless of address casing, money representation, clock format, or URL shape.
 */

const UINT256_MAX = (1n << 256n) - 1n;

describe("§9: addresses lowercased for hashing", () => {
  test("checksummed address is lowercased", () => {
    assert.equal(
      canonAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
      "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    );
  });
  test("already-lowercase address is unchanged", () => {
    assert.equal(
      canonAddress("0x1e4a5963abfd975d8c9021ce480b42188849d41d"),
      "0x1e4a5963abfd975d8c9021ce480b42188849d41d",
    );
  });
  test("checksummed and lowercase forms normalize identically", () => {
    assert.equal(
      canonAddress("0x1E4a5963aBFD975d8c9021ce480b42188849D41d"),
      canonAddress("0x1e4a5963abfd975d8c9021ce480b42188849d41d"),
    );
  });
  test("rejects non-addresses (bad length, non-hex, missing 0x)", () => {
    assert.throws(() => canonAddress("0x1234"), TypeError);
    assert.throws(() => canonAddress("f39fd6e51aad88f6f4ce6ab8827279cfffb92266"), TypeError);
    assert.throws(() => canonAddress("0xZZZZd6e51aad88f6f4ce6ab8827279cfffb92266"), TypeError);
  });
});

describe("§9 / numeric policy: money & uint256 as decimal STRINGS, never JS numbers", () => {
  test("accepts bigint and returns decimal string", () => {
    assert.equal(canonUint256(5000000n), "5000000");
    assert.equal(canonUint256(0n), "0");
  });
  test("accepts a decimal string and normalizes it", () => {
    assert.equal(canonUint256("42"), "42");
  });
  test("round-trips uint256 max exactly (would be lossy as an IEEE-754 number)", () => {
    assert.equal(canonUint256(UINT256_MAX), UINT256_MAX.toString(10));
  });
  test("REJECTS a JS number outright (the load-bearing guard)", () => {
    // @ts-expect-error — numeric policy forbids passing a JS number
    assert.throws(() => canonUint256(5000000), TypeError);
    // @ts-expect-error
    assert.throws(() => canonUint256(0), TypeError);
  });
  test("rejects negative, out-of-range, and non-integer strings", () => {
    assert.throws(() => canonUint256(-1n), RangeError);
    assert.throws(() => canonUint256(UINT256_MAX + 1n), RangeError);
    assert.throws(() => canonUint256("1.5"), TypeError);
    assert.throws(() => canonUint256("0x10"), TypeError);
    assert.throws(() => canonUint256("007"), TypeError);
  });
});

describe("§9: token amounts as integer base units (per-token decimals)", () => {
  test("USDT/USDG 6dp conversions", () => {
    assert.equal(moneyToBaseUnits("1.5", 6), "1500000");
    assert.equal(moneyToBaseUnits("1", 6), "1000000");
    assert.equal(moneyToBaseUnits("0", 6), "0");
  });
  test("output is a canonUint256 string (no float in the pipeline)", () => {
    assert.equal(typeof moneyToBaseUnits("0.05", 6), "string");
    assert.equal(moneyToBaseUnits("0.05", 6), "50000");
  });
  test("rejects invalid token decimals", () => {
    assert.throws(() => moneyToBaseUnits("1", -1), RangeError);
    assert.throws(() => moneyToBaseUnits("1", 1.5), RangeError);
  });
});

describe("§9: timestamps ISO-8601 UTC 'Z', second resolution", () => {
  test("Date normalizes to Z and drops sub-second precision", () => {
    assert.equal(canonTimestamp(new Date("2026-07-05T20:44:00.123Z")), "2026-07-05T20:44:00Z");
  });
  test("offset timestamps are converted to UTC", () => {
    assert.equal(canonTimestamp("2026-07-05T20:44:00+02:00"), "2026-07-05T18:44:00Z");
  });
  test("already-canonical Z timestamp is stable", () => {
    assert.equal(canonTimestamp("2026-07-05T20:44:00Z"), "2026-07-05T20:44:00Z");
  });
  test("rejects invalid dates", () => {
    assert.throws(() => canonTimestamp("not-a-date"), TypeError);
  });
});

describe("§9: URL normalization (lowercase scheme/host, strip default ports, sort query)", () => {
  test("lowercases scheme+host, strips default port, preserves path case, sorts query, drops fragment", () => {
    assert.equal(
      canonUrl("HTTPS://Example.COM:443/Path?b=2&a=1#frag"),
      "https://example.com/Path?a=1&b=2",
    );
  });
  test("strips default http port 80", () => {
    assert.equal(canonUrl("http://Example.com:80/x"), "http://example.com/x");
  });
  test("keeps non-default ports and sorts duplicate keys by (name,value)", () => {
    assert.equal(canonUrl("http://h:8080/a?z=1&a=2&a=1"), "http://h:8080/a?a=1&a=2&z=1");
  });
  test("param order cannot fork the hash", () => {
    assert.equal(canonUrl("http://h/p?a=1&b=2"), canonUrl("http://h/p?b=2&a=1"));
  });
  test("rejects relative / non-absolute URLs", () => {
    assert.throws(() => canonUrl("/relative/path"), TypeError);
  });
});
