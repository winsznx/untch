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
  | "ADJUSTMENT"
  /** An operator sweep between two rails' treasuries. Belongs to no intent. */
  | "TREASURY_TRANSFER";

export interface LedgerEntry {
  readonly accountId: string;
  /** Signed atomic amount. Positive = debit, negative = credit. */
  readonly amount: Money;
  readonly memo: string;
}

export interface LedgerGroup {
  readonly groupId: string;
  readonly kind: LedgerGroupKind;
  /** Null only for TREASURY_TRANSFER, which retires a position pooled across many intents. */
  readonly intentId: string | null;
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
 * RECOGNITION — on completion the obligation is discharged.
 *
 * Where the remainder lands depends on WHERE THE PROVIDER WAS PAID, and getting this wrong is how
 * the same purchase gets expensed twice.
 *
 * SAME-RAIL (the user funded in the asset the provider was paid in):
 *   +total      USER_OBLIGATION(intent)
 *   −fee        FEE_REVENUE
 *   −spread     SPREAD_REVENUE
 *   −remainder  COST_OF_GOODS(intent)     ← the expense, booked once, on the rail it happened
 *
 * CROSS-RAIL (funded on rail A, provider paid on rail B):
 *   +total      USER_OBLIGATION(intent)
 *   −fee        FEE_REVENUE
 *   −spread     SPREAD_REVENUE
 *   −remainder  CROSS_RAIL_CLEARING(rail A)   ← NOT an expense: a position owed to rail B
 *
 * The expense in the cross-rail case is `PROVIDER_SETTLEMENT` on rail B, recorded by the SETTLEMENT
 * group. Booking COST_OF_GOODS on rail A as well would expense the same purchase twice — once in
 * USDT0 and once in USDC — and leave rail B's float marching monotonically negative against a
 * positive on-chain balance, which is precisely the drift the activation report recorded.
 *
 * The clearing balance is not noise. It is the operator's instruction: "rail A is holding value that
 * belongs to rail B; sweep it." `treasuryTransferGroups` books that sweep and retires the position.
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
  /**
   * The asset the provider was actually paid in. Omitted ⇒ same-rail (the legacy shape), which keeps
   * every existing single-rail caller correct without change.
   */
  readonly settlementAsset?: AssetRef;
}): LedgerGroup {
  const asset = args.total.asset;
  if (!sameAsset(args.fee.asset, asset)) throw new LedgerAssetMixError(args.groupId, asset, args.fee.asset);
  if (!sameAsset(args.spread.asset, asset)) {
    throw new LedgerAssetMixError(args.groupId, asset, args.spread.asset);
  }
  const settledOn = args.settlementAsset;
  const crossRail = settledOn !== undefined && !sameAsset(settledOn, asset);
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
    // Same-rail: this IS the expense. Cross-rail: this is a clearing POSITION, and the expense
    // lives on the settlement rail where the money actually left.
    crossRail && settledOn
      ? {
          accountId: clearingAccount(asset),
          amount: neg(remainder),
          memo: `owed to ${describeAsset(settledOn)} — provider paid on that rail`,
        }
      : {
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

/**
 * TREASURY_TRANSFER — the operator sweep that retires a cross-rail clearing position.
 *
 * Cross-rail execution leaves rail A holding user funds that paid for something bought on rail B.
 * RECOGNITION books that as `CROSS_RAIL_CLEARING(A)`, and rail B's float is genuinely down. Neither
 * side is wrong; they are two halves of one movement that has not physically happened yet. When the
 * operator actually moves the value — an exchange, a bridge, an OTC transfer, a manual top-up —
 * *this* is the entry that records it, and the clearing position goes back to zero.
 *
 * Two groups, never one, because a group is single-asset:
 *
 *   rail A (out):  +sentA  CROSS_RAIL_CLEARING(A)      −sentA  TREASURY(A)
 *   rail B (in):   +recvB  TREASURY(B)                 −recvB  CROSS_RAIL_CLEARING(B)
 *
 * `sentA` and `recvB` are the two REAL leg amounts, quoted independently. They are not converted
 * into each other and no price is stored — this ledger never holds a rate. What remains afterwards
 * is a residual clearing balance on each rail, and that residual IS the realised conversion result:
 * the difference between the spread charged at quote time and the spread the operator actually got.
 * Forcing the two legs to net to zero would be inventing a rate to hide that number.
 */
export function treasuryTransferGroups(args: {
  readonly groupIdOut: string;
  readonly groupIdIn: string;
  readonly sent: Money;
  readonly received: Money;
  readonly fromTreasuryRef: string;
  readonly toTreasuryRef: string;
  readonly createdAt: string;
  readonly reference?: string;
}): readonly [LedgerGroup, LedgerGroup] {
  const from = args.sent.asset;
  const to = args.received.asset;
  if (sameAsset(from, to)) {
    throw new Error(
      `treasury transfer ${args.groupIdOut} is same-asset (${describeAsset(from)}); ` +
        "a cross-rail clearing sweep must move between two different rails",
    );
  }
  if (args.sent.amount <= 0n || args.received.amount <= 0n) {
    throw new Error(
      `treasury transfer ${args.groupIdOut} needs two positive legs, got ` +
        `${formatMoney(args.sent)} out and ${formatMoney(args.received)} in`,
    );
  }
  const ref = args.reference ? ` (${args.reference})` : "";
  const out: LedgerGroup = {
    groupId: args.groupIdOut,
    kind: "TREASURY_TRANSFER",
    intentId: null,
    asset: from,
    createdAt: args.createdAt,
    entries: [
      {
        accountId: clearingAccount(from),
        amount: args.sent,
        memo: `clearing retired toward ${describeAsset(to)}${ref}`,
      },
      { accountId: treasuryAccount(from, args.fromTreasuryRef), amount: neg(args.sent), memo: `float sent${ref}` },
    ],
  };
  const inbound: LedgerGroup = {
    groupId: args.groupIdIn,
    kind: "TREASURY_TRANSFER",
    intentId: null,
    asset: to,
    createdAt: args.createdAt,
    entries: [
      { accountId: treasuryAccount(to, args.toTreasuryRef), amount: args.received, memo: `float received${ref}` },
      {
        accountId: clearingAccount(to),
        amount: neg(args.received),
        memo: `clearing retired from ${describeAsset(from)}${ref}`,
      },
    ],
  };
  assertGroupBalanced(out);
  assertGroupBalanced(inbound);
  return [out, inbound];
}

/**
 * The reconciliation statement for one rail, in the form an operator has to act on.
 *
 * Two fields are decisions, not statistics:
 *
 * `owedToOtherRails` — negative means this rail is SITTING ON value that paid for something bought
 * elsewhere. Sweep that much out. Zero means nothing is outstanding.
 *
 * `floatPosition` — the net change in this rail's treasury. Negative on a settlement rail means the
 * float has been spent down by exactly that much and needs a top-up. This was the number that read
 * as "drift" in the activation report: it was never wrong, it was un-actionable, because no entry
 * existed that could ever bring it back up.
 *
 * `unreimbursedCost` is the correctness check rather than a to-do. Cost lands in COST_OF_GOODS when
 * the purchase was same-rail and in CROSS_RAIL_CLEARING once a cross-rail purchase has been swept;
 * either way it nets against PROVIDER_SETTLEMENT. A non-zero value means one of: a cross-rail
 * purchase not yet swept (expected, transient), or a settlement whose recognition never ran (a bug).
 */
export interface RailReconciliation {
  readonly asset: AssetRef;
  readonly floatPosition: Money;
  readonly clearing: Money;
  readonly costOfGoods: Money;
  readonly providerSettlement: Money;
  readonly feeRevenue: Money;
  readonly spreadRevenue: Money;
  readonly openObligations: Money;
  readonly refundsPayable: Money;
  readonly suspense: Money;
  readonly owedToOtherRails: Money;
  readonly unreimbursedCost: Money;
}

export function reconcileRail(asset: AssetRef, groups: readonly LedgerGroup[]): RailReconciliation {
  const balances = projectBalances(groups);
  const prefix = (kind: LedgerAccountKind): string => `${kind}:${assetKey(asset)}:`;
  const sumKind = (kind: LedgerAccountKind): Money => {
    let acc = money(0n, asset);
    for (const [accountId, value] of balances) {
      if (accountId.startsWith(prefix(kind))) acc = addMoney(acc, value);
    }
    return acc;
  };
  const clearing = sumKind("CROSS_RAIL_CLEARING");
  const costOfGoods = sumKind("COST_OF_GOODS");
  const providerSettlement = sumKind("PROVIDER_SETTLEMENT");
  return {
    asset,
    floatPosition: sumKind("TREASURY"),
    clearing,
    costOfGoods,
    providerSettlement,
    feeRevenue: sumKind("FEE_REVENUE"),
    spreadRevenue: sumKind("SPREAD_REVENUE"),
    openObligations: sumKind("USER_OBLIGATION"),
    refundsPayable: sumKind("REFUND_PAYABLE"),
    suspense: sumKind("SUSPENSE"),
    owedToOtherRails: clearing.amount < 0n ? clearing : money(0n, asset),
    unreimbursedCost: money(providerSettlement.amount + costOfGoods.amount + clearing.amount, asset),
  };
}

/**
 * The whole-book invariant: every account, every rail, sums to zero.
 *
 * This is stronger than per-group balance and is the check that would have caught the double-expense
 * directly. It holds only because CROSS_RAIL_CLEARING carries the un-swept position instead of a
 * second COST_OF_GOODS leg — with the double-expense in place, no arrangement of accounts sums to
 * zero, which is what "the settlement float marches negative forever" was really reporting.
 */
export function assertBookBalanced(groups: readonly LedgerGroup[]): void {
  const perAsset = new Map<string, Money>();
  for (const g of groups) {
    for (const e of g.entries) {
      const k = assetKey(e.amount.asset);
      const prior = perAsset.get(k);
      perAsset.set(k, prior ? addMoney(prior, e.amount) : e.amount);
    }
  }
  for (const [k, total] of perAsset) {
    if (!isZero(total)) {
      throw new Error(`ledger does not balance on ${k}: net ${formatMoney(total)} (expected zero)`);
    }
  }
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
