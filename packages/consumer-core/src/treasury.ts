/**
 * The routed treasury.
 *
 * Two properties define this module, and both are structural rather than procedural:
 *
 *   1. AN ADAPTER NEVER SEES A KEY. A provider adapter receives a `PaymentCapability` — an object
 *      whose only method is `pay()`, pre-bound to one intent, one chain, one asset, one ceiling and
 *      one allowlist of recipients. Private keys live inside `RailClient` implementations that only
 *      this router constructs. A compromised adapter's entire blast radius is one intent's
 *      authorised amount to an already-allowlisted recipient.
 *
 *   2. NO SWAP AND NO BRIDGE ON THE REQUEST PATH. Every rail carries a pre-funded float, replenished
 *      out of band by a human following the runbook. `Rebalancer` exists as an interface so the seam
 *      is real, and `NoopRebalancer` is the only implementation; `assertRebalancingDisabled()` throws
 *      if anything tries to enable one. This repository has no tested production bridge, and a
 *      request-path bridge would put user money into an untested code path at the worst moment.
 *
 * A capability is single-use, enforced by `consumeCapability` under a row lock — so two workers
 * racing the same intent produce one payment and one refusal, not two payments.
 */

import type { AssetRef, CaipChainId } from "./assets";
import { assetKey, describeAsset } from "./assets";
import { ProviderError, normalizedError } from "./errors";
import { formatMoney, gtMoney, type Money } from "./money";
import { firstEngagedPause } from "./registry";
import type { CapabilityRecord, ConsumerStore, TreasuryAccountRecord } from "./repo";

/** What an adapter is allowed to ask for. It cannot express anything outside its capability. */
export interface PaymentRequest {
  /** The exact amount to pay. Must be ≤ the capability's ceiling. */
  readonly amount: Money;
  /** The recipient. Must be on the capability's allowlist. */
  readonly recipient: string;
  /** The provider's 402/MPP challenge, already parsed and bound. Paid verbatim; never re-fetched. */
  readonly challenge: Readonly<Record<string, unknown>>;
  /** The HTTP request the payment authorises, for schemes that bind to a resource. */
  readonly resourceUrl: string;
  readonly method: string;
}

export interface PaymentResult {
  /** The payment header value to replay on the paid retry. */
  readonly paymentHeader: string;
  /** The canonical header name for the scheme. x402 v2: `PAYMENT-SIGNATURE`. */
  readonly headerName: string;
  /**
   * Additional header names carrying the SAME value, for facilitators that only read an older name
   * (x402 v1's `X-PAYMENT`). Sending both costs nothing and removes a whole class of silent
   * "the payment header was ignored, here is your 402 again" failure.
   */
  readonly aliasHeaderNames?: readonly string[];
  /** Settlement tx hash when the rail exposes one at signing time. Often only known after the retry. */
  readonly txHash: string | null;
  readonly amount: Money;
  readonly recipient: string;
  readonly chain: CaipChainId;
}

/** A rail's signer. Constructed ONLY by the router; never handed to an adapter. */
export interface RailClient {
  readonly chain: CaipChainId;
  /** The public address of the float this client spends from. Safe to expose. */
  address(): string;
  /** Whether the client can actually sign (a key is present). */
  available(): boolean;
  /** On-chain balance of `asset`. Used by monitoring and by the pre-spend float check. */
  balanceOf(asset: AssetRef): Promise<Money>;
  /** Build (and sign) the payment for one challenge. Never submits a bare transfer. */
  pay(req: PaymentRequest): Promise<PaymentResult>;
}

/**
 * The scoped authority an adapter receives. Everything is fixed at mint time; `pay` re-checks all of
 * it, so a bug in an adapter cannot widen what it was given.
 */
export interface PaymentCapability {
  readonly capabilityId: string;
  readonly intentId: string;
  readonly chain: CaipChainId;
  readonly asset: AssetRef;
  readonly maxAmount: Money;
  readonly allowedRecipients: readonly string[];
  readonly expiresAt: string;
  pay(req: PaymentRequest): Promise<PaymentResult>;
}

export interface PauseChecker {
  assertNotPaused(scope: {
    readonly providerId?: string;
    readonly chain?: string;
    readonly assetKey?: string;
    readonly treasuryRef?: string;
  }): Promise<void>;
}

export interface Rebalancer {
  readonly enabled: boolean;
  rebalance(): Promise<void>;
}

/**
 * The only Rebalancer this build ships. Its `rebalance` is a no-op that records nothing and moves
 * nothing; low balances are handled by alerting a human, per the runbook.
 */
export class NoopRebalancer implements Rebalancer {
  readonly enabled = false;
  async rebalance(): Promise<void> {
    // Intentionally empty. See assertRebalancingDisabled below.
  }
}

/**
 * Called at router construction. It exists so that "automatic rebalancing is disabled" is a property
 * the code enforces, not a sentence in a document that a future change can quietly falsify.
 */
export function assertRebalancingDisabled(r: Rebalancer): void {
  if (r.enabled) {
    throw new Error(
      "automatic treasury rebalancing is enabled, but this build has no tested production bridge. " +
        "A request-path swap or bridge would move user funds through an unproven code path at the worst " +
        "possible moment. Implement and test a bridge, write its threat model, then remove this guard.",
    );
  }
}

export interface TreasuryRouterDeps {
  readonly store: ConsumerStore;
  /** One client per settlement rail. A rail with no key simply has no entry. */
  readonly rails: ReadonlyMap<CaipChainId, RailClient>;
  readonly pauses: PauseChecker;
  readonly rebalancer?: Rebalancer;
  readonly clock?: () => number;
  /** Capability lifetime. Short by design: an authority that outlives its execution is a liability. */
  readonly capabilityTtlMs?: number;
  readonly onLowBalance?: (treasuryRef: string, observed: Money, floor: Money) => void;
}

export class TreasuryRouter {
  private readonly store: ConsumerStore;
  private readonly rails: ReadonlyMap<CaipChainId, RailClient>;
  private readonly pauses: PauseChecker;
  private readonly clock: () => number;
  private readonly capabilityTtlMs: number;
  private readonly onLowBalance: (treasuryRef: string, observed: Money, floor: Money) => void;

  constructor(deps: TreasuryRouterDeps) {
    assertRebalancingDisabled(deps.rebalancer ?? new NoopRebalancer());
    this.store = deps.store;
    this.rails = deps.rails;
    this.pauses = deps.pauses;
    this.clock = deps.clock ?? Date.now;
    this.capabilityTtlMs = deps.capabilityTtlMs ?? 5 * 60_000;
    this.onLowBalance = deps.onLowBalance ?? (() => {});
  }

  railFor(chain: CaipChainId): RailClient | null {
    return this.rails.get(chain) ?? null;
  }

  availableRails(): readonly CaipChainId[] {
    return [...this.rails.entries()].filter(([, c]) => c.available()).map(([chain]) => chain);
  }

  /**
   * Mint a single-use, narrowly-scoped payment authority.
   *
   * Every check that can fail happens HERE, before an adapter holds anything: pause flags, rail
   * availability, the settlement allowlist, the per-provider per-tx cap, the daily cap, and the
   * float's minimum balance. By the time an adapter has a capability, the only remaining failure is
   * the provider's own.
   */
  async issueCapability(args: {
    readonly capabilityId: string;
    readonly intentId: string;
    readonly providerId: string;
    readonly asset: AssetRef;
    readonly maxAmount: Money;
    readonly allowedRecipients: readonly string[];
  }): Promise<PaymentCapability> {
    const { asset, maxAmount } = args;

    await this.pauses.assertNotPaused({
      providerId: args.providerId,
      chain: asset.chain,
      assetKey: assetKey(asset),
    });

    const rail = this.rails.get(asset.chain);
    if (!rail || !rail.available()) {
      throw new ProviderError(
        normalizedError(
          "TREASURY_INSUFFICIENT",
          `no settlement rail available for ${describeAsset(asset)} — ` +
            "the rail's signing key is not configured on this instance",
        ),
      );
    }

    const account = await this.store.findTreasuryAccount(asset.chain, asset.symbol, "SETTLEMENT");
    if (!account || !account.enabled) {
      throw new ProviderError(
        normalizedError(
          "TREASURY_INSUFFICIENT",
          `no enabled settlement treasury account for ${describeAsset(asset)}`,
        ),
      );
    }
    await this.pauses.assertNotPaused({ treasuryRef: account.treasuryRef });

    if (args.allowedRecipients.length === 0) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          "refusing to mint a payment capability with an empty recipient allowlist",
        ),
      );
    }

    await this.assertWithinLimits(args.providerId, account, maxAmount);
    await this.assertFloatSufficient(rail, account, maxAmount);

    const now = this.clock();
    const record: CapabilityRecord = {
      capabilityId: args.capabilityId,
      intentId: args.intentId,
      providerId: args.providerId,
      treasuryRef: account.treasuryRef,
      asset,
      maxAmount,
      allowedRecipients: args.allowedRecipients.map((r) => r.toLowerCase()),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.capabilityTtlMs).toISOString(),
      consumedAt: null,
      spentAmount: null,
    };
    await this.store.issueCapability(record);
    return this.wrap(record, rail);
  }

  private wrap(record: CapabilityRecord, rail: RailClient): PaymentCapability {
    const store = this.store;
    const clock = this.clock;
    return {
      capabilityId: record.capabilityId,
      intentId: record.intentId,
      chain: record.asset.chain,
      asset: record.asset,
      maxAmount: record.maxAmount,
      allowedRecipients: record.allowedRecipients,
      expiresAt: record.expiresAt,
      async pay(req: PaymentRequest): Promise<PaymentResult> {
        // Re-check every bound, in the capability itself. An adapter holding this object cannot
        // reach the rail client except through here, so these checks are not advisory.
        if (assetKey(req.amount.asset) !== assetKey(record.asset)) {
          throw new ProviderError(
            normalizedError(
              "PAYMENT_CHALLENGE_UNACCEPTABLE",
              `capability is scoped to ${describeAsset(record.asset)} but the payment is ` +
                `${describeAsset(req.amount.asset)}`,
            ),
          );
        }
        if (gtMoney(req.amount, record.maxAmount)) {
          throw new ProviderError(
            normalizedError(
              "PAYMENT_CHALLENGE_UNACCEPTABLE",
              `payment ${formatMoney(req.amount)} exceeds the authorised ceiling ` +
                `${formatMoney(record.maxAmount)} for intent ${record.intentId}`,
            ),
          );
        }
        if (req.amount.amount <= 0n) {
          throw new ProviderError(
            normalizedError("PAYMENT_CHALLENGE_UNACCEPTABLE", "refusing a non-positive payment"),
          );
        }
        if (!record.allowedRecipients.includes(req.recipient.toLowerCase())) {
          throw new ProviderError(
            normalizedError(
              "PAYMENT_CHALLENGE_UNACCEPTABLE",
              "payment recipient is not on the capability's allowlist — this is the exact " +
                "context-swap the capability exists to stop",
            ),
          );
        }

        // Redeem BEFORE signing. If the process dies between redemption and settlement, the
        // capability is spent and the intent lands in reconciliation — which is the correct
        // outcome. Redeeming after signing would leave a window where a crash permits a re-sign.
        const consumed = await store.consumeCapability(
          record.capabilityId,
          req.amount,
          new Date(clock()).toISOString(),
        );
        if (!consumed) {
          throw new ProviderError(
            normalizedError(
              "PAYMENT_CHALLENGE_UNACCEPTABLE",
              `payment capability ${record.capabilityId} is already consumed or expired — ` +
                "a second redemption is refused, never a second payment",
            ),
          );
        }

        return rail.pay(req);
      },
    };
  }

  private async assertWithinLimits(
    providerId: string,
    account: TreasuryAccountRecord,
    amount: Money,
  ): Promise<void> {
    const limit = await this.store.getProviderLimit(
      providerId,
      account.asset.chain,
      account.asset.symbol,
    );
    if (limit) {
      if (gtMoney(amount, limit.perTxMax)) {
        throw new ProviderError(
          normalizedError(
            "PAYMENT_CHALLENGE_UNACCEPTABLE",
            `${formatMoney(amount)} exceeds the per-transaction cap ${formatMoney(limit.perTxMax)} ` +
              `for provider ${providerId}`,
          ),
        );
      }
      const dayKey = new Date(this.clock()).toISOString().slice(0, 10);
      const spentToday = await this.store.accountDaySpend(
        `TREASURY:${assetKey(account.asset)}:${account.treasuryRef}`,
        account.asset,
        dayKey,
      );
      const wouldBe = { amount: spentToday.amount + amount.amount, asset: account.asset };
      if (gtMoney(wouldBe, limit.dailyMax)) {
        throw new ProviderError(
          normalizedError(
            "PAYMENT_CHALLENGE_UNACCEPTABLE",
            `this payment would take today's ${providerId} spend to ${formatMoney(wouldBe)}, over the ` +
              `daily cap ${formatMoney(limit.dailyMax)}`,
          ),
        );
      }
    }

    if (account.dailyLimit.amount > 0n) {
      const dayKey = new Date(this.clock()).toISOString().slice(0, 10);
      const spentToday = await this.store.accountDaySpend(
        `TREASURY:${assetKey(account.asset)}:${account.treasuryRef}`,
        account.asset,
        dayKey,
      );
      const wouldBe = { amount: spentToday.amount + amount.amount, asset: account.asset };
      if (gtMoney(wouldBe, account.dailyLimit)) {
        throw new ProviderError(
          normalizedError(
            "PAYMENT_CHALLENGE_UNACCEPTABLE",
            `this payment would take treasury ${account.treasuryRef} to ${formatMoney(wouldBe)} today, ` +
              `over its ${formatMoney(account.dailyLimit)} daily limit`,
          ),
        );
      }
    }
  }

  /**
   * The float must cover the payment AND stay above its minimum afterwards. The minimum is not a
   * safety margin for its own sake — it is what stops a single large purchase from draining a rail
   * and stranding every cheap action queued behind it.
   */
  private async assertFloatSufficient(
    rail: RailClient,
    account: TreasuryAccountRecord,
    amount: Money,
  ): Promise<void> {
    const balance = await rail.balanceOf(account.asset);
    const after = { amount: balance.amount - amount.amount, asset: account.asset };
    if (after.amount < account.minBalance.amount) {
      this.onLowBalance(account.treasuryRef, balance, account.minBalance);
      throw new ProviderError(
        normalizedError(
          "TREASURY_INSUFFICIENT",
          `paying ${formatMoney(amount)} would leave ${account.treasuryRef} at ` +
            `${formatMoney(after)}, below its ${formatMoney(account.minBalance)} floor`,
        ),
      );
    }
    if (after.amount < account.minBalance.amount + account.minBalance.amount / 4n) {
      // Approaching the floor: warn, but do not block. A human replenishes out of band.
      this.onLowBalance(account.treasuryRef, balance, account.minBalance);
    }
  }

  /**
   * Reconciliation: compare each float's on-chain balance against the ledger's internal position.
   * Drift is recorded, never auto-corrected — an automatic correction would make the ledger agree
   * with the chain by construction and destroy its value as an independent record.
   */
  async reconcile(): Promise<readonly { treasuryRef: string; drift: Money }[]> {
    const out: { treasuryRef: string; drift: Money }[] = [];
    for (const account of await this.store.listTreasuryAccounts()) {
      const rail = this.rails.get(account.asset.chain);
      if (!rail || !rail.available()) continue;
      const onchain = await rail.balanceOf(account.asset);
      const ledger = await this.store.accountBalance(
        `TREASURY:${assetKey(account.asset)}:${account.treasuryRef}`,
        account.asset,
      );
      const drift: Money = { amount: onchain.amount - ledger.amount, asset: account.asset };
      await this.store.recordBalanceObservation({
        treasuryRef: account.treasuryRef,
        onchain,
        ledger,
        drift,
        observedAt: new Date(this.clock()).toISOString(),
      });
      if (drift.amount !== 0n) out.push({ treasuryRef: account.treasuryRef, drift });
    }
    return out;
  }
}

/** The default PauseChecker, reading the flags table. */
export class StorePauseChecker implements PauseChecker {
  constructor(private readonly store: ConsumerStore) {}

  async assertNotPaused(scope: {
    readonly providerId?: string;
    readonly chain?: string;
    readonly assetKey?: string;
    readonly treasuryRef?: string;
  }): Promise<void> {
    const flags = await this.store.listPauses();
    const hit = firstEngagedPause(flags, scope);
    if (hit) {
      throw new ProviderError(
        normalizedError(
          "PAUSED",
          `${hit.scope} pause engaged${hit.target === "*" ? "" : ` for ${hit.target}`}: ${hit.reason}`,
        ),
      );
    }
  }
}
