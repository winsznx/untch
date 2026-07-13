import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePeriod, PeriodParseError } from "../src/period";

test("day period → [00:00Z, next 00:00Z) and periodCode = start unix seconds", () => {
  const p = parsePeriod("2026-07-11");
  assert.equal(p.kind, "day");
  assert.equal(p.fromIso, "2026-07-11T00:00:00.000Z");
  assert.equal(p.toIso, "2026-07-12T00:00:00.000Z");
  assert.equal(p.periodCode, BigInt(Math.floor(Date.parse("2026-07-11T00:00:00Z") / 1000)));
});

test("ISO week period → Monday 00:00Z to +7 days", () => {
  // 2026-W28 — Monday 2026-07-06 (ISO week date).
  const p = parsePeriod("2026-W28");
  assert.equal(p.kind, "week");
  assert.equal(p.fromIso, "2026-07-06T00:00:00.000Z");
  assert.equal(p.toIso, "2026-07-13T00:00:00.000Z");
  assert.equal(new Date(p.fromIso).getUTCDay(), 1, "week window starts on a Monday");
});

test("ISO week 1 anchors on the week containing the first Thursday", () => {
  // 2026-01-01 is a Thursday, so ISO week 1 of 2026 starts Monday 2025-12-29.
  const p = parsePeriod("2026-W01");
  assert.equal(p.fromIso, "2025-12-29T00:00:00.000Z");
});

test("malformed / invalid inputs are rejected, never guessed", () => {
  for (const bad of ["", "2026-7-11", "2026/07/11", "2026-W", "2026-W54", "2026-13-01", "2026-02-30", "notadate"]) {
    assert.throws(() => parsePeriod(bad), PeriodParseError, `expected reject: ${bad}`);
  }
  assert.throws(() => parsePeriod(undefined), PeriodParseError);
  assert.throws(() => parsePeriod(42 as unknown), PeriodParseError);
});
