import assert from "node:assert/strict";
import { test } from "node:test";
import { createPool, runMigrations } from "../src/db";
import { PgReceiptsRepo } from "../src/repo-pg";
import { makeDraft } from "./helpers";

/**
 * Real-Postgres integration test for `PgReceiptsRepo` — the SQL the hermetic unit tests don't
 * exercise (they use the in-memory repo). SKIPPED unless DATABASE_URL is set, so `pnpm test` stays
 * offline by default. Run against a real database with:
 *   DATABASE_URL=postgres://… pnpm --filter @untch/receipt-writer test
 * It creates its own rows and deletes them at the end (leaves the schema in place).
 */

const DATABASE_URL = process.env.DATABASE_URL;

test(
  "PgReceiptsRepo full lifecycle against real Postgres",
  { skip: DATABASE_URL ? false : "DATABASE_URL not set — skipping Postgres integration test" },
  async () => {
    const pool = createPool(DATABASE_URL!);
    const repo = new PgReceiptsRepo(pool);
    const drafts = [makeDraft(), makeDraft()];
    const ids = drafts.map((d) => d.onchain.receiptId);

    try {
      const applied = await runMigrations(pool);
      console.log(`  migrations: ${applied.length ? applied.join(", ") : "already up to date"}`);

      // insertDraft → QUEUED + ledger, durable.
      for (const d of drafts) await repo.insertDraft(d);
      const q0 = await repo.countReceiptsByStatus("QUEUED");
      assert.ok(q0 >= 2, "both drafts are QUEUED");

      const s0 = await repo.statusOf(ids[0]!);
      assert.equal(s0?.status, "QUEUED");

      // claim → BATCHED, real FOR UPDATE SKIP LOCKED path.
      const claimed = await repo.claimQueuedBatch(10);
      assert.ok(claimed && claimed.receipts.length >= 2, "claimed a batch");
      const batchId = claimed!.batchId;

      // submit → confirm.
      const txHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
      await repo.markSubmitted(batchId, txHash);
      const sSub = await repo.statusOf(ids[0]!);
      assert.equal(sSub?.status, "SUBMITTED");
      assert.equal(sSub?.txHash, txHash);

      await repo.markConfirmed(batchId, 7, 123456);
      const sConf = await repo.statusOf(ids[0]!);
      assert.equal(sConf?.status, "CONFIRMED");
      assert.equal(sConf?.blockNumber, 123456);
      assert.equal(sConf?.onchainBatchId, 7);

      // receiptsForBatch round-trips the bigint/numeric fields correctly.
      const back = await repo.receiptsForBatch(batchId);
      assert.equal(back.length, drafts.length);
      assert.equal(back[0]!.amount, 500_000n);
      assert.equal(back[0]!.policyId, 42n);
    } finally {
      // cleanup: remove this test's rows (ledger first — FK), leave the schema.
      const client = await pool.connect();
      try {
        await client.query("DELETE FROM ledger_entries WHERE receipt_id = ANY($1::text[])", [ids]);
        await client.query("DELETE FROM receipts WHERE receipt_id = ANY($1::text[])", [ids]);
      } finally {
        client.release();
      }
      await pool.end();
    }
  },
);
