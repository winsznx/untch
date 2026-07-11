import { createPublicClient, http, type Address, type Chain, type PublicClient } from "viem";

/**
 * The public on-chain signals the `wallet_operational_profile` feature (§12) reads for a vendor's
 * payout address, via a DIRECT RPC query — no marketplace dependency. Behind an interface so the
 * feature math is testable with a fake and the real path uses viem against X Layer.
 *
 * What raw RPC gives us deterministically, and what it does NOT:
 *   • txCount (getTransactionCount, "latest") — outgoing-nonce = activity volume. REAL.
 *   • balanceWei (getBalance) — operational reserve / has-gas. REAL.
 *   • isContract (getCode ≠ 0x) — EOA vs contract payout. REAL.
 * The richer §12 signals — first-seen AGE, activity REGULARITY over time, counterparty interaction
 * DIVERSITY — need a log/tx indexer, not a single RPC round-trip. This build computes the profile from
 * the three real point-in-time signals above and is HONEST that age/regularity/diversity are a deferred
 * enrichment (see README), not silently claimed. That honesty is why this feature's σ is not tiny.
 */
export interface WalletSignals {
  readonly address: string;
  readonly txCount: number;
  readonly balanceWei: bigint;
  readonly isContract: boolean;
}

export interface WalletProfileProvider {
  signals(address: Address): Promise<WalletSignals>;
}

export interface ViemWalletProfileOptions {
  readonly chain: Chain;
  readonly rpcUrl: string;
}

export class ViemWalletProfileProvider implements WalletProfileProvider {
  private readonly pub: PublicClient;
  constructor(opts: ViemWalletProfileOptions) {
    this.pub = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  }
  async signals(address: Address): Promise<WalletSignals> {
    const [txCount, balanceWei, code] = await Promise.all([
      this.pub.getTransactionCount({ address }),
      this.pub.getBalance({ address }),
      this.pub.getCode({ address }),
    ]);
    return {
      address,
      txCount: Number(txCount),
      balanceWei,
      isContract: code !== undefined && code !== "0x",
    };
  }
}
