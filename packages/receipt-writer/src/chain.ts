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
import { UNTCH_RECEIPTS_ABI } from "./abi";
import type { ReceiptOnchain } from "./types";

/**
 * The chain surface the state machine drives, behind an interface so the batching/retry/reorg logic
 * is tested with a fake and no RPC. `submitBatch` sends `logReceipts` and returns the tx hash
 * WITHOUT waiting — confirmation is a separate, reorg-aware step (`inclusion`), matching §7.4 where
 * SUBMITTED(txHash) and CONFIRMED are distinct states.
 */
export interface Inclusion {
  /** tx found on-chain right now (false ⇒ dropped/reorged-out — resubmit per §7.4). */
  readonly included: boolean;
  /** block it was mined in (null when not included). */
  readonly blockNumber: number | null;
  /** true when included but the tx reverted (§7.4 "reverted ─▶ split batch, retry singles"). */
  readonly reverted: boolean;
  /** UntchReceipts.BatchLogged.batchId decoded from the receipt logs (null if absent/not included). */
  readonly onchainBatchId: number | null;
}

export interface ChainAnchor {
  /** Send `logReceipts(receipts)`; return the tx hash immediately (does not wait for a receipt). */
  submitBatch(receipts: readonly ReceiptOnchain[]): Promise<Hex>;
  /** Current head block number. */
  headBlockNumber(): Promise<number>;
  /** Re-verify a submitted batch tx by raw RPC receipt lookup. */
  inclusion(txHash: Hex): Promise<Inclusion>;
}

export interface ViemChainAnchorOptions {
  readonly chain: Chain;
  readonly rpcUrl: string;
  readonly contract: Address;
  readonly writerPrivateKey: Hex;
}

export class ViemChainAnchor implements ChainAnchor {
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  private readonly account;
  private readonly contract: Address;
  private readonly chain: Chain;

  constructor(opts: ViemChainAnchorOptions) {
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

  async submitBatch(receipts: readonly ReceiptOnchain[]): Promise<Hex> {
    if (receipts.length === 0) throw new Error("submitBatch: empty batch");
    return this.wallet.writeContract({
      account: this.account,
      chain: this.chain,
      address: this.contract,
      abi: UNTCH_RECEIPTS_ABI,
      functionName: "logReceipts",
      args: [receipts.map((r) => ({ ...r }))],
    });
  }

  async headBlockNumber(): Promise<number> {
    return Number(await this.pub.getBlockNumber());
  }

  async inclusion(txHash: Hex): Promise<Inclusion> {
    let receipt;
    try {
      receipt = await this.pub.getTransactionReceipt({ hash: txHash });
    } catch {
      return { included: false, blockNumber: null, reverted: false, onchainBatchId: null };
    }
    const reverted = receipt.status === "reverted";
    let onchainBatchId: number | null = null;
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: UNTCH_RECEIPTS_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === "BatchLogged") {
          onchainBatchId = Number((ev.args as { batchId: bigint }).batchId);
          break;
        }
      } catch {
        /* not one of our events */
      }
    }
    return {
      included: true,
      blockNumber: Number(receipt.blockNumber),
      reverted,
      onchainBatchId,
    };
  }
}
