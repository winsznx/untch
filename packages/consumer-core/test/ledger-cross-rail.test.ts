import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  accountIdFor,
  asset,
  assertBookBalanced,
  assertIntentSettled,
  clearingAccount,
  fundingGroup,
  money,
  parseMoney,
  projectBalances,
  reconcileRail,
  recognitionGroup,
  refundGroup,
  settlementGroup,
  suspenseGroup,
  treasuryAccount,
  treasuryTransferGroups,
  zeroMoney,
  type AssetRef,
  type LedgerGroup,
  type Money,
} from "../src/index";

/**
 * The cross-rail money story, end to end.
 *
 * These tests exist because the activation run produced a settlement float that marched monotonically
 * negative — 3000000 atomic units on `base-usdc-settlement` — and the report called it drift. It was
 * not drift. It was a purchase expensed on two rails at once, plus a replenishment the ledger had no
 * way to record. Every test below asserts a number an operator would act on, not merely that some
 * function returned without throwing.
 */

const USDT0 = asset("xlayer.usdt0");
const USDC = asset("base.usdc");
const AT = "2026-07-27T12:00:00.000Z";

const FUNDING_REF = "xlayer-usdt0-funding";
const SETTLEMENT_REF = "base-usdc-settlement";

/** The exact shape the orchestrator writes for one completed cross-rail intent. */
function crossRailIntent(args: {
  readonly intentId: string;
  readonly total: string;
  readonly fee: string;
  readonly spread: string;
  readonly providerCost: string;
}): LedgerGroup[] {
  return [
    fundingGroup({
      groupId: `f_${args.intentId}`,
      intentId: args.intentId,
      total: parseMoney(args.total, USDT0),
      treasuryRef: FUNDING_REF,
      createdAt: AT,
    }),
    settlementGroup({
      groupId: `s_${args.intentId}`,
      intentId: args.intentId,
      cost: parseMoney(args.providerCost, USDC),
      providerId: "stabledomains",
      treasuryRef: SETTLEMENT_REF,
      createdAt: AT,
    }),
    recognitionGroup({
      groupId: `r_${args.intentId}`,
      intentId: args.intentId,
      total: parseMoney(args.total, USDT0),
      fee: parseMoney(args.fee, USDT0),
      spread: parseMoney(args.spread, USDT0),
      settlementAsset: USDC,
      createdAt: AT,
    }),
  ];
}

const balanceOf = (groups: readonly LedgerGroup[], accountId: string, a: AssetRef): Money =>
  projectBalances(groups).get(accountId) ?? money(0n, a);

describe("cross-rail — the remainder is a clearing position, not a second expense", () => {
  test("cross-rail recognition books CROSS_RAIL_CLEARING and NOT cost of goods", () => {
    // #given a user funding 20.50 USDT0 on X Layer for goods bought in USDC on Base
    // #when the obligation is discharged
    const g = recognitionGroup({
      groupId: "r1",
      intentId: "ci_x1",
      total: parseMoney("20.50", USDT0),
      fee: parseMoney("0.30", USDT0),
      spread: parseMoney("0.10", USDT0),
      settlementAsset: USDC,
      createdAt: AT,
    });

    // #then the remainder is a position owed to the settlement rail, not an expense on this one
    assert.equal(
      g.entries.some((e) => e.accountId.startsWith("COST_OF_GOODS")),
      false,
      "expensing here would double-count against PROVIDER_SETTLEMENT on Base",
    );
    const clearing = g.entries.find((e) => e.accountId === clearingAccount(USDT0));
    assert.equal(clearing?.amount.amount, -20_100_000n, "20.50 − 0.30 fee − 0.10 spread");
  });

  test("same-rail recognition still books cost of goods directly — no clearing involved", () => {
    // #given funding and settlement in the SAME asset
    const g = recognitionGroup({
      groupId: "r2",
      intentId: "ci_s1",
      total: parseMoney("20.40", USDC),
      fee: parseMoney("0.30", USDC),
      spread: parseMoney("0.10", USDC),
      settlementAsset: USDC,
      createdAt: AT,
    });

    // #then nothing crosses rails, so nothing clears
    assert.equal(g.entries.some((e) => e.accountId.startsWith("CROSS_RAIL_CLEARING")), false);
    const cog = g.entries.find((e) => e.accountId.startsWith("COST_OF_GOODS"));
    assert.equal(cog?.amount.amount, -20_000_000n);
  });

  test("an omitted settlementAsset behaves as same-rail — every pre-existing caller stays correct", () => {
    const legacy = recognitionGroup({
      groupId: "r3",
      intentId: "ci_l1",
      total: parseMoney("20.40", USDC),
      fee: parseMoney("0.30", USDC),
      spread: parseMoney("0.10", USDC),
      createdAt: AT,
    });
    assert.ok(legacy.entries.some((e) => e.accountId.startsWith("COST_OF_GOODS")));
  });
});

describe("cross-rail — a completed intent reconciles on both rails", () => {
  const groups = crossRailIntent({
    intentId: "ci_full",
    total: "20.50",
    fee: "0.30",
    spread: "0.10",
    providerCost: "20.00",
  });

  test("the whole book sums to zero on every rail", () => {
    assertBookBalanced(groups);
  });

  test("the user obligation lands on exactly zero", () => {
    assertIntentSettled("ci_full", USDT0, groups);
  });

  test("the funding rail reports the un-swept position as the number to act on", () => {
    const a = reconcileRail(USDT0, groups);
    // #then X Layer physically holds everything the user sent
    assert.equal(a.floatPosition.amount, 20_500_000n);
    // #and 20.10 of it belongs to Base, which is what the operator must move
    assert.equal(a.owedToOtherRails.amount, -20_100_000n);
    assert.equal(a.feeRevenue.amount, -300_000n);
    assert.equal(a.spreadRevenue.amount, -100_000n);
    assert.equal(a.openObligations.amount, 0n);
  });

  test("the settlement rail reports a float that is genuinely down and needs a top-up", () => {
    const b = reconcileRail(USDC, groups);
    // #then Base really did pay out 20.00 and has not been replenished
    assert.equal(b.floatPosition.amount, -20_000_000n, "the exact top-up required");
    assert.equal(b.providerSettlement.amount, 20_000_000n, "the expense, recorded once");
    // #and the cost is not yet reimbursed from the funding rail — expected until the sweep runs
    assert.equal(b.unreimbursedCost.amount, 20_000_000n);
  });

  test("REGRESSION: the cost is expensed exactly once across both rails", () => {
    // The defect: COST_OF_GOODS on X Layer AND PROVIDER_SETTLEMENT on Base for one purchase.
    const cogAnywhere = groups.flatMap((g) => g.entries).filter((e) => e.accountId.startsWith("COST_OF_GOODS"));
    const settlements = groups.flatMap((g) => g.entries).filter((e) => e.accountId.startsWith("PROVIDER_SETTLEMENT"));
    assert.equal(cogAnywhere.length, 0);
    assert.equal(settlements.length, 1);
  });
});

describe("cross-rail — the treasury sweep retires the position", () => {
  const intent = crossRailIntent({
    intentId: "ci_sweep",
    total: "20.50",
    fee: "0.30",
    spread: "0.10",
    providerCost: "20.00",
  });
  // The operator moves the real value: 20.10 USDT0 out, 20.00 USDC in. Two independently quoted
  // legs; no rate is stored anywhere.
  const sweep = treasuryTransferGroups({
    groupIdOut: "tt_out",
    groupIdIn: "tt_in",
    sent: parseMoney("20.10", USDT0),
    received: parseMoney("20.00", USDC),
    fromTreasuryRef: FUNDING_REF,
    toTreasuryRef: SETTLEMENT_REF,
    createdAt: AT,
    reference: "otc-2026-07-27",
  });
  const all = [...intent, ...sweep];

  test("the book still sums to zero after the sweep", () => {
    assertBookBalanced(all);
  });

  test("the funding rail has nothing left owed and retains exactly the fee plus spread", () => {
    const a = reconcileRail(USDT0, all);
    assert.equal(a.owedToOtherRails.amount, 0n, "position retired");
    assert.equal(a.clearing.amount, 0n);
    assert.equal(a.floatPosition.amount, 400_000n, "0.30 fee + 0.10 spread, and not a unit more");
  });

  test("the settlement float is restored to flat and the cost is fully reimbursed", () => {
    const b = reconcileRail(USDC, all);
    assert.equal(b.floatPosition.amount, 0n, "no top-up outstanding");
    assert.equal(b.unreimbursedCost.amount, 0n, "PROVIDER_SETTLEMENT is offset by the inbound clearing");
  });

  test("the sweep belongs to no intent, so a second sweep is not a duplicate", () => {
    assert.equal(sweep[0].intentId, null);
    assert.equal(sweep[1].intentId, null);
    assert.equal(sweep[0].kind, "TREASURY_TRANSFER");
  });

  test("a sweep that does not actually cross rails is rejected", () => {
    assert.throws(
      () =>
        treasuryTransferGroups({
          groupIdOut: "x",
          groupIdIn: "y",
          sent: parseMoney("1.00", USDC),
          received: parseMoney("1.00", USDC),
          fromTreasuryRef: "a",
          toTreasuryRef: "b",
          createdAt: AT,
        }),
      /same-asset/,
    );
  });

  test("a sweep with a zero or negative leg is rejected", () => {
    assert.throws(
      () =>
        treasuryTransferGroups({
          groupIdOut: "x",
          groupIdIn: "y",
          sent: parseMoney("1.00", USDT0),
          received: zeroMoney(USDC),
          fromTreasuryRef: "a",
          toTreasuryRef: "b",
          createdAt: AT,
        }),
      /two positive legs/,
    );
  });

  test("an unfavourable conversion leaves a VISIBLE residual rather than being netted away", () => {
    // #given the operator only realises 19.80 USDC for the 20.10 USDT0 they sent
    const worse = treasuryTransferGroups({
      groupIdOut: "tt_out2",
      groupIdIn: "tt_in2",
      sent: parseMoney("20.10", USDT0),
      received: parseMoney("19.80", USDC),
      fromTreasuryRef: FUNDING_REF,
      toTreasuryRef: SETTLEMENT_REF,
      createdAt: AT,
    });
    const withLoss = [...intent, ...worse];

    // #then the book still balances — no rate was invented to force the legs to net
    assertBookBalanced(withLoss);
    // #and the shortfall shows up as float the settlement rail is still missing
    const b = reconcileRail(USDC, withLoss);
    assert.equal(b.floatPosition.amount, -200_000n, "0.20 short — the realised conversion loss");
  });
});

describe("cross-rail — the failure paths", () => {
  test("a refund BEFORE provider payment touches no clearing account at all", () => {
    const total = parseMoney("7.25", USDT0);
    const groups = [
      fundingGroup({ groupId: "f", intentId: "ci_r", total, treasuryRef: FUNDING_REF, createdAt: AT }),
      refundGroup({ groupId: "rf", intentId: "ci_r", amount: total, createdAt: AT }),
    ];
    assertBookBalanced(groups);
    assertIntentSettled("ci_r", USDT0, groups);
    const a = reconcileRail(USDT0, groups);
    assert.equal(a.clearing.amount, 0n, "nothing crossed rails, so nothing clears");
    assert.equal(a.refundsPayable.amount, -7_250_000n, "owed back to the user, in full");
  });

  test("an ambiguous failure AFTER provider payment parks the obligation and leaves the float down", () => {
    // #given the provider was paid but the outcome could not be established
    const total = parseMoney("20.50", USDT0);
    const groups = [
      fundingGroup({ groupId: "f", intentId: "ci_amb", total, treasuryRef: FUNDING_REF, createdAt: AT }),
      settlementGroup({
        groupId: "s",
        intentId: "ci_amb",
        cost: parseMoney("20.00", USDC),
        providerId: "stabledomains",
        treasuryRef: SETTLEMENT_REF,
        createdAt: AT,
      }),
      suspenseGroup({ groupId: "sus", intentId: "ci_amb", amount: total, createdAt: AT }),
    ];

    // #then the book balances and the money is findable by a human, not written off
    assertBookBalanced(groups);
    assertIntentSettled("ci_amb", USDT0, groups);
    assert.equal(reconcileRail(USDT0, groups).suspense.amount, -20_500_000n);
    // #and the settlement rail correctly still shows the money it really paid out
    assert.equal(reconcileRail(USDC, groups).floatPosition.amount, -20_000_000n);
  });

  test("a zero-fee read service (domains.check) clears its whole total cross-rail", () => {
    // #given domains.check has no FEE_BPS entry, so fee and spread are both zero
    const groups = crossRailIntent({
      intentId: "ci_check",
      total: "0.05",
      fee: "0.00",
      spread: "0.00",
      providerCost: "0.05",
    });
    assertBookBalanced(groups);
    assertIntentSettled("ci_check", USDT0, groups);

    const recognition = groups[2];
    // #then no zero-amount row is emitted — consumer_ledger_entries carries CHECK (amount <> 0)
    assert.equal(recognition.entries.length, 2, "obligation + clearing only");
    assert.equal(recognition.entries.some((e) => e.amount.amount === 0n), false);
    // #and Untch keeps nothing: the entire total is owed to the settlement rail
    assert.equal(reconcileRail(USDT0, groups).owedToOtherRails.amount, -50_000n);
  });

  test("a partial fee with no spread still discharges the obligation exactly", () => {
    const groups = crossRailIntent({
      intentId: "ci_partial",
      total: "10.15",
      fee: "0.15",
      spread: "0.00",
      providerCost: "10.00",
    });
    assertBookBalanced(groups);
    assertIntentSettled("ci_partial", USDT0, groups);
    const a = reconcileRail(USDT0, groups);
    assert.equal(a.feeRevenue.amount, -150_000n);
    assert.equal(a.spreadRevenue.amount, 0n, "a zero spread is an absent leg, not a zero row");
    assert.equal(a.owedToOtherRails.amount, -10_000_000n);
  });
});

describe("cross-rail — many intents accumulate into one sweepable position", () => {
  test("three intents pool into a single clearing balance and one sweep retires all of them", () => {
    // #given three completed cross-rail intents
    const many = [
      ...crossRailIntent({ intentId: "ci_a", total: "10.10", fee: "0.10", spread: "0.00", providerCost: "10.00" }),
      ...crossRailIntent({ intentId: "ci_b", total: "5.05", fee: "0.05", spread: "0.00", providerCost: "5.00" }),
      ...crossRailIntent({ intentId: "ci_c", total: "2.02", fee: "0.02", spread: "0.00", providerCost: "2.00" }),
    ];
    assert.equal(reconcileRail(USDT0, many).owedToOtherRails.amount, -17_000_000n);
    assert.equal(reconcileRail(USDC, many).floatPosition.amount, -17_000_000n);

    // #when the operator sweeps once, for the pooled amount
    const sweep = treasuryTransferGroups({
      groupIdOut: "tt_pool_out",
      groupIdIn: "tt_pool_in",
      sent: parseMoney("17.00", USDT0),
      received: parseMoney("17.00", USDC),
      fromTreasuryRef: FUNDING_REF,
      toTreasuryRef: SETTLEMENT_REF,
      createdAt: AT,
      reference: "daily-sweep",
    });
    const all = [...many, ...sweep];

    // #then every rail returns to flat and the retained revenue is exactly the three fees
    assertBookBalanced(all);
    assert.equal(reconcileRail(USDT0, all).owedToOtherRails.amount, 0n);
    assert.equal(reconcileRail(USDC, all).floatPosition.amount, 0n);
    assert.equal(reconcileRail(USDT0, all).floatPosition.amount, 170_000n, "0.10 + 0.05 + 0.02");
  });

  test("reconciliation is a pure projection — replaying the same groups gives the same answer", () => {
    // Restart safety: balances are always SUM(entries), never a stored column, so a process that
    // comes back up and re-reads the groups cannot disagree with the one that wrote them.
    const groups = crossRailIntent({
      intentId: "ci_restart",
      total: "20.50",
      fee: "0.30",
      spread: "0.10",
      providerCost: "20.00",
    });
    const first = reconcileRail(USDT0, groups);
    const replayed = reconcileRail(USDT0, [...groups].reverse());
    assert.deepEqual(replayed, first, "order of replay must not change any balance");
  });
});

describe("cross-rail — why the defect was invisible", () => {
  test("the pre-fix shape balances perfectly and still strands the value", () => {
    // #given the pre-fix shape: the remainder expensed on the funding rail as well
    const doubleExpensed: LedgerGroup[] = [
      fundingGroup({
        groupId: "f",
        intentId: "ci_bug",
        total: parseMoney("20.50", USDT0),
        treasuryRef: FUNDING_REF,
        createdAt: AT,
      }),
      settlementGroup({
        groupId: "s",
        intentId: "ci_bug",
        cost: parseMoney("20.00", USDC),
        providerId: "stabledomains",
        treasuryRef: SETTLEMENT_REF,
        createdAt: AT,
      }),
      recognitionGroup({
        groupId: "r",
        intentId: "ci_bug",
        total: parseMoney("20.50", USDT0),
        fee: parseMoney("0.30", USDT0),
        spread: parseMoney("0.10", USDT0),
        createdAt: AT, // no settlementAsset ⇒ the old same-rail assumption
      }),
      // ...then the operator tops the Base float back up, as they physically must.
      {
        groupId: "topup",
        kind: "ADJUSTMENT",
        intentId: null,
        asset: USDC,
        createdAt: AT,
        entries: [
          { accountId: treasuryAccount(USDC, SETTLEMENT_REF), amount: parseMoney("20.00", USDC), memo: "top-up" },
          { accountId: accountIdFor("COST_OF_GOODS", USDC, "ci_bug"), amount: money(-20_000_000n, USDC), memo: "?" },
        ],
      },
    ];

    // #then the book balances only because the top-up invented a second cost-of-goods account —
    // which is exactly how the double expense hid. The reconciliation names it.
    assertBookBalanced(doubleExpensed);
    const b = reconcileRail(USDC, doubleExpensed);
    assert.equal(b.floatPosition.amount, 0n, "the float LOOKS healthy...");
    assert.equal(b.unreimbursedCost.amount, 0n);
    const a = reconcileRail(USDT0, doubleExpensed);
    // ...while the funding rail has also expensed the same purchase, in a different currency,
    // and reports nothing to sweep — so the operator is never told to move the value.
    assert.equal(a.costOfGoods.amount, -20_100_000n);
    assert.equal(a.owedToOtherRails.amount, 0n, "the silent failure: no work queued, value stranded");
  });

  test("a fabricated imbalance is caught with the rail and residual named", () => {
    const broken: LedgerGroup[] = [
      fundingGroup({
        groupId: "f",
        intentId: "ci_z",
        total: parseMoney("1.00", USDT0),
        treasuryRef: FUNDING_REF,
        createdAt: AT,
      }),
    ];
    const tampered = [
      ...broken,
      { ...broken[0], groupId: "f2", entries: [broken[0].entries[0]] },
    ];
    assert.throws(() => assertBookBalanced(tampered), /does not balance/);
  });
});

describe("cross-rail — account identity", () => {
  test("the clearing account is per-rail and global, never per-intent", () => {
    // A per-intent clearing account could never be swept in one movement, and every intent would
    // leave its own dust behind.
    assert.equal(clearingAccount(USDT0), clearingAccount(USDT0));
    assert.notEqual(clearingAccount(USDT0), clearingAccount(USDC));
    assert.ok(clearingAccount(USDT0).startsWith("CROSS_RAIL_CLEARING:"));
  });

  test("balances on one rail are invisible to the other", () => {
    const groups = crossRailIntent({
      intentId: "ci_iso",
      total: "20.50",
      fee: "0.30",
      spread: "0.10",
      providerCost: "20.00",
    });
    assert.equal(balanceOf(groups, clearingAccount(USDC), USDC).amount, 0n);
    assert.equal(balanceOf(groups, clearingAccount(USDT0), USDT0).amount, -20_100_000n);
  });
});
