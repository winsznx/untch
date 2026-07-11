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

/**
 * Anchors a report hash on `UntchReceipts.anchorAudit` (§10.3 → `AuditAnchored`) with a REAL
 * writer-signed transaction — no mocked settlement. This is the SAME anchor the §7.6 A2A flow already
 * routes REPORT + DISPUTE_PACKETS through; the dispute packet and the reconciliation report REUSE it
 * (see README → "Why reuse AuditAnchored"). The writer key must be an authorized writer on the deployed
 * contract (the same key the receipt writer + score anchorer use).
 *
 * `verifyAnchored` re-reads the event by raw `eth_getLogs`, decoding it CLIENT-SIDE and matching
 * reportHash+agentId+period — so a proof never relies on this service's own report of what it did.
 */
export interface AuditAnchorerOptions {
  readonly chain: Chain;
  readonly rpcUrl: string;
  readonly contract: Address;
  readonly writerPrivateKey: Hex;
}

export interface AuditAnchorResult {
  readonly reportHash: Hex;
  readonly agentId: Hex;
  readonly period: bigint;
  readonly txHash: Hex;
  readonly blockNumber: number;
}

/** The narrow anchor capability a handler needs — behind an interface so handlers stay unit-testable
 *  with a fake and no RPC. */
export interface ReportAnchorer {
  anchor(reportHash: Hex, agentId: Hex, period: bigint): Promise<AuditAnchorResult>;
}

export class AuditAnchorer implements ReportAnchorer {
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  private readonly account;
  private readonly contract: Address;
  private readonly chain: Chain;

  constructor(opts: AuditAnchorerOptions) {
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

  /** Submit `anchorAudit(reportHash, agentId, period)` and wait for the receipt. */
  async anchor(reportHash: Hex, agentId: Hex, period: bigint): Promise<AuditAnchorResult> {
    const txHash = await this.wallet.writeContract({
      account: this.account,
      chain: this.chain,
      address: this.contract,
      abi: UNTCH_RECEIPTS_ABI,
      functionName: "anchorAudit",
      args: [reportHash, agentId, period],
    });
    const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`anchorAudit reverted (tx ${txHash})`);
    }
    return { reportHash, agentId, period, txHash, blockNumber: Number(receipt.blockNumber) };
  }

  /**
   * INDEPENDENT verification: pull the `AuditAnchored` log by RAW RPC, decode it CLIENT-SIDE, and
   * confirm it matches `expected` — where `expected.reportHash` is recomputed by the caller from the
   * assembled artifact, NOT taken from `anchor()`'s return. Two raw-RPC paths, both decoded locally:
   *   1. `eth_getLogs` over a clamped window around the block (retried for range-indexing lag);
   *   2. fallback `eth_getTransactionReceipt(txHash)` — the tx's own logs, available immediately.
   * Returns the matching tx hash or null.
   */
  async verifyAnchored(
    expected: { reportHash: Hex; agentId: Hex; period: bigint },
    blockNumber: number,
    txHash?: Hex,
    window = 5n,
  ): Promise<Hex | null> {
    const matches = (a: { reportHash: Hex; agentId: Hex; period: bigint }): boolean =>
      a.reportHash.toLowerCase() === expected.reportHash.toLowerCase() &&
      a.agentId.toLowerCase() === expected.agentId.toLowerCase() &&
      a.period === expected.period;

    for (let attempt = 0; attempt < 4; attempt++) {
      const from = BigInt(blockNumber) > window ? BigInt(blockNumber) - window : 0n;
      const head = await this.pub.getBlockNumber();
      const to = BigInt(blockNumber) + window < head ? BigInt(blockNumber) + window : head;
      const logs = await this.pub.getLogs({ address: this.contract, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const decoded = this.tryAuditAnchored(log.data, log.topics);
        if (decoded && matches(decoded)) return log.transactionHash;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (txHash) {
      const receipt = await this.pub.getTransactionReceipt({ hash: txHash });
      for (const log of receipt.logs) {
        const decoded = this.tryAuditAnchored(log.data, log.topics);
        if (decoded && matches(decoded)) return receipt.transactionHash;
      }
    }
    return null;
  }

  private tryAuditAnchored(
    data: Hex,
    topics: readonly Hex[],
  ): { reportHash: Hex; agentId: Hex; period: bigint } | null {
    try {
      const ev = decodeEventLog({
        abi: UNTCH_RECEIPTS_ABI,
        data,
        topics: topics as [signature: Hex, ...args: Hex[]],
      });
      if (ev.eventName !== "AuditAnchored") return null;
      return ev.args as unknown as { reportHash: Hex; agentId: Hex; period: bigint };
    } catch {
      return null;
    }
  }
}
