import assert from "node:assert/strict";
import { test } from "node:test";
import { csvCell, toCsv, type ExportRow } from "../lib/dashboard/csv";

const row = (over: Partial<ExportRow>): ExportRow => ({
  type: "SPEND",
  amount: 8,
  token: "USDT",
  vendor: "sentinel-research",
  category: "research",
  createdAt: "2026-07-11T11:48:00.000Z",
  txHash: "0xabc",
  receiptId: "0x100",
  ...over,
});

test("toCsv writes a header and one line per row", () => {
  const csv = toCsv([row({}), row({ type: "BLOCK_SAVED", amount: 1.5 })]);
  const lines = csv.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "time,type,amount,token,vendor,category,receiptId,txHash");
  assert.ok(lines[1]!.startsWith("2026-07-11T11:48:00.000Z,SPEND,8,USDT"));
});

test("null txHash serializes as empty", () => {
  const csv = toCsv([row({ txHash: null })]);
  assert.ok(csv.split("\n")[1]!.endsWith(","));
});

test("csvCell quotes and escapes commas, quotes, and newlines", () => {
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell("a\nb"), '"a\nb"');
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell(null), "");
});
