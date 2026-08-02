import type { Address, Hex } from "viem";
import type { Pool } from "./db";
import type { ClaimedBatch, ReceiptsRepo } from "./repo";
import type {
  BatchRow,
  BatchStatus,
  ReceiptDraft,
  ReceiptOnchain,
  ReceiptStatus,
  ReceiptStatusView,
} from "./types";

/**
 * Postgres-backed `ReceiptsRepo`. All multi-row transitions are wrapped in transactions; the QUEUED
 * claim uses `FOR UPDATE SKIP LOCKED` so multiple worker replicas can batch concurrently without ever
 * double-anchoring a receipt.
 */

interface ReceiptDbRow {
  receipt_id: string;
  policy_id: string;
  policy_hash: string;
  agent_id: string;
  vendor_id: string;
  amount: string;
  token: string;
  category: string;
  pay_type: number;
  intent_hash: string;
  task_hash: string;
  decision: number;
  verify_result: number;
  proof_tier: number;
  metadata_hash: string;
}

function rowToOnchain(r: ReceiptDbRow): ReceiptOnchain {
  return {
    receiptId: r.receipt_id as Hex,
    policyId: BigInt(r.policy_id),
    policyHash: r.policy_hash as Hex,
    agentId: r.agent_id as Hex,
    vendorId: r.vendor_id as Hex,
    amount: BigInt(r.amount),
    token: r.token as Address,
    category: r.category as Hex,
    payType: r.pay_type,
    intentHash: r.intent_hash as Hex,
    taskHash: r.task_hash as Hex,
    decision: r.decision,
    verifyResult: r.verify_result,
    proofTier: r.proof_tier,
    metadataHash: r.metadata_hash as Hex,
  };
}

export class PgReceiptsRepo implements ReceiptsRepo {
  constructor(private readonly pool: Pool) {}

  async insertDraft(draft: ReceiptDraft): Promise<void> {
    const o = draft.onchain;
    const l = draft.ledger;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO receipts (
           receipt_id, kind, status, intent_hash, policy_id, policy_hash, agent_id, vendor_id,
           amount, token, category, pay_type, task_hash, decision, verify_result, proof_tier,
           metadata_hash, provenance
         ) VALUES ($1,$2,'QUEUED',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (receipt_id) DO NOTHING`,
        [
          o.receiptId,
          draft.kind,
          o.intentHash,
          o.policyId.toString(),
          o.policyHash,
          o.agentId,
          o.vendorId,
          o.amount.toString(),
          o.token,
          o.category,
          o.payType,
          o.taskHash,
          o.decision,
          o.verifyResult,
          o.proofTier,
          o.metadataHash,
          draft.provenance ?? null,
        ],
      );
      // A VERIFY receipt moves no money — it has no ledger entry. Only DECISION receipts do.
      if (l) {
        await client.query(
          `INSERT INTO ledger_entries (
             receipt_id, agent_id, type, amount, token, counterparty, day_key, category_key, vendor_key
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            o.receiptId,
            l.agentId,
            l.type,
            l.amount,
            l.token,
            l.counterparty,
            l.dayKey,
            l.categoryKey,
            l.vendorKey,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async claimQueuedBatch(limit: number): Promise<ClaimedBatch | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<ReceiptDbRow>(
        /*
         * A receipt annotated ineligible for anchoring is never claimed into a batch.
         *
         * Migration 022 also refuses the anchor at the table, so this clause is not the guarantee —
         * it is the difference between never batching the row and batching it, submitting, and
         * having the whole batch rejected because one member cannot be anchored. The predicate is
         * written out rather than reading `receipts_business` because this SELECT takes row locks,
         * and a view with a subquery is not lockable.
         */
        `SELECT receipt_id, policy_id, policy_hash, agent_id, vendor_id, amount, token, category,
                pay_type, intent_hash, task_hash, decision, verify_result, proof_tier, metadata_hash
           FROM receipts r
          WHERE status = 'QUEUED'
            AND NOT EXISTS (
              SELECT 1 FROM untch_artifact_annotations a
               WHERE a.artifact_kind = 'RECEIPT' AND a.artifact_ref = r.receipt_id
                 AND a.eligible_for_anchoring = false)
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      if (claimed.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const ids = claimed.rows.map((r) => r.receipt_id);
      const batch = await client.query<{ id: number }>(
        `INSERT INTO batches (status, receipt_count) VALUES ('PENDING', $1) RETURNING id`,
        [ids.length],
      );
      const batchId = batch.rows[0]!.id;
      await client.query(
        `UPDATE receipts SET status = 'BATCHED', batch_id = $1, updated_at = now()
          WHERE receipt_id = ANY($2::text[])`,
        [batchId, ids],
      );
      await client.query("COMMIT");
      return { batchId, receipts: claimed.rows.map(rowToOnchain) };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async markSubmitted(batchId: number, txHash: Hex): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE batches SET status = 'SUBMITTED', tx_hash = $2, submitted_at = now(),
                            updated_at = now()
          WHERE id = $1`,
        [batchId, txHash],
      );
      await client.query(
        `UPDATE receipts SET status = 'SUBMITTED', tx_hash = $2, updated_at = now()
          WHERE batch_id = $1`,
        [batchId, txHash],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async markConfirmed(
    batchId: number,
    onchainBatchId: number | null,
    blockNumber: number,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE batches SET status = 'CONFIRMED', onchain_batch_id = $2, confirmed_block = $3,
                            confirmed_at = now(), updated_at = now()
          WHERE id = $1`,
        [batchId, onchainBatchId, blockNumber],
      );
      await client.query(
        `UPDATE receipts SET status = 'CONFIRMED', block_number = $2, updated_at = now()
          WHERE batch_id = $1`,
        [batchId, blockNumber],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async recordBatchError(batchId: number, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE batches SET attempts = attempts + 1, last_error = $2, updated_at = now() WHERE id = $1`,
      [batchId, message.slice(0, 1000)],
    );
  }

  async redriveDegraded(batchId: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      /**
       * The status guard lives in the WHERE clause, not in a prior SELECT.
       *
       * A read-then-write would let two operators re-drive the same batch concurrently, or let one
       * re-drive a batch that confirmed between the read and the write — double-anchoring a receipt
       * that is already on chain. `rowCount === 1` IS the proof that this call did the transition.
       */
      const { rowCount } = await client.query(
        `UPDATE batches SET status = 'PENDING', attempts = 0, last_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'DEGRADED_UNANCHORED'`,
        [batchId],
      );
      if ((rowCount ?? 0) !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      // The receipts go back to BATCHED, not QUEUED: they still belong to this batch, and QUEUED
      // would make `claimQueuedBatch` sweep them into a SECOND batch alongside this one.
      await client.query(
        `UPDATE receipts SET status = 'BATCHED', updated_at = now() WHERE batch_id = $1`,
        [batchId],
      );
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async markDegraded(batchId: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE batches SET status = 'DEGRADED_UNANCHORED', updated_at = now() WHERE id = $1`,
        [batchId],
      );
      await client.query(
        `UPDATE receipts SET status = 'DEGRADED_UNANCHORED', updated_at = now() WHERE batch_id = $1`,
        [batchId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async batchesByStatus(status: BatchStatus): Promise<BatchRow[]> {
    const res = await this.pool.query<{
      id: number;
      status: BatchStatus;
      receipt_count: number;
      tx_hash: string | null;
      onchain_batch_id: string | null;
      attempts: number;
    }>(
      `SELECT id, status, receipt_count, tx_hash, onchain_batch_id, attempts
         FROM batches WHERE status = $1 ORDER BY created_at`,
      [status],
    );
    return res.rows.map((r) => ({
      id: r.id,
      status: r.status,
      receiptCount: r.receipt_count,
      txHash: (r.tx_hash as Hex | null) ?? null,
      onchainBatchId: r.onchain_batch_id === null ? null : Number(r.onchain_batch_id),
      attempts: r.attempts,
    }));
  }

  async receiptsForBatch(batchId: number): Promise<ReceiptOnchain[]> {
    const res = await this.pool.query<ReceiptDbRow>(
      `SELECT receipt_id, policy_id, policy_hash, agent_id, vendor_id, amount, token, category,
              pay_type, intent_hash, task_hash, decision, verify_result, proof_tier, metadata_hash
         FROM receipts WHERE batch_id = $1 ORDER BY created_at`,
      [batchId],
    );
    return res.rows.map(rowToOnchain);
  }

  async statusOf(receiptId: Hex): Promise<ReceiptStatusView | null> {
    const res = await this.pool.query<{
      receipt_id: string;
      status: ReceiptStatus;
      batch_id: number | null;
      tx_hash: string | null;
      block_number: string | null;
      onchain_batch_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT r.receipt_id, r.status, r.batch_id, r.tx_hash, r.block_number,
              b.onchain_batch_id, r.created_at, r.updated_at
         FROM receipts r LEFT JOIN batches b ON b.id = r.batch_id
        WHERE r.receipt_id = $1`,
      [receiptId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      receiptId: row.receipt_id as Hex,
      status: row.status,
      batchId: row.batch_id,
      txHash: (row.tx_hash as Hex | null) ?? null,
      blockNumber: row.block_number === null ? null : Number(row.block_number),
      onchainBatchId: row.onchain_batch_id === null ? null : Number(row.onchain_batch_id),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async countReceiptsByStatus(status: ReceiptStatus): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      // A count is a business metric, so it reads the business view. `statusOf` above deliberately
      // does not: a receipt looked up by its own id is an explicit reference, and hiding it there
      // would answer "no such receipt" about a row that exists.
      `SELECT count(*)::text AS count FROM receipts_business WHERE status = $1`,
      [status],
    );
    return Number(res.rows[0]!.count);
  }
}
