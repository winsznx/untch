import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { UNTCH_RECEIPTS_ABI } from "@untch/receipt-writer";
import { SUBJECT_KIND_CODE, type ScoreSnapshotRow, type SubjectKind } from "./types";
import { rootOfSnapshots } from "./merkle";

/**
 * Anchors an epoch's score merkle root on `UntchReceipts.anchorScore` (§10.3 → `ScoreAnchored`), with a
 * REAL writer-signed transaction — no mocked settlement. The writer key must be an authorized writer on
 * the deployed contract (the same key the receipt writer uses). `verifyAnchored` re-reads the event by
 * raw `eth_getLogs`, decoding it CLIENT-SIDE and matching root+epoch+subjectKind — so the proof never
 * relies on this service's own report of what it did.
 */
export interface ScoreAnchorerOptions {
  readonly chain: Chain;
  readonly rpcUrl: string;
  readonly contract: Address;
  readonly writerPrivateKey: Hex;
}

export interface AnchorResult {
  readonly root: Hex;
  readonly epoch: number;
  readonly subjectKind: SubjectKind;
  readonly subjectCount: number;
  readonly txHash: Hex;
  readonly blockNumber: number;
}

export class ScoreAnchorer {
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  private readonly account;
  private readonly contract: Address;
  private readonly chain: Chain;

  constructor(opts: ScoreAnchorerOptions) {
    this.account = privateKeyToAccount(opts.writerPrivateKey);
    this.chain = opts.chain;
    this.contract = opts.contract;
    this.pub = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
    this.wallet = createWalletClient({
      account: this.account,
      chain: opts.chain,
      transport: http(opts.rpcUrl),
    });
  }

  get writerAddress(): Address {
    return this.account.address;
  }

  /** Compute the root over the given snapshots and submit `anchorScore(root, epoch, subjectKind)`,
   *  waiting for the receipt. Returns the root, tx hash, and mined block. */
  async anchor(
    kind: SubjectKind,
    epoch: number,
    snapshots: readonly ScoreSnapshotRow[],
  ): Promise<AnchorResult> {
    if (snapshots.length === 0) throw new Error("anchor: no snapshots for this epoch (nothing to anchor)");
    const root = rootOfSnapshots(snapshots);
    const txHash = await this.wallet.writeContract({
      account: this.account,
      chain: this.chain,
      address: this.contract,
      abi: UNTCH_RECEIPTS_ABI,
      functionName: "anchorScore",
      args: [root, BigInt(epoch), SUBJECT_KIND_CODE[kind]],
    });
    const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`anchorScore reverted (tx ${txHash})`);
    }
    return {
      root,
      epoch,
      subjectKind: kind,
      subjectCount: snapshots.length,
      txHash,
      blockNumber: Number(receipt.blockNumber),
    };
  }

  /**
   * INDEPENDENT verification: pull the `ScoreAnchored` log by RAW RPC, decode it CLIENT-SIDE, and
   * confirm it matches the `expected` root+epoch+subjectKind — where `expected.root` is recomputed by
   * the caller from the snapshots, NOT taken from `anchor()`'s return. Two raw-RPC paths, both decoded
   * locally:
   *   1. `eth_getLogs` over a clamped window around the block (retried, since range-indexing can lag a
   *      block or two right after mining);
   *   2. fallback `eth_getTransactionReceipt(txHash)` — the tx's own logs, available immediately.
   * Returns the matching tx hash or null.
   */
  async verifyAnchored(
    expected: { root: Hex; epoch: number; subjectKind: SubjectKind },
    blockNumber: number,
    txHash?: Hex,
    window = 5n,
  ): Promise<Hex | null> {
    const matches = (a: { merkleRoot: Hex; epoch: bigint; subjectKind: number }): boolean =>
      a.merkleRoot.toLowerCase() === expected.root.toLowerCase() &&
      Number(a.epoch) === expected.epoch &&
      a.subjectKind === SUBJECT_KIND_CODE[expected.subjectKind];

    // Path 1: eth_getLogs, retried for range-indexing lag.
    for (let attempt = 0; attempt < 4; attempt++) {
      const from = BigInt(blockNumber) > window ? BigInt(blockNumber) - window : 0n;
      const head = await this.pub.getBlockNumber();
      const to = BigInt(blockNumber) + window < head ? BigInt(blockNumber) + window : head;
      const logs = await this.pub.getLogs({ address: this.contract, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const decoded = this.tryScoreAnchored(log.data, log.topics);
        if (decoded && matches(decoded)) return log.transactionHash;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Path 2: raw tx receipt — its logs are available the instant the tx is mined.
    if (txHash) {
      const receipt = await this.pub.getTransactionReceipt({ hash: txHash });
      for (const log of receipt.logs) {
        const decoded = this.tryScoreAnchored(log.data, log.topics);
        if (decoded && matches(decoded)) return receipt.transactionHash;
      }
    }
    return null;
  }

  private tryScoreAnchored(
    data: Hex,
    topics: readonly Hex[],
  ): { merkleRoot: Hex; epoch: bigint; subjectKind: number } | null {
    try {
      const ev = decodeEventLog({
        abi: UNTCH_RECEIPTS_ABI,
        data,
        topics: topics as [signature: Hex, ...args: Hex[]],
      });
      if (ev.eventName !== "ScoreAnchored") return null;
      return ev.args as unknown as { merkleRoot: Hex; epoch: bigint; subjectKind: number };
    } catch {
      return null;
    }
  }
}
