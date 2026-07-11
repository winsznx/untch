import { keccak256, toHex, type Hex } from "viem";
import type { ChainAnchor, Inclusion } from "../src/chain";
import type { Scheduler } from "../src/batcher";
import type { ReceiptDraft, ReceiptOnchain } from "../src/types";

/** Deterministic fake scheduler: timers fire only when the test advances virtual time. */
export class FakeScheduler implements Scheduler {
  private timers = new Map<number, { fn: () => void; at: number }>();
  private now = 0;
  private id = 0;

  setTimeout(fn: () => void, ms: number): number {
    const handle = ++this.id;
    this.timers.set(handle, { fn, at: this.now + ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Advance virtual time, firing any timers whose deadline has passed. */
  advance(ms: number): void {
    this.now += ms;
    for (const [handle, timer] of [...this.timers]) {
      if (timer.at <= this.now) {
        this.timers.delete(handle);
        timer.fn();
      }
    }
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

/**
 * Fake chain anchor. Controls submit failures (RPC outage simulation), block head, and which txs got
 * "dropped" by a reorg. Records every submit so tests can assert retry/resubmit counts.
 */
export class FakeChain implements ChainAnchor {
  readonly submits: ReceiptOnchain[][] = [];
  failuresRemaining = 0;
  head = 100;
  private nextTx = 0;
  private readonly minedAt = new Map<Hex, number>();
  private readonly dropped = new Set<Hex>();

  async submitBatch(receipts: readonly ReceiptOnchain[]): Promise<Hex> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error("simulated RPC/nonce failure");
    }
    const tx = toHex(++this.nextTx, { size: 32 });
    this.submits.push([...receipts]);
    this.minedAt.set(tx, this.head);
    return tx;
  }

  async headBlockNumber(): Promise<number> {
    return this.head;
  }

  async inclusion(txHash: Hex): Promise<Inclusion> {
    if (this.dropped.has(txHash) || !this.minedAt.has(txHash)) {
      return { included: false, blockNumber: null, reverted: false, onchainBatchId: null };
    }
    return {
      included: true,
      blockNumber: this.minedAt.get(txHash)!,
      reverted: false,
      onchainBatchId: 1,
    };
  }

  /** Simulate a reorg dropping a previously-mined tx. */
  drop(txHash: Hex): void {
    this.dropped.add(txHash);
  }
}

let counter = 0;

/** Build a distinct receipt draft (APPROVED SPEND) for tests. */
export function makeDraft(): ReceiptDraft {
  const n = ++counter;
  const receiptId = keccak256(toHex(`test-receipt-${n}`));
  const agentId = toHex(1n, { size: 32 });
  const onchain: ReceiptOnchain = {
    receiptId,
    policyId: 42n,
    policyHash: keccak256(toHex("policy")),
    agentId,
    vendorId: keccak256(toHex("vendor")),
    amount: 500_000n,
    token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
    category: keccak256(toHex("market-data")),
    payType: 0,
    intentHash: keccak256(toHex(`intent-${n}`)),
    taskHash: keccak256(toHex(`task-${n}`)),
    decision: 1,
    verifyResult: 0,
    proofTier: 0,
    metadataHash: keccak256(toHex(`meta-${n}`)),
  };
  return {
    onchain,
    kind: "DECISION",
    ledger: {
      agentId,
      type: "SPEND",
      amount: "500000",
      token: onchain.token,
      counterparty: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      dayKey: "2026-07-10",
      categoryKey: "market-data",
      vendorKey: onchain.vendorId,
    },
  };
}
