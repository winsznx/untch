import assert from "node:assert/strict";
import { test } from "node:test";
import { flushOnce, flushPendingOnce, reconcileOnce, type AnchorerDeps } from "../src/anchorer";
import { InMemoryReceiptsRepo } from "../src/repo-memory";
import { FakeChain, makeDraft } from "./helpers";

/**
 * §7.4 chain transitions: retry/backoff on RPC failure → SUBMITTED or DEGRADED_UNANCHORED, and
 * reorg re-verification → resubmit → CONFIRMED. All driven by fakes — no Postgres, no RPC.
 */

function deps(repo: InMemoryReceiptsRepo, chain: FakeChain, over: Partial<AnchorerDeps> = {}): AnchorerDeps {
  return {
    repo,
    chain,
    batchMaxSize: 25,
    retryMax: 5,
    retryBackoffBaseMs: 1, // irrelevant; sleep is stubbed
    confirmDepth: 3,
    sleep: async () => {}, // instant retries
    ...over,
  };
}

test("retry/backoff: submit fails twice then succeeds → SUBMITTED, retries recorded", async () => {
  const repo = new InMemoryReceiptsRepo();
  const chain = new FakeChain();
  await repo.insertDraft(makeDraft());
  await repo.insertDraft(makeDraft());
  chain.failuresRemaining = 2;

  const outcome = await flushOnce(deps(repo, chain, { retryMax: 5 }));

  assert.equal(outcome.kind, "submitted");
  assert.equal(chain.submits.length, 1, "exactly one successful submit landed");
  assert.equal(await repo.countReceiptsByStatus("SUBMITTED"), 2);
  assert.equal(await repo.countReceiptsByStatus("QUEUED"), 0);
  const [batch] = await repo.batchesByStatus("SUBMITTED");
  assert.equal(batch!.attempts, 2, "two failed attempts were recorded before success");
});

test("retries exhausted → DEGRADED_UNANCHORED, and NOTHING is lost (ledger + rows intact)", async () => {
  const repo = new InMemoryReceiptsRepo();
  const chain = new FakeChain();
  await repo.insertDraft(makeDraft());
  await repo.insertDraft(makeDraft());
  chain.failuresRemaining = 999; // never succeeds

  const outcome = await flushOnce(deps(repo, chain, { retryMax: 3 }));

  assert.equal(outcome.kind, "degraded");
  assert.equal(chain.submits.length, 0, "no submit ever landed");
  assert.equal(await repo.countReceiptsByStatus("DEGRADED_UNANCHORED"), 2);
  assert.equal(await repo.countReceiptsByStatus("QUEUED"), 0);
  // The durable ledger is authoritative regardless of chain state — both entries survive.
  assert.equal(repo.ledger.length, 2, "ledger entries are never lost when anchoring fails");
});

test("reorg: dropped batch is re-verified and resubmitted, then CONFIRMED at depth", async () => {
  const repo = new InMemoryReceiptsRepo();
  const chain = new FakeChain();
  await repo.insertDraft(makeDraft());

  const first = await flushOnce(deps(repo, chain));
  assert.equal(first.kind, "submitted");
  assert.equal(chain.submits.length, 1);
  const droppedTx = first.kind === "submitted" ? first.txHash : "0x";

  // Reorg drops the mined tx; the confirm/reorg sweep must notice and resubmit.
  chain.drop(droppedTx as `0x${string}`);
  await reconcileOnce(deps(repo, chain));

  assert.equal(chain.submits.length, 2, "batch was resubmitted after the reorg drop");
  assert.equal(await repo.countReceiptsByStatus("SUBMITTED"), 1, "still SUBMITTED, not lost");

  // Not deep enough yet → stays SUBMITTED.
  await reconcileOnce(deps(repo, chain));
  assert.equal(await repo.countReceiptsByStatus("CONFIRMED"), 0);

  // Advance past finality depth → CONFIRMED.
  chain.head += 3;
  await reconcileOnce(deps(repo, chain));
  assert.equal(await repo.countReceiptsByStatus("CONFIRMED"), 1);
});

test("confirm requires finality depth: shallow inclusion stays SUBMITTED", async () => {
  const repo = new InMemoryReceiptsRepo();
  const chain = new FakeChain();
  await repo.insertDraft(makeDraft());
  await flushOnce(deps(repo, chain));

  // head == mined block → depth 0 < confirmDepth 3.
  await reconcileOnce(deps(repo, chain, { confirmDepth: 3 }));
  assert.equal(await repo.countReceiptsByStatus("CONFIRMED"), 0);
  assert.equal(await repo.countReceiptsByStatus("SUBMITTED"), 1);

  chain.head += 3;
  await reconcileOnce(deps(repo, chain, { confirmDepth: 3 }));
  assert.equal(await repo.countReceiptsByStatus("CONFIRMED"), 1);
});

/**
 * Operator re-drive.
 *
 * DEGRADED_UNANCHORED stays terminal for the AUTOMATIC anchorer, and must: a batch failing against an
 * unchanged condition cannot be allowed to consume the loop. But the budget is exhausted precisely
 * when something outside the process is wrong — an RPC outage, a paused contract, a signer with no
 * gas — and once that is fixed the receipt still deserves its anchor. These pin the two properties
 * that make re-drive safe rather than dangerous: the SAME receiptId is re-used, and a batch that is
 * not degraded cannot be re-driven into a double-anchor.
 */
test("re-drive: a degraded batch returns to PENDING and anchors, keeping its receiptId", async () => {
  // #given a batch that exhausted its retries against a failing chain
  const repo = new InMemoryReceiptsRepo();
  const chain = new FakeChain();
  const d = makeDraft();
  await repo.insertDraft(d);
  chain.failuresRemaining = 99;
  const first = await flushOnce(deps(repo, chain, { retryMax: 2 }));
  assert.equal(first.kind, "degraded");
  assert.equal(await repo.countReceiptsByStatus("DEGRADED_UNANCHORED"), 1);

  // #when the cause is fixed and an operator re-drives it
  chain.failuresRemaining = 0;
  const batchId = (first as { batchId: number }).batchId;
  assert.equal(await repo.redriveDegraded(batchId), true);

  // #then the worker's pending sweep anchors the SAME receipt — no replacement id was minted
  const out = await flushPendingOnce(deps(repo, chain, { retryMax: 2 }));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, "submitted");
  const view = await repo.statusOf(d.onchain.receiptId);
  assert.equal(view?.status, "SUBMITTED");
  assert.equal(view?.receiptId, d.onchain.receiptId, "the original receiptId survives the re-drive");
});

test("re-drive: a batch that is NOT degraded is refused — it would double-anchor", async () => {
  const repo = new InMemoryReceiptsRepo();
  const chain = new FakeChain();
  await repo.insertDraft(makeDraft());
  const out = await flushOnce(deps(repo, chain));
  assert.equal(out.kind, "submitted");
  assert.equal(await repo.redriveDegraded((out as { batchId: number }).batchId), false);
});

test("re-drive: an unknown batch is refused rather than throwing", async () => {
  assert.equal(await new InMemoryReceiptsRepo().redriveDegraded(99_999), false);
});

test("re-drive: only one of two concurrent re-drives of the same batch wins", async () => {
  // The guard is the conditional UPDATE itself, so a read-then-write race cannot double-anchor.
  const repo = new InMemoryReceiptsRepo();
  const chain = new FakeChain();
  await repo.insertDraft(makeDraft());
  chain.failuresRemaining = 99;
  const first = await flushOnce(deps(repo, chain, { retryMax: 1 }));
  const id = (first as { batchId: number }).batchId;
  const [a, b] = await Promise.all([repo.redriveDegraded(id), repo.redriveDegraded(id)]);
  assert.equal([a, b].filter(Boolean).length, 1);
});

test("the pending sweep also recovers a batch orphaned by a crash between claim and submit", async () => {
  // This case predates re-drive: a process killed mid-submit left PENDING rows that flushOnce (QUEUED
  // only) and reconcileOnce (SUBMITTED only) both skip.
  const repo = new InMemoryReceiptsRepo();
  const chain = new FakeChain();
  await repo.insertDraft(makeDraft());
  const claimed = await repo.claimQueuedBatch(25);
  assert.ok(claimed, "batch is now PENDING with nothing driving it");
  assert.equal((await repo.batchesByStatus("PENDING")).length, 1);

  const out = await flushPendingOnce(deps(repo, chain));
  assert.equal(out[0]!.kind, "submitted");
  assert.equal(await repo.countReceiptsByStatus("SUBMITTED"), 1);
});

test("the pending sweep is a no-op when nothing is pending", async () => {
  const repo = new InMemoryReceiptsRepo();
  assert.deepEqual(await flushPendingOnce(deps(repo, new FakeChain())), []);
});
