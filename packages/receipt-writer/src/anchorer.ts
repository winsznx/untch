import type { ChainAnchor } from "./chain";
import type { ReceiptsRepo } from "./repo";
import type { ReceiptOnchain } from "./types";

/**
 * The §7.4 state transitions that touch the chain: claim a QUEUED batch → submit (`logReceipts`) with
 * retry/backoff → SUBMITTED, or DEGRADED_UNANCHORED when retries are exhausted; and a reconcile sweep
 * that confirms SUBMITTED batches at finality depth or resubmits ones dropped by a reorg.
 *
 * Every operation goes through the `ReceiptsRepo` + `ChainAnchor` interfaces, so this whole module is
 * driven by fakes in tests — no Postgres, no RPC. The durability guarantee lives one layer down: the
 * receipt + ledger row are already committed before anything here runs, so a crash mid-submit loses
 * nothing; the batch is simply re-driven.
 */

export interface AnchorerDeps {
  readonly repo: ReceiptsRepo;
  readonly chain: ChainAnchor;
  readonly batchMaxSize: number;
  readonly retryMax: number;
  readonly retryBackoffBaseMs: number;
  readonly confirmDepth: number;
  /** Injectable sleep so tests run retries instantly. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export type FlushOutcome =
  | { readonly kind: "empty" }
  | { readonly kind: "submitted"; readonly batchId: number; readonly txHash: string }
  | { readonly kind: "degraded"; readonly batchId: number };

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function backoffMs(base: number, attempt: number): number {
  return base * 2 ** (attempt - 1);
}

/** Claim up to N QUEUED receipts and submit them, retrying with exponential backoff on RPC/nonce
 *  errors, degrading to DEGRADED_UNANCHORED once the retry budget is spent (§7.4). */
export async function flushOnce(deps: AnchorerDeps): Promise<FlushOutcome> {
  const claimed = await deps.repo.claimQueuedBatch(deps.batchMaxSize);
  if (!claimed) return { kind: "empty" };
  return submitClaimed(deps, claimed.batchId, claimed.receipts);
}

/**
 * Submit any batch sitting in PENDING that no submit attempt is currently driving.
 *
 * PENDING is normally transient: `claimQueuedBatch` creates the batch and `submitClaimed` runs on it
 * immediately, in the same call. The one way a batch can REST in PENDING is an operator re-drive of a
 * previously degraded batch (`redriveDegraded`), and without this function that batch would be
 * orphaned — `flushOnce` only claims QUEUED receipts and `reconcileOnce` only sweeps SUBMITTED ones,
 * so nothing would ever pick it up again.
 *
 * It also covers a real crash case that existed before re-drive did: a process killed between
 * claiming a batch and submitting it left PENDING rows behind, and the next tick would not retry them.
 */
export async function flushPendingOnce(deps: AnchorerDeps): Promise<readonly FlushOutcome[]> {
  const pending = await deps.repo.batchesByStatus("PENDING");
  const out: FlushOutcome[] = [];
  for (const batch of pending) {
    const receipts = await deps.repo.receiptsForBatch(batch.id);
    if (receipts.length === 0) continue;
    out.push(await submitClaimed(deps, batch.id, receipts));
  }
  return out;
}

async function submitClaimed(
  deps: AnchorerDeps,
  batchId: number,
  receipts: readonly ReceiptOnchain[],
): Promise<FlushOutcome> {
  const sleep = deps.sleep ?? realSleep;
  const log = deps.log ?? (() => {});

  for (let attempt = 1; attempt <= deps.retryMax; attempt++) {
    try {
      const txHash = await deps.chain.submitBatch(receipts);
      await deps.repo.markSubmitted(batchId, txHash);
      log("batch submitted", { batchId, txHash, attempt });
      return { kind: "submitted", batchId, txHash };
    } catch (err) {
      await deps.repo.recordBatchError(batchId, message(err));
      log("batch submit failed", { batchId, attempt, error: message(err) });
      if (attempt >= deps.retryMax) {
        await deps.repo.markDegraded(batchId);
        log("batch DEGRADED_UNANCHORED — retries exhausted, ledger remains authoritative", {
          batchId,
        });
        return { kind: "degraded", batchId };
      }
      await sleep(backoffMs(deps.retryBackoffBaseMs, attempt));
    }
  }
  /* retryMax >= 1 is enforced by config, so the loop always returns above. */
  await deps.repo.markDegraded(batchId);
  return { kind: "degraded", batchId };
}

/**
 * One reconcile sweep over SUBMITTED batches:
 *   • not included on-chain right now  → dropped by a reorg → resubmit the same receipts.
 *   • included at >= confirmDepth       → CONFIRMED (record the on-chain BatchLogged id + block).
 *   • included but reverted             → §7.4 "split batch, retry singles": degrade + alert (a real
 *                                          split needs partial-failure info the append-only log can't
 *                                          give; logReceipts only reverts on non-writer/empty, both
 *                                          impossible here, so this is a defended-against edge).
 *   • included but shallow              → leave SUBMITTED; a later sweep confirms it.
 */
export async function reconcileOnce(deps: AnchorerDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  const submitted = await deps.repo.batchesByStatus("SUBMITTED");
  if (submitted.length === 0) return;

  const head = await deps.chain.headBlockNumber();

  for (const batch of submitted) {
    if (!batch.txHash) continue;
    const inc = await deps.chain.inclusion(batch.txHash);

    if (!inc.included) {
      const receipts = await deps.repo.receiptsForBatch(batch.id);
      try {
        const txHash = await deps.chain.submitBatch(receipts);
        await deps.repo.markSubmitted(batch.id, txHash);
        log("batch resubmitted after reorg drop", { batchId: batch.id, txHash });
      } catch (err) {
        await deps.repo.recordBatchError(batch.id, `reorg resubmit failed: ${message(err)}`);
        log("reorg resubmit failed", { batchId: batch.id, error: message(err) });
      }
      continue;
    }

    if (inc.reverted) {
      await deps.repo.recordBatchError(batch.id, "batch tx reverted on-chain");
      await deps.repo.markDegraded(batch.id);
      log("batch reverted on-chain → DEGRADED_UNANCHORED (needs split-singles re-drive)", {
        batchId: batch.id,
        txHash: batch.txHash,
      });
      continue;
    }

    if (inc.blockNumber !== null && head - inc.blockNumber >= deps.confirmDepth) {
      await deps.repo.markConfirmed(batch.id, inc.onchainBatchId, inc.blockNumber);
      log("batch CONFIRMED", {
        batchId: batch.id,
        onchainBatchId: inc.onchainBatchId,
        block: inc.blockNumber,
        depth: head - inc.blockNumber,
      });
    }
  }
}
