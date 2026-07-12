import type { Hex } from "viem";
import type { PolicyRules } from "@untch/policy-engine";
import type { ReceiptRow, LedgerRow } from "@untch/reports";
import {
  assembleReconcileReport,
  assembleDisputePacket,
  decisionName,
  decisionCategory,
  parsePeriod,
  type ReconcileReport,
  type DisputePacket,
} from "@untch/reports";
import { scoreVendor, scoreBuyer, type ScoreResult } from "@untch/trust-bureau";
import type { EscalationRecord } from "@untch/escalation";
import {
  getPool,
  ownerAgents,
  policyRepo,
  reportSource,
  escalationRepo,
  scoreSource,
  READ_WINDOW_FROM,
  readWindowTo,
} from "./db";

/**
 * The dashboard's REAL, wallet-scoped reads over the shared production Postgres. Every function here takes
 * the signed-in operator's address (from getScope) and returns only that operator's data — the SAME rows
 * the seller wrote via preflight_payment / create_spend_policy / the escalation service / the Bureau. No
 * DATABASE_URL (local/CI) ⇒ every read is an honest empty result, never a throw and never a global read.
 *
 * Honesty note carried into the views: a DECISION receipt durably records the OUTCOME (decision, amount,
 * vendor, anchor tx) — not the transient preflight inputs (endpoint, plaintext category, full rule trace).
 * So the live intent stream is decision-level, and its rows say so rather than fabricating a trace.
 */

const dec6 = (base: string): number => Number(base) / 1_000_000;
const shortHex = (h: string): string => `${h.slice(0, 10)}…${h.slice(-6)}`;

/**
 * Defense-in-depth for reads over a shared DB this app does not own the schema of: a query failure (schema
 * drift, transient outage) degrades to the empty/fallback value with a logged reason, never a 500 that takes
 * the whole page down. The scoping is still enforced — a failure just yields nothing, never another wallet's
 * data.
 */
async function guard<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[untch] dashboard read "${label}" failed:`, e instanceof Error ? e.message : e);
    return fallback;
  }
}

// ── Policies (§15 #2 read) ────────────────────────────────────────────────────────────────────────
export interface PolicyView {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly policyHash: Hex;
  readonly agentId: Hex;
  readonly rules: PolicyRules;
  readonly rulesJson: string;
  readonly registerTx: Hex;
  readonly updatedAt: string;
}

export async function livePolicies(owner: string | null): Promise<PolicyView[]> {
  const pool = getPool();
  if (!pool || !owner) return [];
  return guard("policies", async () => {
  const stored = await policyRepo(pool).listByOwner(owner);
  return stored.map((p) => ({
    id: p.id,
    version: p.version,
    status: p.status,
    policyHash: p.policyHash,
    agentId: p.agentId,
    rules: p.rules,
    rulesJson: JSON.stringify(p.rules, null, 2),
    registerTx: p.onchainRef.registerTx,
    updatedAt: p.updatedAt,
  }));
  }, []);
}

// ── Intent stream (§15 #3 read) — decision-level, from DECISION receipts ───────────────────────────
export interface IntentRow {
  readonly id: string;
  readonly intentHash: Hex;
  readonly createdAt: string;
  readonly vendorId: Hex;
  readonly amount: number;
  readonly token: string;
  readonly outcome: string;
  readonly decisionCategory: "APPROVED" | "BLOCKED" | "ESCALATED" | "REJECTED";
  readonly anchored: boolean;
  readonly txHash: Hex | null;
}

function categoryOf(code: number): IntentRow["decisionCategory"] {
  const c = decisionCategory(code);
  if (c === "APPROVED" || c === "BLOCKED" || c === "ESCALATED" || c === "REJECTED") return c;
  return "BLOCKED";
}

async function decisionReceipts(owner: string | null): Promise<ReceiptRow[]> {
  const pool = getPool();
  if (!pool || !owner) return [];
  return guard("receipts", async () => {
    const agents = await ownerAgents(pool, owner);
    const src = reportSource(pool);
    const to = readWindowTo();
    const all: ReceiptRow[] = [];
    for (const agent of agents) {
      const rows = await src.receiptsForAgentPeriod(agent, READ_WINDOW_FROM, to);
      all.push(...rows);
    }
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, []);
}

export async function liveIntentStream(owner: string | null): Promise<IntentRow[]> {
  const receipts = await decisionReceipts(owner);
  return receipts
    .filter((r) => r.kind === "DECISION")
    .map((r) => ({
      id: r.intentHash.slice(0, 10),
      intentHash: r.intentHash,
      createdAt: r.createdAt,
      vendorId: r.vendorId,
      amount: dec6(r.amount),
      token: r.token,
      outcome: decisionName(r.decision) ?? `CODE_${r.decision}`,
      decisionCategory: categoryOf(r.decision),
      anchored: r.status === "CONFIRMED",
      txHash: r.txHash,
    }));
}

// ── Ledger explorer (§15 #5 read) ──────────────────────────────────────────────────────────────────
export interface LedgerEntry {
  readonly receiptId: string;
  readonly type: string;
  readonly amount: number;
  readonly token: string;
  readonly counterparty: string;
  readonly vendor: string;
  readonly category: string;
  readonly createdAt: string;
  readonly txHash: Hex | null;
  readonly anchored: boolean;
}

async function ledgerAndReceipts(owner: string | null): Promise<{ ledger: LedgerRow[]; receipts: ReceiptRow[] }> {
  const pool = getPool();
  if (!pool || !owner) return { ledger: [], receipts: [] };
  return guard("ledger", async () => {
    const agents = await ownerAgents(pool, owner);
    const src = reportSource(pool);
    const to = readWindowTo();
    const ledger: LedgerRow[] = [];
    const receipts: ReceiptRow[] = [];
    for (const agent of agents) {
      ledger.push(...(await src.ledgerForAgentPeriod(agent, READ_WINDOW_FROM, to)));
      receipts.push(...(await src.receiptsForAgentPeriod(agent, READ_WINDOW_FROM, to)));
    }
    return { ledger, receipts };
  }, { ledger: [], receipts: [] });
}

export async function liveLedger(owner: string | null): Promise<LedgerEntry[]> {
  const { ledger, receipts } = await ledgerAndReceipts(owner);
  const receiptById = new Map(receipts.map((r) => [r.receiptId.toLowerCase(), r]));
  return ledger
    .map((l) => {
      const r = receiptById.get(l.receiptId.toLowerCase());
      return {
        receiptId: l.receiptId,
        type: l.type,
        amount: dec6(l.amount),
        token: l.token,
        counterparty: l.counterparty ?? "",
        vendor: l.vendorKey ?? "",
        category: l.categoryKey ?? "",
        createdAt: l.createdAt,
        txHash: r?.txHash ?? null,
        anchored: r?.status === "CONFIRMED",
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── Savings (derived from the operator's real ledger) ──────────────────────────────────────────────
export interface SavingsSummary {
  readonly token: string;
  readonly dailyBudget: number;
  readonly spent: number;
  readonly blockedWaste: number;
  readonly escalatedExposure: number;
  readonly approvedCount: number;
  readonly blockedCount: number;
  readonly escalatedCount: number;
}

export async function liveSavings(owner: string | null): Promise<SavingsSummary> {
  const receipts = (await decisionReceipts(owner)).filter((r) => r.kind === "DECISION");
  let spent = 0, blockedWaste = 0, escalatedExposure = 0, approvedCount = 0, blockedCount = 0, escalatedCount = 0;
  let token = "USDT";
  for (const r of receipts) {
    token = r.token || token;
    const cat = categoryOf(r.decision);
    const amt = dec6(r.amount);
    if (cat === "APPROVED") { spent += amt; approvedCount++; }
    else if (cat === "ESCALATED") { escalatedExposure += amt; escalatedCount++; }
    else { blockedWaste += amt; blockedCount++; }
  }
  // The budget meter reads the operator's real policies (sum of active daily budgets).
  const policies = await livePolicies(owner);
  const dailyBudget = policies
    .filter((p) => p.status === "ACTIVE")
    .reduce((sum, p) => sum + (p.rules.budgets?.daily ?? 0), 0);
  return { token, dailyBudget, spent, blockedWaste, escalatedExposure, approvedCount, blockedCount, escalatedCount };
}

// ── Escalation inbox (§15 #4 read) — scoped by the owner's intents ─────────────────────────────────
export interface EscalationView {
  readonly id: string;
  readonly intentHash: string;
  readonly amount: number;
  readonly token: string;
  readonly reason: string;
  readonly status: EscalationRecord["status"];
  readonly channels: readonly string[];
  readonly dualChannelAbove: number | null;
  readonly channelCaps: Readonly<Record<string, number>>;
  readonly resolvedBy: EscalationRecord["resolvedBy"];
  readonly resolvedAt: string | null;
  readonly approvedChannels: readonly string[];
}

export async function liveEscalations(owner: string | null): Promise<EscalationView[]> {
  const pool = getPool();
  if (!pool || !owner) return [];
  const intentIds = [...new Set((await decisionReceipts(owner)).map((r) => r.intentHash.toLowerCase()))];
  if (intentIds.length === 0) return [];
  return guard("escalations", async () => {
  const records = await escalationRepo(pool).listByIntentIds(intentIds);
  return records.map((e) => ({
    id: e.id,
    intentHash: e.intentId,
    amount: e.amount,
    token: e.token,
    reason: e.reason,
    status: e.status,
    channels: e.approvals.channels,
    dualChannelAbove: e.approvals.dualChannelAbove,
    channelCaps: e.approvals.channelCaps,
    resolvedBy: e.resolvedBy,
    resolvedAt: e.resolvedAt,
    approvedChannels: e.approvedChannels,
  }));
  }, []);
}

// ── Vendor + buyer scores (§15 read) — real @untch/trust-bureau over shared receipts ───────────────
export interface VendorView {
  readonly name: string;
  readonly vendorId: Hex;
  readonly category: string;
  readonly score: ScoreResult;
}

export async function liveVendors(owner: string | null): Promise<VendorView[]> {
  const pool = getPool();
  if (!pool || !owner) return [];
  const receipts = await decisionReceipts(owner);
  const vendorIds = [...new Set(receipts.map((r) => r.vendorId.toLowerCase()))] as Hex[];
  return guard("vendor-scores", async () => {
    const ds = scoreSource(pool);
    const out: VendorView[] = [];
    for (const vendorId of vendorIds) {
      const score = await scoreVendor(ds, vendorId, { walletProvider: null, persist: false });
      out.push({ name: shortHex(vendorId), vendorId, category: "", score });
    }
    return out;
  }, []);
}

export interface BuyerScoreView {
  readonly agentId: Hex;
  readonly score: ScoreResult;
}

export async function liveBuyerScores(owner: string | null): Promise<BuyerScoreView[]> {
  const pool = getPool();
  if (!pool || !owner) return [];
  return guard("buyer-scores", async () => {
    const agents = await ownerAgents(pool, owner);
    const ds = scoreSource(pool);
    const out: BuyerScoreView[] = [];
    for (const agentId of agents) {
      const score = await scoreBuyer(ds, agentId, { persist: false });
      out.push({ agentId, score });
    }
    return out;
  }, []);
}

// ── Reports: reconcile + dispute (§11 read) — reuse the assemble tools over the shared history ──────
async function primaryAgent(owner: string | null): Promise<Hex | null> {
  const pool = getPool();
  if (!pool || !owner) return null;
  const agents = await ownerAgents(pool, owner);
  return agents[0] ?? null;
}

export async function liveReconcile(owner: string | null): Promise<ReconcileReport | null> {
  const pool = getPool();
  const agent = await primaryAgent(owner);
  if (!pool || !agent) return null;
  return guard("reconcile", async () => {
  const src = reportSource(pool);
  const from = READ_WINDOW_FROM;
  const to = readWindowTo();
  const [receipts, ledger, escalations] = await Promise.all([
    src.receiptsForAgentPeriod(agent, from, to),
    src.ledgerForAgentPeriod(agent, from, to),
    src.escalationsForAgentPeriod(agent, from, to),
  ]);
  if (receipts.length === 0) return null;
  // A ReconcileReport is period-scoped by design (day/week). Reconcile the agent's most recent active
  // UTC day so the report is real and non-empty; filter each stream to that day to stay within the period.
  const day = receipts.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), receipts[0]!.createdAt).slice(0, 10);
  const onDay = <T extends { createdAt: string }>(rows: readonly T[]): T[] =>
    rows.filter((r) => r.createdAt.slice(0, 10) === day);
  return assembleReconcileReport(agent, parsePeriod(day), onDay(receipts), onDay(ledger), onDay(escalations), {
    assembledAt: new Date().toISOString(),
  });
  }, null);
}

export async function liveDispute(owner: string | null): Promise<DisputePacket | null> {
  const pool = getPool();
  if (!pool) return null;
  const receipts = await decisionReceipts(owner);
  const escalated = receipts.find((r) => categoryOf(r.decision) === "ESCALATED") ?? receipts[0];
  if (!escalated) return null;
  return guard("dispute", async () => {
    const src = reportSource(pool);
    const [rRows, lRows, eRows] = await Promise.all([
      src.receiptsForIntent(escalated.intentHash),
      src.ledgerForIntent(escalated.intentHash),
      src.escalationsForIntent(escalated.intentHash),
    ]);
    return assembleDisputePacket(escalated.intentHash, [...rRows], [...lRows], [...eRows], {
      assembledAt: new Date().toISOString(),
    });
  }, null);
}
