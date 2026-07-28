/**
 * x402 `exact` on Solana — a sponsored SPL transfer.
 *
 * STATUS: implemented as far as it can honestly be taken in this build, and NOT executable.
 *
 * What the live captures establish (internal/consumer-pack-evidence/):
 *   • Purch settles ONLY on `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` in USDC
 *     (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), and StableDomains/StableEmail offer Solana
 *     as an alternative to Base.
 *   • The `extra` block carries a `feePayer` — the provider sponsors the transaction fee, so the
 *     payload is a partially-signed transaction the provider completes and submits.
 *
 * What they do NOT establish, and what this build therefore refuses to guess:
 *   • the exact serialization the facilitator expects inside the `X-PAYMENT` payload (legacy vs
 *     versioned transaction, whether a recent blockhash is supplied by us or by the sponsor, whether
 *     the associated-token-account creation instruction is expected when the recipient ATA is absent);
 *   • whether `transfer` or `transferChecked` is required.
 *
 * Each of those is a coin flip that produces a *plausible* payload, and a plausible-but-wrong payload
 * against a real merchant is a failed purchase at best. Signing something we cannot verify is exactly
 * the failure mode the maturity ladder exists to prevent, so `pay()` returns a typed
 * PROTOCOL_NOT_EXECUTABLE rather than a guess, and every Solana-only provider is registered
 * `experimental` on that basis.
 *
 * `balanceOf` and `address()` ARE implemented behind a lazily-loaded `@solana/web3.js`, so treasury
 * monitoring for a Solana float works the moment a key and an RPC are configured — the observability
 * half of the rail is real even while the spending half is not. To finish the rail: confirm the
 * payload shape against the facilitator's own client, implement `pay`, prove one live settlement, and
 * only then promote the provider.
 */

import {
  normalizedError,
  ProviderError,
  type AssetRef,
  type CaipChainId,
  type Money,
  type PaymentRequest,
  type PaymentResult,
  type RailClient,
} from "@untch/consumer-core";

export interface SolanaExactClientDeps {
  readonly chain: CaipChainId;
  /** Base58 secret key. Never logged, never serialized. */
  readonly secretKey: string | null;
  readonly rpcUrl: string | null;
  /** Injected for tests, and the seam a finished implementation plugs into. */
  readonly balanceReader?: (asset: AssetRef, owner: string) => Promise<bigint>;
  readonly addressResolver?: (secretKey: string) => string;
}

export class X402SolanaExactClient implements RailClient {
  readonly chain: CaipChainId;
  private readonly secretKey: string | null;
  private readonly rpcUrl: string | null;
  private readonly balanceReader: ((asset: AssetRef, owner: string) => Promise<bigint>) | null;
  private readonly addressResolver: ((secretKey: string) => string) | null;
  private cachedAddress: string | null = null;

  constructor(deps: SolanaExactClientDeps) {
    this.chain = deps.chain;
    this.secretKey = deps.secretKey;
    this.rpcUrl = deps.rpcUrl;
    this.balanceReader = deps.balanceReader ?? null;
    this.addressResolver = deps.addressResolver ?? null;
  }

  address(): string {
    if (!this.secretKey) throw new Error(`no Solana signing key configured for ${this.chain}`);
    if (this.cachedAddress) return this.cachedAddress;
    if (!this.addressResolver) {
      throw new Error(
        "resolving a Solana address from a secret key needs @solana/web3.js, which is not installed " +
          "in this build; inject `addressResolver` or install the dependency",
      );
    }
    this.cachedAddress = this.addressResolver(this.secretKey);
    return this.cachedAddress;
  }

  /**
   * Deliberately FALSE even when a key is present. `available()` gates whether the treasury router
   * will mint a capability for this rail, and a rail that cannot pay must never be selectable —
   * reporting availability on the strength of a key alone would let an intent reach
   * PROVIDER_PAYMENT_PENDING before failing, which is the one state transition that costs a manual
   * review.
   */
  available(): boolean {
    return false;
  }

  /** Whether monitoring can read this float, independent of whether it can spend from it. */
  readable(): boolean {
    return this.secretKey !== null && (this.rpcUrl !== null || this.balanceReader !== null);
  }

  async balanceOf(asset: AssetRef): Promise<Money> {
    if (!this.secretKey) {
      throw new ProviderError(
        normalizedError("TREASURY_INSUFFICIENT", `no Solana signing key configured for ${this.chain}`),
      );
    }
    if (this.balanceReader) {
      return { amount: await this.balanceReader(asset, this.address()), asset };
    }
    throw new ProviderError(
      normalizedError(
        "TREASURY_INSUFFICIENT",
        `cannot read the ${asset.symbol} balance on ${this.chain}: install @solana/web3.js and set ` +
          "CONSUMER_SOLANA_RPC_URL, or inject a balanceReader",
      ),
    );
  }

  async pay(_req: PaymentRequest): Promise<PaymentResult> {
    throw new ProviderError(
      normalizedError(
        "PROTOCOL_NOT_EXECUTABLE",
        "the Solana x402 exact rail is not executable in this build. The 402 challenges confirm the " +
          "network, mint, payTo and sponsoring feePayer, but the exact X-PAYMENT payload serialization " +
          "could not be confirmed from an authoritative source, and a plausible-but-wrong payload " +
          "against a real merchant is a failed purchase. Providers that settle only on Solana are " +
          "registered 'experimental' for exactly this reason.",
      ),
    );
  }
}
