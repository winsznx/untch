import { hashCanonicalJson } from "@untch/canon";
import type { Hex } from "viem";
import type { EscalationRow, LedgerRow, ReceiptRow } from "./datasource";
import type { Period } from "./period";
import {
  BLOCKED_CODES,
  ESCALATED_CODES,
  decisionName,
  verifyName,
  VERIFY_PASS,
  VERIFY_FAIL,
  VERIFY_SKIPPED,
  VERIFY_NOT_IMPLEMENTED,
} from "./codes";
import { AMOUNT_DECIMALS } from "./dispute";

/**
 * `reconcile_agent_spend` assembly (§11, $0.25/day · $1.00/wk). Over one agent's durable history in a
 * period, assemble:
 *   • spend totals        — money that actually moved (ledger SPEND rows, per token);
 *   • blocked-waste totals — money that would have moved but was blocked (BLOCKED_* DECISION receipts);
 *   • escalated exposure   — money held for operator decision (ESCALATED_* receipts), reported SEPARATELY
 *                            from waste because an escalation may still be approved (not yet waste);
 *   • a decision-outcome breakdown, the escalation resolution history, verification outcomes, and the
 *     receipt anchoring status.
 *
 * NO LLM (I1) — grouping, summation, counting, hashing. HONESTY: an agent with no history in the period
 * yields all-zero totals and `completeness.notes` saying so — never padded to look active.
 */

function toDisplay(baseUnits: string): string {
  const negative = baseUnits.startsWith("-");
  const digits = (negative ? baseUnits.slice(1) : baseUnits).padStart(AMOUNT_DECIMALS + 1, "0");
  const whole = digits.slice(0, digits.length - AMOUNT_DECIMALS);
  const frac = digits.slice(digits.length - AMOUNT_DECIMALS).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export interface TokenTotal {
  readonly token: string;
  readonly count: number;
  readonly totalBaseUnits: string;
  readonly totalDisplay: string;
}

export interface ReconcileReport {
  readonly kind: "RECONCILE";
  readonly version: 1;
  readonly agentId: Hex;
  readonly period: {
    readonly kind: string;
    readonly label: string;
    readonly fromIso: string;
    readonly toIso: string;
    readonly periodCode: string;
  };
  readonly spend: { readonly approvedCount: number; readonly totals: readonly TokenTotal[] };
  readonly blockedWaste: { readonly blockedCount: number; readonly totals: readonly TokenTotal[] };
  readonly escalatedExposure: { readonly escalatedCount: number; readonly totals: readonly TokenTotal[] };
  readonly decisionBreakdown: readonly { readonly outcome: string; readonly count: number }[];
  readonly escalations: {
    readonly total: number;
    readonly byResolution: readonly { readonly status: string; readonly count: number }[];
  };
  readonly verifications: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly notImplemented: number;
    readonly other: number;
  };
  readonly receipts: {
    readonly total: number;
    readonly anchored: number;
    readonly unanchored: number;
    readonly decisionCount: number;
    readonly verifyCount: number;
  };
  readonly completeness: { readonly notes: readonly string[] };
  readonly amountDecimals: number;
  readonly assembledAt: string;
}

/** Group base-unit string amounts by token, summing with bigint precision. */
function sumByToken(rows: readonly { token: string; amount: string }[]): TokenTotal[] {
  const acc = new Map<string, { count: number; total: bigint }>();
  for (const r of rows) {
    const cur = acc.get(r.token) ?? { count: 0, total: 0n };
    cur.count += 1;
    cur.total += BigInt(r.amount);
    acc.set(r.token, cur);
  }
  return [...acc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([token, v]) => ({
      token,
      count: v.count,
      totalBaseUnits: v.total.toString(),
      totalDisplay: toDisplay(v.total.toString()),
    }));
}

export interface AssembleReconcileOptions {
  readonly assembledAt: string;
}

export function assembleReconcileReport(
  agentId: Hex,
  period: Period,
  receipts: readonly ReceiptRow[],
  ledger: readonly LedgerRow[],
  escalations: readonly EscalationRow[],
  opts: AssembleReconcileOptions,
): ReconcileReport {
  const decisionReceipts = receipts.filter((r) => r.kind === "DECISION");
  const verifyReceipts = receipts.filter((r) => r.kind === "VERIFY");

  const spendRows = ledger.filter((l) => l.type === "SPEND").map((l) => ({ token: l.token, amount: l.amount }));
  const blockedRows = decisionReceipts
    .filter((r) => BLOCKED_CODES.has(r.decision))
    .map((r) => ({ token: r.token, amount: r.amount }));
  const escalatedRows = decisionReceipts
    .filter((r) => ESCALATED_CODES.has(r.decision))
    .map((r) => ({ token: r.token, amount: r.amount }));

  const spendTotals = sumByToken(spendRows);
  const blockedTotals = sumByToken(blockedRows);
  const escalatedTotals = sumByToken(escalatedRows);

  const breakdownAcc = new Map<string, number>();
  for (const r of decisionReceipts) {
    const name = decisionName(r.decision) ?? `UNKNOWN_${r.decision}`;
    breakdownAcc.set(name, (breakdownAcc.get(name) ?? 0) + 1);
  }
  const decisionBreakdown = [...breakdownAcc.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([outcome, count]) => ({ outcome, count }));

  const resolutionAcc = new Map<string, number>();
  for (const e of escalations) {
    resolutionAcc.set(e.status, (resolutionAcc.get(e.status) ?? 0) + 1);
  }
  const byResolution = [...resolutionAcc.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([status, count]) => ({ status, count }));

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let notImplemented = 0;
  let other = 0;
  for (const v of verifyReceipts) {
    if (v.verifyResult === VERIFY_PASS) passed += 1;
    else if (v.verifyResult === VERIFY_FAIL) failed += 1;
    else if (v.verifyResult === VERIFY_SKIPPED) skipped += 1;
    else if (v.verifyResult === VERIFY_NOT_IMPLEMENTED) notImplemented += 1;
    else other += 1;
  }

  const anchored = receipts.filter((r) => r.txHash !== null).length;

  const notes: string[] = [];
  if (receipts.length === 0) {
    notes.push(
      `No receipts for agent ${agentId} in ${period.label} — all totals are zero. This is an honest empty report, not an inactive-agent placeholder.`,
    );
  }
  if (spendTotals.length === 0 && receipts.length > 0) {
    notes.push("No APPROVED spend in this period — the agent's activity was entirely blocked/escalated.");
  }
  if (escalatedTotals.length > 0) {
    notes.push(
      "`escalatedExposure` is money HELD for operator decision, reported separately from `blockedWaste` because an escalation may still be approved — it is not counted as saved waste.",
    );
  }
  if (anchored < receipts.length) {
    notes.push(
      `${receipts.length - anchored} of ${receipts.length} receipt(s) are not yet anchored on-chain (QUEUED/BATCHED); their ledger effect is still durable and authoritative (§7.4).`,
    );
  }
  notes.push(
    "`blockedWaste` sums the intent maxAmount of BLOCKED_* decisions — the spend that was prevented, i.e. an upper bound on what those attempts would have cost, not a realized loss.",
  );

  return {
    kind: "RECONCILE",
    version: 1,
    agentId,
    period: {
      kind: period.kind,
      label: period.label,
      fromIso: period.fromIso,
      toIso: period.toIso,
      periodCode: period.periodCode.toString(),
    },
    spend: { approvedCount: spendRows.length, totals: spendTotals },
    blockedWaste: { blockedCount: blockedRows.length, totals: blockedTotals },
    escalatedExposure: { escalatedCount: escalatedRows.length, totals: escalatedTotals },
    decisionBreakdown,
    escalations: { total: escalations.length, byResolution },
    verifications: {
      total: verifyReceipts.length,
      passed,
      failed,
      skipped,
      notImplemented,
      other,
    },
    receipts: {
      total: receipts.length,
      anchored,
      unanchored: receipts.length - anchored,
      decisionCount: decisionReceipts.length,
      verifyCount: verifyReceipts.length,
    },
    completeness: { notes },
    amountDecimals: AMOUNT_DECIMALS,
    assembledAt: opts.assembledAt,
  };
}

/** Deterministic RFC 8785 JCS keccak of the report — the `reportHash` anchored via AuditAnchored. */
export function hashReconcileReport(report: ReconcileReport): Hex {
  return hashCanonicalJson(report as unknown as Record<string, unknown>);
}

/** Verify-outcome name helper re-exported for callers assembling human summaries. */
export { verifyName };
