import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryEscalationsRepo } from "../src/repo-memory";
import type { CreateEscalationRow } from "../src/repo";

/**
 * listByIntentIds is the dashboard's escalation-inbox scoping read: the operator's intents (from their
 * receipts) select exactly their escalations, case-insensitively, newest first. Same in-memory semantics
 * the Postgres repo enforces with `intent_id = ANY($1)`.
 */

function row(id: string, intentId: string): CreateEscalationRow {
  return {
    id,
    intentId,
    pollRef: `poll_${id}`,
    reason: "amount above escalate threshold",
    policyId: "12",
    amount: 8,
    token: "USDT",
    approvals: { channels: ["telegram"], dualChannelAbove: null, channelCaps: {}, escalationTimeoutMin: 60 },
    approvalCodeHash: `hash_${id}`,
    codeExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    initialLog: [],
  };
}

test("listByIntentIds returns only matching escalations, case-insensitive", async () => {
  const repo = new InMemoryEscalationsRepo();
  await repo.create(row("esc1", "0xAAA"));
  await repo.create(row("esc2", "0xBBB"));
  await repo.create(row("esc3", "0xCCC"));

  const got = await repo.listByIntentIds(["0xaaa", "0xccc"]);
  assert.deepEqual(got.map((e) => e.id).sort(), ["esc1", "esc3"]);
  assert.equal((await repo.listByIntentIds([])).length, 0);
  assert.equal((await repo.listByIntentIds(["0xdoesnotexist"])).length, 0);
});
