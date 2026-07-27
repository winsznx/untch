import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  MoneyAssetMismatchError,
  MoneyParseError,
  NegativeMoneyError,
  addMoney,
  applyBasisPoints,
  asset,
  cmpMoney,
  formatMoney,
  money,
  moneyFromJson,
  moneyToJson,
  parseMoney,
  subMoneyChecked,
  sumMoney,
  zeroMoney,
} from "../src/index";

const USDC = asset("base.usdc");
const USDT0 = asset("xlayer.usdt0");

describe("money — exact decimal parsing", () => {
  test("parses whole and fractional display strings to atomic units", () => {
    assert.equal(parseMoney("0", USDC).amount, 0n);
    assert.equal(parseMoney("1", USDC).amount, 1_000_000n);
    assert.equal(parseMoney("12.50", USDC).amount, 12_500_000n);
    assert.equal(parseMoney("0.000001", USDC).amount, 1n);
    assert.equal(parseMoney("20.00", USDC).amount, 20_000_000n);
  });

  test("round-trips through format without loss", () => {
    for (const display of ["0.000000", "1.000000", "12.500000", "0.000001", "999999.999999"]) {
      assert.equal(formatMoney(parseMoney(display, USDC)), display);
    }
  });

  test("REJECTS more fractional digits than the asset has decimals", () => {
    // Silently truncating "12.3456789" against a 6-decimal token would change the amount by an
    // amount nobody would ever notice. It is an error, not a rounding.
    assert.throws(() => parseMoney("12.3456789", USDC), MoneyParseError);
  });

  test("rejects exponent, separators, and non-numeric forms outright", () => {
    for (const bad of ["1e6", "1_000", "1,000.00", "0x10", "", "  ", "1.2.3", "abc", "+5", "Infinity", "NaN"]) {
      assert.throws(() => parseMoney(bad, USDC), MoneyParseError, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  test("handles negative amounts exactly", () => {
    const m = parseMoney("-3.250000", USDC);
    assert.equal(m.amount, -3_250_000n);
    assert.equal(formatMoney(m), "-3.250000");
  });

  test("a value beyond Number.MAX_SAFE_INTEGER survives intact", () => {
    // 10 billion USDC = 1e16 atomic units, which is > 2^53. A float representation would round it.
    const m = parseMoney("10000000000.000000", USDC);
    assert.equal(m.amount, 10_000_000_000_000_000n);
    assert.equal(formatMoney(m), "10000000000.000000");
  });
});

describe("money — arithmetic refuses to mix assets", () => {
  test("add/sub/cmp across different chains throws rather than coercing", () => {
    const a = parseMoney("1.00", USDC);
    const b = parseMoney("1.00", USDT0);
    assert.throws(() => addMoney(a, b), MoneyAssetMismatchError);
    assert.throws(() => cmpMoney(a, b), MoneyAssetMismatchError);
  });

  test("sumMoney rejects a member of the wrong asset", () => {
    assert.throws(
      () => sumMoney([parseMoney("1.00", USDC), parseMoney("1.00", USDT0)], USDC),
      MoneyAssetMismatchError,
    );
  });

  test("subMoneyChecked refuses to go negative", () => {
    assert.throws(
      () => subMoneyChecked(parseMoney("1.00", USDC), parseMoney("2.00", USDC)),
      NegativeMoneyError,
    );
  });

  test("sum of an empty list is a typed zero, not undefined", () => {
    assert.equal(sumMoney([], USDC).amount, zeroMoney(USDC).amount);
  });
});

describe("money — basis points require explicit rounding", () => {
  test("CEIL and FLOOR differ on a remainder, and neither is a default", () => {
    // 200 bps of 12.345678 = 0.24691356 → 246913.56 atomic units, i.e. a genuine remainder.
    const base = parseMoney("12.345678", USDC);
    const ceil = applyBasisPoints(base, 200, "CEIL");
    const floor = applyBasisPoints(base, 200, "FLOOR");
    assert.equal(ceil.amount, 246_914n);
    assert.equal(floor.amount, 246_913n);
  });

  test("an exact division is identical under both modes", () => {
    const base = parseMoney("10.000000", USDC);
    assert.equal(applyBasisPoints(base, 200, "CEIL").amount, applyBasisPoints(base, 200, "FLOOR").amount);
  });

  test("negative amounts floor and ceil in the true mathematical direction", () => {
    const base = money(-12_345_678n, USDC);
    assert.equal(applyBasisPoints(base, 200, "FLOOR").amount, -246_914n);
    assert.equal(applyBasisPoints(base, 200, "CEIL").amount, -246_913n);
  });

  test("out-of-range basis points are rejected", () => {
    const base = parseMoney("1.00", USDC);
    assert.throws(() => applyBasisPoints(base, -1, "CEIL"), RangeError);
    assert.throws(() => applyBasisPoints(base, 1.5, "CEIL"), RangeError);
  });

  test("charging CEIL and paying FLOOR never creates value", () => {
    // The house rule from money.ts: Untch rounds its own fee up and its payouts down, so the two
    // can never combine to synthesise a unit that did not exist.
    const base = parseMoney("0.000001", USDC);
    const charged = applyBasisPoints(base, 5000, "CEIL");
    const paid = applyBasisPoints(base, 5000, "FLOOR");
    assert.ok(charged.amount >= paid.amount);
  });
});

describe("money — JSON carries the asset, and amounts stay strings", () => {
  test("moneyToJson emits an atomic STRING plus full asset identity", () => {
    const json = moneyToJson(parseMoney("12.50", USDC));
    assert.equal(json.amount, "12500000");
    assert.equal(typeof json.amount, "string");
    assert.equal(json.display, "12.500000");
    assert.equal(json.token, "USDC");
    assert.equal(json.chain, "eip155:8453");
    assert.equal(json.decimals, 6);
    assert.equal(json.contract, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  test("moneyFromJson refuses a mismatched asset rather than reinterpreting the number", () => {
    const json = moneyToJson(parseMoney("12.50", USDC));
    assert.throws(() => moneyFromJson(json, USDT0), MoneyParseError);
  });

  test("moneyFromJson rejects a non-integer atomic amount", () => {
    const json = { ...moneyToJson(parseMoney("1.00", USDC)), amount: "1.5" };
    assert.throws(() => moneyFromJson(json, USDC), MoneyParseError);
  });
});
