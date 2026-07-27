/**
 * The Consumer Pack double-entry ledger.
 *
 * The existing `ledger_entries` table (receipt-writer, migration 001) is single-sided and
 * receipt-scoped: one row saying "this agent spent X". That is the right shape for what it does and
 * is left completely untouched. It cannot, however, answer the question the Consumer Pack must be
 * able to answer at any instant — *where is the money* — because value now lives in several places
 * at once: funded but unspent, spent but unverified, owed back to a user, earned as fee.
 *
 * So this is a real double-entry ledger, with one deliberate constraint that makes it tractable
 * across chains:
 *
 *   AN ENTRY GROUP IS SINGLE-ASSET. Every entry in a group shares one (chain, token) and the group
 *   sums to exactly zero. A cross-rail movement is therefore never one group — it is two, joined by
 *   a CROSS_RAIL_CLEARING account on each side.
 *
 * That constraint is what keeps "balanced" checkable in SQL. Summing USDT0 on X Layer and USDC on
 * Base into one figure would require a price, and a ledger whose correctness depends on a price feed
 * is a ledger that can be made to balance by moving the price.
 *
 * Sign convention: positive = debit (a rise in an asset or expense), negative = credit.
 * Balances are ALWAYS `SUM(entries)`. No mutable balance column is authoritative anywhere.
 */

import type { AssetRef } from "./assets";
import { assetKey, describeAsset } from "./assets";
import { addMoney, formatMoney, isZero, money, type Money, sameAsset } from "./money";

export type LedgerAccountKind =
  /** Untch's operational float on a rail. An asset account. */
  | "TREASURY"
  /** What Untch owes a specific intent between funding and completion. A liability. */
  | "USER_OBLIGATION"
  /** Value paid out to a provider. An expense. */
  | "PROVIDER_SETTLEMENT"
  /** Untch's orchestration fee. Income. */
  | "FEE_REVENUE"
  /** The disclosed cross-rail spread. Income. */
  | "SPREAD_REVENUE"
  /** The part of the user's funding that paid for the goods. An expense. */
  | "COST_OF_GOODS"
  /** Owed back to a user after a failure. A liability. */
  | "REFUND_PAYABLE"
  /** The per-asset join between the two halves of a cross-rail movement. */
  | "CROSS_RAIL_CLEARING"
  /** Value parked while a human resolves an ambiguous outcome. */
  | "SUSPENSE";

export interface LedgerAccount {
  readonly accountId: string;
  readonly kind: LedgerAccountKind;
  readonly asset: AssetRef;
  /** What the account is scoped to: an intentId, a providerId, a treasury account, or "global". */
  readonly ownerRef: string;
}

export type LedgerGroupKind =
  | "FUNDING"
  | "SETTLEMENT"
  | "RECOGNITION"
  | "REFUND"
  | "SUSPENSE_MOVE"
  | "ADJUSTMENT";

export interface LedgerEntry {
  readonly accountId: string;
  /** Signed atomic amount. Positive = debit, negative = credit. */
  readonly amount: Money;
  readonly memo: string;
}

export interface LedgerGroup {
  readonly groupId: string;
  readonly kind: LedgerGroupKind;
  readonly intentId: string;
  readonly asset: AssetRef;
  readonly entries: readonly LedgerEntry[];
  readonly createdAt: string;
}

export class LedgerImbalanceError extends Error {
  constructor(groupId: string, residual: Money) {
    super(
      `ledger group ${groupId} does not balance: residual ${formatMoney(residual)} ` +
        `${describeAsset(residual.asset)} — every group must sum to exactly zero within its asset`,
    );
    this.name = "LedgerImbalanceError";
  }
}

export class LedgerAssetMixError extends Error {
  constructor(groupId: string, expected: AssetRef, found: AssetRef) {
    super(
      `ledger group ${groupId} mixes assets: expected ${describeAsset(expected)}, found ` +
        `${describeAsset(found)} — a group is single-asset by construction; a cross-rail movement is two groups`,
    );
    this.name = "LedgerAssetMixError";
  }
}

/**
 * The check every group passes before it is written. Called by the repository inside the same
 * transaction as the insert, so an unbalanced group cannot reach storage even transiently.
 */
export function assertGroupBalanced(group: LedgerGroup): void {
  if (group.entries.length === 0) {
    throw new LedgerImbalanceError(group.groupId, money(0n, group.asset));
  }
  let total = money(0n, group.asset);
  for (const e of group.entries) {
    if (!sameAsset(e.amount.asset, group.asset)) {
      throw new LedgerAssetMixError(group.groupId, group.asset, e.amount.asset);
    }
    total = addMoney(total, e.amount);
  }
  if (!isZero(total)) throw new LedgerImbalanceError(group.groupId, total);
}

/** Deterministic account id. Same (kind, asset, ownerRef) always resolves to the same account. */
export function accountIdFor(kind: LedgerAccountKind, asset: AssetRef, ownerRef: string): string {
  return `${kind}:${assetKey(asset)}:${ownerRef}`;
}

export function treasuryAccount(asset: AssetRef, treasuryRef: string): string {
  return accountIdFor("TREASURY", asset, treasuryRef);
}

export function userObligationAccount(asset: AssetRef, intentId: string): string {
  return accountIdFor("USER_OBLIGATION", asset, intentId);
}

export function clearingAccount(asset: AssetRef): string {
  return accountIdFor("CROSS_RAIL_CLEARING", asset, "global");
}

const neg = (m: Money): Money => money(-m.amount, m.asset);

/**
 * FUNDING — the user's payment lands in the X Layer float and creates an obligation to this intent.
 *
 *   +total  TREASURY(funding rail)
 *   −total  USER_OBLIGATION(intent)
 */
export function fundingGroup(args: {
  readonly groupId: string;
  readonly intentId: string;
  readonly total: Money;
  readonly treasuryRef: string;
  readonly createdAt: string;
}): LedgerGroup {
  const asset = args.total.asset;
  const group: LedgerGroup = {
    groupId: args.groupId,
    kind: "FUNDING",
    intentId: args.intentId,
    asset,
    createdAt: args.createdAt,
    entries: [
      { accountId: treasuryAccount(asset, args.treasuryRef), amount: args.total, memo: "user funding received" },
      {
        accountId: userObligationAccount(asset, args.intentId),
        amount: neg(args.total),
        memo: "obligation to intent opened",
      },
    ],
  };
  assertGroupBalanced(group);
  return group;
}

/**
 * SETTLEMENT — the provider is paid out of the settlement-rail float.
 *
 *   +cost  PROVIDER_SETTLEMENT(provider)
 *   −cost  TREASURY(settlement rail)
 *
 * The provider-settlement account is the expense; the clearing account is touched by RECOGNITION on
 * the funding side, so the two rails join without ever being summed together.
 */
export function settlementGroup(args: {
  readonly groupId: string;
  readonly intentId: string;
  readonly cost: Money;
  readonly providerId: string;
  readonly treasuryRef: string;
  readonly createdAt: string;
}): LedgerGroup {
  const asset = args.cost.asset;
  const group: LedgerGroup = {
    groupId: args.groupId,
    kind: "SETTLEMENT",
    intentId: args.intentId,
    asset,
    createdAt: args.createdAt,
    entries: [
      {
        accountId: accountIdFor("PROVIDER_SETTLEMENT", asset, args.providerId),
        amount: args.cost,
        memo: "provider paid",
      },
      {
        accountId: treasuryAccount(asset, args.treasuryRef),
        amount: neg(args.cost),
        memo: "settlement float drawn",
      },
    ],
  };
  assertGroupBalanced(group);
  return group;
}

/**
 * RECOGNITION — on completion the obligation is discharged into fee, spread and cost of goods.
 *
 *   +total      USER_OBLIGATION(intent)
 *   −fee        FEE_REVENUE
 *   −spread     SPREAD_REVENUE
 *   −remainder  COST_OF_GOODS(intent)      ← remainder = total − fee − spread
 *
 * `remainder` is computed, never supplied, so the group cannot be made to balance by passing a
 * cost-of-goods figure that does not follow from the quote.
 */
export function recognitionGroup(args: {
  readonly groupId: string;
  readonly intentId: string;
  readonly total: Money;
  readonly fee: Money;
  readonly spread: Money;
  readonly createdAt: string;
}): LedgerGroup {
  const asset = args.total.asset;
  if (!sameAsset(args.fee.asset, asset)) throw new LedgerAssetMixError(args.groupId, asset, args.fee.asset);
  if (!sameAsset(args.spread.asset, asset)) {
    throw new LedgerAssetMixError(args.groupId, asset, args.spread.asset);
  }
  const remainder = money(args.total.amount - args.fee.amount - args.spread.amount, asset);
  if (remainder.amount < 0n) {
    throw new Error(
      `recognition for ${args.intentId} would give a negative cost of goods ` +
        `(${formatMoney(args.total)} total − ${formatMoney(args.fee)} fee − ${formatMoney(args.spread)} spread)`,
    );
  }
  /**
   * Zero-value legs are OMITTED, not written as zero rows.
   *
   * An earlier version kept them for audit readability — "we charged nothing" being visible is a
   * real virtue. The database disagrees, and it is right to: `consumer_ledger_entries` carries
   * `CHECK (amount <> 0)`, because an entry that moves nothing is either a bug or noise. Keeping the
   * zero rows meant that any action with no fee — `domains.check`, `travel.search`, anything absent
   * from FEE_BPS — produced a RECOGNITION group Postgres would REJECT, and it would reject it
   * *after* the merchant had already been paid. The intent would strand in DELIVERY_VERIFIED with
   * the money unaccounted for.
   *
   * The group still balances: omitting a zero changes no sum. What "we charged nothing" now looks
   * like is the absence of a FEE_REVENUE leg, which the receipt renders explicitly as a zero fee
   * from the quote — so nothing is actually hidden.
   */
  const entries = [
    {
      accountId: userObligationAccount(asset, args.intentId),
      amount: args.total,
      memo: "obligation discharged",
    },
    { accountId: accountIdFor("FEE_REVENUE", asset, "global"), amount: neg(args.fee), memo: "untch fee" },
    {
      accountId: accountIdFor("SPREAD_REVENUE", asset, "global"),
      amount: neg(args.spread),
      memo: "disclosed cross-rail spread",
    },
    {
      accountId: accountIdFor("COST_OF_GOODS", asset, args.intentId),
      amount: neg(remainder),
      memo: "cost of goods",
    },
  ].filter((e) => e.amount.amount !== 0n);

  const group: LedgerGroup = {
    groupId: args.groupId,
    kind: "RECOGNITION",
    intentId: args.intentId,
    asset,
    createdAt: args.createdAt,
    entries,
  };
  assertGroupBalanced(group);
  return group;
}

/**
 * REFUND — a failure before provider payment converts the obligation into a payable.
 *
 *   +amount  USER_OBLIGATION(intent)
 *   −amount  REFUND_PAYABLE(intent)
 */
export function refundGroup(args: {
  readonly groupId: string;
  readonly intentId: string;
  readonly amount: Money;
  readonly createdAt: string;
}): LedgerGroup {
  const asset = args.amount.asset;
  const group: LedgerGroup = {
    groupId: args.groupId,
    kind: "REFUND",
    intentId: args.intentId,
    asset,
    createdAt: args.createdAt,
    entries: [
      {
        accountId: userObligationAccount(asset, args.intentId),
        amount: args.amount,
        memo: "obligation converted to refund",
      },
      {
        accountId: accountIdFor("REFUND_PAYABLE", asset, args.intentId),
        amount: neg(args.amount),
        memo: "refund payable",
      },
    ],
  };
  assertGroupBalanced(group);
  return group;
}

/** SUSPENSE — an ambiguous post-payment outcome parks the obligation until a human resolves it. */
export function suspenseGroup(args: {
  readonly groupId: string;
  readonly intentId: string;
  readonly amount: Money;
  readonly createdAt: string;
}): LedgerGroup {
  const asset = args.amount.asset;
  const group: LedgerGroup = {
    groupId: args.groupId,
    kind: "SUSPENSE_MOVE",
    intentId: args.intentId,
    asset,
    createdAt: args.createdAt,
    entries: [
      {
        accountId: userObligationAccount(asset, args.intentId),
        amount: args.amount,
        memo: "obligation parked pending manual review",
      },
      {
        accountId: accountIdFor("SUSPENSE", asset, args.intentId),
        amount: neg(args.amount),
        memo: "suspense: ambiguous provider outcome",
      },
    ],
  };
  assertGroupBalanced(group);
  return group;
}

/** In-memory balance projection. The Pg repo does the same with SUM(amount) GROUP BY account. */
export function projectBalances(groups: readonly LedgerGroup[]): Map<string, Money> {
  const out = new Map<string, Money>();
  for (const g of groups) {
    for (const e of g.entries) {
      const prior = out.get(e.accountId);
      out.set(e.accountId, prior ? addMoney(prior, e.amount) : e.amount);
    }
  }
  return out;
}

/**
 * The completed-intent invariant, stated once so both the test suite and the reconciliation job
 * assert the same thing: a COMPLETED intent's USER_OBLIGATION must be exactly zero — everything the
 * user funded has been recognised as fee, spread or cost of goods, with nothing left unaccounted.
 */
export function assertIntentSettled(
  intentId: string,
  fundingAsset: AssetRef,
  groups: readonly LedgerGroup[],
): void {
  const balances = projectBalances(groups);
  const obligation = balances.get(userObligationAccount(fundingAsset, intentId));
  if (obligation && !isZero(obligation)) {
    throw new Error(
      `intent ${intentId} is marked settled but its user obligation is ${formatMoney(obligation)} ` +
        `${describeAsset(fundingAsset)}, not zero`,
    );
  }
}
