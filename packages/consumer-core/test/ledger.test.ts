import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  LedgerAssetMixError,
  LedgerImbalanceError,
  applyBasisPoints,
  asset,
  assertGroupBalanced,
  assertIntentSettled,
  formatMoney,
  fundingGroup,
  money,
  parseMoney,
  projectBalances,
  recognitionGroup,
  refundGroup,
  settlementGroup,
  suspenseGroup,
  treasuryAccount,
  userObligationAccount,
  zeroMoney,
  type LedgerGroup,
} from "../src/index";

const USDT0 = asset("xlayer.usdt0");
const USDC = asset("base.usdc");
const AT = "2026-07-27T12:00:00.000Z";

describe("ledger — every group balances within one asset", () => {
  test("funding: treasury debit equals the obligation credit", () => {
    const g = fundingGroup({
      groupId: "g1",
      intentId: "ci_1",
      total: parseMoney("20.50", USDT0),
      treasuryRef: "xlayer-usdt0-funding",
      createdAt: AT,
    });
    assertGroupBalanced(g);
    const balances = projectBalances([g]);
    assert.equal(balances.get(treasuryAccount(USDT0, "xlayer-usdt0-funding"))?.amount, 20_500_000n);
    assert.equal(balances.get(userObligationAccount(USDT0, "ci_1"))?.amount, -20_500_000n);
  });

  test("settlement: the provider expense equals the float credit", () => {
    const g = settlementGroup({
      groupId: "g2",
      intentId: "ci_1",
      cost: parseMoney("20.00", USDC),
      providerId: "stabledomains",
      treasuryRef: "base-usdc-settlement",
      createdAt: AT,
    });
    assertGroupBalanced(g);
  });

  test("recognition: fee + spread + cost of goods exactly discharge the obligation", () => {
    const total = parseMoney("20.50", USDT0);
    const fee = parseMoney("0.30", USDT0);
    const spread = parseMoney("0.10", USDT0);
    const g = recognitionGroup({ groupId: "g3", intentId: "ci_1", total, fee, spread, createdAt: AT });
    assertGroupBalanced(g);
    // Cost of goods is COMPUTED, never supplied: 20.50 − 0.30 − 0.10 = 20.10.
    const cog = g.entries.find((e) => e.accountId.startsWith("COST_OF_GOODS"));
    assert.ok(cog);
    assert.equal(formatMoney(money(-cog.amount.amount, USDT0)), "20.100000");
  });

  test("recognition keeps explicit ZERO rows for a zero fee and a zero spread", () => {
    // An absent row and a zero row read very differently in an audit. "We charged nothing" should be
    // visible, not inferred from a missing line.
    const g = recognitionGroup({
      groupId: "g4",
      intentId: "ci_2",
      total: parseMoney("5.00", USDT0),
      fee: zeroMoney(USDT0),
      spread: zeroMoney(USDT0),
      createdAt: AT,
    });
    assert.equal(g.entries.length, 4);
    assert.ok(g.entries.some((e) => e.accountId.startsWith("FEE_REVENUE") && e.amount.amount === 0n));
    assert.ok(g.entries.some((e) => e.accountId.startsWith("SPREAD_REVENUE") && e.amount.amount === 0n));
  });

  test("recognition refuses a fee+spread that exceeds the total", () => {
    assert.throws(
      () =>
        recognitionGroup({
          groupId: "g5",
          intentId: "ci_3",
          total: parseMoney("1.00", USDT0),
          fee: parseMoney("0.80", USDT0),
          spread: parseMoney("0.50", USDT0),
          createdAt: AT,
        }),
      /negative cost of goods/,
    );
  });

  test("recognition refuses a fee denominated in a different asset", () => {
    assert.throws(
      () =>
        recognitionGroup({
          groupId: "g6",
          intentId: "ci_4",
          total: parseMoney("10.00", USDT0),
          fee: parseMoney("0.20", USDC),
          spread: zeroMoney(USDT0),
          createdAt: AT,
        }),
      LedgerAssetMixError,
    );
  });
});

describe("ledger — the guards", () => {
  test("an unbalanced group is rejected with its residual named", () => {
    const bad: LedgerGroup = {
      groupId: "bad",
      kind: "ADJUSTMENT",
      intentId: "ci_x",
      asset: USDT0,
      createdAt: AT,
      entries: [
        { accountId: "TREASURY:a", amount: parseMoney("5.00", USDT0), memo: "in" },
        { accountId: "USER_OBLIGATION:b", amount: money(-4_000_000n, USDT0), memo: "out" },
      ],
    };
    assert.throws(() => assertGroupBalanced(bad), LedgerImbalanceError);
  });

  test("a group mixing two assets is rejected — a cross-rail move is TWO groups, never one", () => {
    const mixed: LedgerGroup = {
      groupId: "mixed",
      kind: "ADJUSTMENT",
      intentId: "ci_x",
      asset: USDT0,
      createdAt: AT,
      entries: [
        { accountId: "TREASURY:a", amount: parseMoney("5.00", USDT0), memo: "in" },
        { accountId: "TREASURY:b", amount: money(-5_000_000n, USDC), memo: "out on another chain" },
      ],
    };
    assert.throws(() => assertGroupBalanced(mixed), LedgerAssetMixError);
  });

  test("an empty group is rejected", () => {
    assert.throws(
      () =>
        assertGroupBalanced({
          groupId: "empty",
          kind: "ADJUSTMENT",
          intentId: "ci_x",
          asset: USDT0,
          createdAt: AT,
          entries: [],
        }),
      LedgerImbalanceError,
    );
  });
});

describe("ledger — the completed-intent invariant", () => {
  test("a fully recognised intent has a ZERO user obligation", () => {
    const total = parseMoney("20.50", USDT0);
    const fee = applyBasisPoints(total, 150, "CEIL");
    const spread = applyBasisPoints(total, 50, "CEIL");
    const groups = [
      fundingGroup({ groupId: "f", intentId: "ci_9", total, treasuryRef: "t", createdAt: AT }),
      recognitionGroup({ groupId: "r", intentId: "ci_9", total, fee, spread, createdAt: AT }),
    ];
    assertIntentSettled("ci_9", USDT0, groups);
  });

  test("an intent funded but never recognised FAILS the settled check", () => {
    const groups = [
      fundingGroup({
        groupId: "f",
        intentId: "ci_10",
        total: parseMoney("20.50", USDT0),
        treasuryRef: "t",
        createdAt: AT,
      }),
    ];
    assert.throws(() => assertIntentSettled("ci_10", USDT0, groups), /not zero/);
  });

  test("a refunded intent also lands on a zero obligation", () => {
    const total = parseMoney("7.25", USDT0);
    const groups = [
      fundingGroup({ groupId: "f", intentId: "ci_11", total, treasuryRef: "t", createdAt: AT }),
      refundGroup({ groupId: "rf", intentId: "ci_11", amount: total, createdAt: AT }),
    ];
    assertIntentSettled("ci_11", USDT0, groups);
  });

  test("a suspended (manual-review) intent also lands on a zero obligation", () => {
    const total = parseMoney("7.25", USDT0);
    const groups = [
      fundingGroup({ groupId: "f", intentId: "ci_12", total, treasuryRef: "t", createdAt: AT }),
      suspenseGroup({ groupId: "s", intentId: "ci_12", amount: total, createdAt: AT }),
    ];
    // The money is parked, not lost — the obligation moved to SUSPENSE, which is where a human
    // finds it.
    assertIntentSettled("ci_12", USDT0, groups);
    const balances = projectBalances(groups);
    assert.equal(balances.get(`SUSPENSE:${USDT0.chain}|${(USDT0.address ?? "").toLowerCase()}:ci_12`)?.amount, -7_250_000n);
  });
});
