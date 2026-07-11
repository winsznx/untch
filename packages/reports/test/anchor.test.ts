import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import { UNTCH_RECEIPTS_ABI } from "@untch/receipt-writer";

/**
 * The raw-RPC verification path decodes an on-chain `AuditAnchored` log CLIENT-SIDE and matches its
 * fields. This test constructs a synthetic AuditAnchored log with viem and asserts it round-trips
 * through the SAME UNTCH_RECEIPTS_ABI the anchorer uses — the decode contract the live prove scripts
 * depend on, exercised with no chain.
 */

test("AuditAnchored round-trips through UNTCH_RECEIPTS_ABI (the raw-RPC decode contract)", () => {
  const reportHash = keccak256(toHex("some-report"));
  const agentId = toHex(7n, { size: 32 });
  const period = 1_752_192_000n; // some unix-second period code

  // All three fields are non-indexed → one topic (the selector), everything else in `data`.
  const topics = encodeEventTopics({ abi: UNTCH_RECEIPTS_ABI, eventName: "AuditAnchored" });
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }],
    [reportHash, agentId, period],
  );

  const decoded = decodeEventLog({ abi: UNTCH_RECEIPTS_ABI, data, topics: topics as [Hex, ...Hex[]] });
  assert.equal(decoded.eventName, "AuditAnchored");
  const args = decoded.args as unknown as { reportHash: Hex; agentId: Hex; period: bigint };
  assert.equal(args.reportHash.toLowerCase(), reportHash.toLowerCase());
  assert.equal(args.agentId.toLowerCase(), agentId.toLowerCase());
  assert.equal(args.period, period);
});

test("anchorAudit function is present in the ABI with the §10.3 signature", () => {
  const fn = UNTCH_RECEIPTS_ABI.find((i) => i.type === "function" && i.name === "anchorAudit");
  assert.ok(fn, "anchorAudit must be callable via the ABI");
  assert.deepEqual(
    (fn as { inputs: readonly { type: string }[] }).inputs.map((i) => i.type),
    ["bytes32", "bytes32", "uint64"],
  );
});
