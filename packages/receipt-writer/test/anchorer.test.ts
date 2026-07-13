import assert from "node:assert/strict";
import { test } from "node:test";
import { flushOnce, reconcileOnce, type AnchorerDeps } from "../src/anchorer";
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
