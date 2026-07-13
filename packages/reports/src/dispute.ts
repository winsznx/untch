import { hashCanonicalJson } from "@untch/canon";
import type { Hex } from "viem";
import type { EscalationRow, LedgerRow, ReceiptRow } from "./datasource";
import { DECISION_NA, decisionCategory, decisionName, verifyName } from "./codes";

/**
 * `generate_dispute_packet` assembly (§11, $0.50). Given ONE intent's durable history, assemble a
 * single evidence bundle from the four subsystems that already produced it:
 *   • the DECISION receipt      — the policy engine's terminal §7.1 outcome for the intent;
 *   • the VERIFY receipt(s)     — the proof engine's §7.3 delivery-verification result(s);
 *   • the escalation record(s)  — the escalation service's §7.2 resolution history for the intent;
 *   • every receipt's on-chain anchor (txHash/block) — the receipt writer's §7.4 anchored proof.
 * plus a timeline built from those rows' own timestamps.
 *
 * NO LLM anywhere (I1) — this is selection, arithmetic, and hashing over already-computed outputs.
 * HONESTY (hard rule): a section is present ONLY if its underlying rows exist. An intent with no
 * verify_delivery call yields `verification.present=false, results:[]` — never a fabricated tier
 * result. Sparse history produces a sparse packet, and `completeness.notes` says exactly what is
 * missing so a sparse packet is never mistaken for a complete one.
 */

/** Base-unit decimals used to render display amounts (the §9 / engine 6-decimal convention). Emitted
 *  on the packet so a reader knows how `amount` maps to a token amount without guessing. */
export const AMOUNT_DECIMALS = 6;

function toDisplay(baseUnits: string): string {
  const negative = baseUnits.startsWith("-");
  const digits = (negative ? baseUnits.slice(1) : baseUnits).padStart(AMOUNT_DECIMALS + 1, "0");
  const whole = digits.slice(0, digits.length - AMOUNT_DECIMALS);
  const frac = digits.slice(digits.length - AMOUNT_DECIMALS).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export interface DecisionSection {
  readonly present: boolean;
  readonly receiptId: Hex | null;
  readonly outcome: string | null;
  readonly category: string | null;
  readonly code: number | null;
  readonly amountBaseUnits: string | null;
  readonly amountDisplay: string | null;
  readonly token: string | null;
  readonly anchor: { txHash: Hex; blockNumber: number | null; batchId: number | null; status: string } | null;
  readonly recordedAt: string | null;
}

export interface VerifyResultEntry {
  readonly receiptId: Hex;
  readonly result: string;
  readonly resultCode: number;
  readonly proofTier: number;
  readonly provenance: "store-committed" | "caller-supplied" | null;
  readonly anchor: { txHash: Hex; blockNumber: number | null; status: string } | null;
  readonly recordedAt: string;
}

export interface EscalationEntry {
  readonly status: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly codeExpiresAt: string;
}

export interface TimelineEvent {
  readonly ts: string;
  readonly event: string;
  readonly ref: string;
}

export interface DisputePacket {
  readonly kind: "DISPUTE_PACKET";
  readonly version: 1;
  readonly intentHash: Hex;
  readonly subject: {
    readonly agentId: Hex | null;
    readonly vendorId: Hex | null;
    readonly policyId: string | null;
    readonly policyHash: Hex | null;
  };
  readonly decision: DecisionSection;
  readonly verification: { readonly present: boolean; readonly results: readonly VerifyResultEntry[] };
  readonly escalation: { readonly present: boolean; readonly records: readonly EscalationEntry[] };
  readonly receipts: readonly {
    readonly receiptId: Hex;
    readonly kind: "DECISION" | "VERIFY";
    readonly status: string;
    readonly anchored: boolean;
    readonly txHash: Hex | null;
    readonly blockNumber: number | null;
    readonly createdAt: string;
  }[];
  readonly ledger: readonly {
    readonly receiptId: Hex;
    readonly type: string;
    readonly amountBaseUnits: string;
    readonly amountDisplay: string;
    readonly token: string;
    readonly counterparty: string | null;
    readonly createdAt: string;
  }[];
  readonly timeline: readonly TimelineEvent[];
  readonly completeness: {
    readonly hasDecision: boolean;
    readonly hasVerification: boolean;
    readonly hasEscalation: boolean;
    readonly hasAnchoredReceipt: boolean;
    readonly receiptCount: number;
    readonly notes: readonly string[];
  };
  readonly amountDecimals: number;
  readonly assembledAt: string;
}

/** Pick the DECISION receipt (there is normally one per intent; the earliest wins if a retry created two). */
function pickDecision(receipts: readonly ReceiptRow[]): ReceiptRow | null {
  const decisions = receipts.filter((r) => r.kind === "DECISION" && r.decision !== DECISION_NA);
  return decisions[0] ?? null;
}

export interface AssembleDisputeOptions {
  /** ISO-8601 UTC assembly time — injected so the packet (and its hash) are deterministic in tests
   *  and reproducible for independent verification. */
  readonly assembledAt: string;
}

/**
 * Assemble the dispute packet for `intentHash` from its receipts / ledger / escalations. Rows are the
 * REAL durable rows; nothing is invented. Returns a packet whose sections reflect exactly what exists.
 */
export function assembleDisputePacket(
  intentHash: Hex,
  receipts: readonly ReceiptRow[],
  ledger: readonly LedgerRow[],
  escalations: readonly EscalationRow[],
  opts: AssembleDisputeOptions,
): DisputePacket {
  const ordered = [...receipts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const decisionRow = pickDecision(ordered);
  const verifyRows = ordered.filter((r) => r.kind === "VERIFY");

  const anyReceipt = ordered[0] ?? null;
  const subject = {
    agentId: (decisionRow ?? anyReceipt)?.agentId ?? null,
    vendorId: (decisionRow ?? anyReceipt)?.vendorId ?? null,
    policyId: (decisionRow ?? anyReceipt)?.policyId ?? null,
    policyHash: (decisionRow ?? anyReceipt)?.policyHash ?? null,
  };

  const decision: DecisionSection = decisionRow
    ? {
        present: true,
        receiptId: decisionRow.receiptId,
        outcome: decisionName(decisionRow.decision),
        category: decisionCategory(decisionRow.decision),
        code: decisionRow.decision,
        amountBaseUnits: decisionRow.amount,
        amountDisplay: toDisplay(decisionRow.amount),
        token: decisionRow.token,
        anchor: decisionRow.txHash
          ? {
              txHash: decisionRow.txHash,
              blockNumber: decisionRow.blockNumber,
              batchId: decisionRow.batchId,
              status: decisionRow.status,
            }
          : null,
        recordedAt: decisionRow.createdAt,
      }
    : {
        present: false,
        receiptId: null,
        outcome: null,
        category: null,
        code: null,
        amountBaseUnits: null,
        amountDisplay: null,
        token: null,
        anchor: null,
        recordedAt: null,
      };

  const verifyResults: VerifyResultEntry[] = verifyRows.map((r) => ({
    receiptId: r.receiptId,
    result: verifyName(r.verifyResult),
    resultCode: r.verifyResult,
    proofTier: r.proofTier,
    provenance: r.provenance,
    anchor: r.txHash ? { txHash: r.txHash, blockNumber: r.blockNumber, status: r.status } : null,
    recordedAt: r.createdAt,
  }));

  const escalationRecords: EscalationEntry[] = [...escalations]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((e) => ({
      status: e.status,
      createdAt: e.createdAt,
      resolvedAt: e.resolvedAt,
      codeExpiresAt: e.codeExpiresAt,
    }));

  const receiptSummaries = ordered.map((r) => ({
    receiptId: r.receiptId,
    kind: r.kind,
    status: r.status,
    anchored: r.txHash !== null,
    txHash: r.txHash,
    blockNumber: r.blockNumber,
    createdAt: r.createdAt,
  }));

  const ledgerSummaries = [...ledger]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((l) => ({
      receiptId: l.receiptId,
      type: l.type,
      amountBaseUnits: l.amount,
      amountDisplay: toDisplay(l.amount),
      token: l.token,
      counterparty: l.counterparty,
      createdAt: l.createdAt,
    }));

  const timeline = buildTimeline(decisionRow, verifyRows, escalationRecords);

  const hasAnchoredReceipt = ordered.some((r) => r.txHash !== null);
  const notes: string[] = [];
  if (!decisionRow) {
    notes.push(
      "No DECISION receipt found for this intent — the policy engine has no recorded preflight outcome for it in durable history.",
    );
  }
  if (verifyRows.length === 0) {
    notes.push(
      "No verify_delivery call was made for this intent — there are no proof-tier results to include (none are fabricated).",
    );
  }
  if (escalationRecords.length === 0) {
    notes.push("No escalation was raised for this intent.");
  }
  if (!hasAnchoredReceipt && ordered.length > 0) {
    notes.push(
      "This intent's receipt(s) are recorded but not yet anchored on-chain (QUEUED/BATCHED) — the anchor tx is pending.",
    );
  }
  if (ordered.length === 0) {
    notes.push(
      "No receipts, ledger entries, or escalations exist for this intent — the packet is an honest record that no history was found.",
    );
  }
  notes.push(
    "The granular per-rule §8.2 decision trace is returned live by preflight_payment and is NOT part of durable receipt history in this build; the packet records the terminal decision outcome, not a reconstructed rule ladder.",
  );

  return {
    kind: "DISPUTE_PACKET",
    version: 1,
    intentHash,
    subject,
    decision,
    verification: { present: verifyRows.length > 0, results: verifyResults },
    escalation: { present: escalationRecords.length > 0, records: escalationRecords },
    receipts: receiptSummaries,
    ledger: ledgerSummaries,
    timeline,
    completeness: {
      hasDecision: decisionRow !== null,
      hasVerification: verifyRows.length > 0,
      hasEscalation: escalationRecords.length > 0,
      hasAnchoredReceipt,
      receiptCount: ordered.length,
      notes,
    },
    amountDecimals: AMOUNT_DECIMALS,
    assembledAt: opts.assembledAt,
  };
}

function buildTimeline(
  decisionRow: ReceiptRow | null,
  verifyRows: readonly ReceiptRow[],
  escalations: readonly EscalationEntry[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (decisionRow) {
    events.push({ ts: decisionRow.createdAt, event: `DECISION ${decisionName(decisionRow.decision) ?? decisionRow.decision}`, ref: decisionRow.receiptId });
  }
  for (const v of verifyRows) {
    events.push({ ts: v.createdAt, event: `VERIFY ${verifyName(v.verifyResult)} (T${v.proofTier})`, ref: v.receiptId });
  }
  for (const e of escalations) {
    events.push({ ts: e.createdAt, event: `ESCALATION_CREATED ${e.status}`, ref: "escalation" });
    if (e.resolvedAt) {
      events.push({ ts: e.resolvedAt, event: `ESCALATION_RESOLVED ${e.status}`, ref: "escalation" });
    }
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Deterministic RFC 8785 JCS keccak of the packet — the `reportHash` anchored via AuditAnchored. */
export function hashDisputePacket(packet: DisputePacket): Hex {
  return hashCanonicalJson(packet as unknown as Record<string, unknown>);
}
