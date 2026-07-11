/**
 * Dashboard data layer.
 *
 * REAL ENGINES over a seeded in-memory dataset — the same posture the backend's own e2e proofs use.
 * Nothing here is hand-written fake output:
 *   - decisions + rule traces come from @untch/policy-engine `evaluateIntent`
 *   - the policy hash comes from @untch/canon `hashCanonicalJson`
 *   - vendor scores (incl. the observed-vs-cold-start-prior split) come from @untch/trust-bureau `scoreVendor`
 *   - verification + proof-tier outcomes come from @untch/proof-engine `verifyDelivery`
 *   - the reconcile report + dispute packet come from @untch/reports `assemble*`
 *
 * What is a seed vs what is real: the INPUT rows (intents, orders, receipts) are a seeded demo dataset
 * for a stand-in "demo operator" (no live wallet, DB, or chain writes — see OPERATOR.connected=false and
 * the master review doc). The OUTPUTS are computed live by the real deterministic engines every request.
 */
import {
  evaluateIntent,
  type Policy,
  type SpendIntentInput,
  type LedgerWindowState,
  type Decision,
  type RuleTraceEntry,
} from "@untch/policy-engine";
import { hashCanonicalJson } from "@untch/canon";
import { verifyDelivery } from "@untch/proof-engine";
import { scoreVendor, MemoryScoreDataSource, type ScoreResult } from "@untch/trust-bureau";
import {
  assembleReconcileReport,
  assembleDisputePacket,
  parsePeriod,
  type ReconcileReport,
  type DisputePacket,
  type ReceiptRow,
  type LedgerRow,
  type EscalationRow,
} from "@untch/reports";
import { decisionToUint8 } from "@untch/receipt-writer";

type Hex = `0x${string}`;
const h32 = (b: string): Hex => `0x${b.padStart(2, "0").repeat(32).slice(0, 64)}` as Hex;
const NOW = new Date("2026-07-11T12:00:00Z").getTime();
const iso = (offsetMin: number) => new Date(NOW - offsetMin * 60_000).toISOString();
const TOKEN = "USDT";
const base = (n: number) => String(Math.round(n * 1_000_000));

// ── Identity (stand-in) ────────────────────────────────────────────────────────────────────────
export type OperatorInfo = {
  id: string;
  label: string;
  wallet: Hex;
  agentId: Hex;
  agentLabel: string;
  mode: "ADVISORY" | "GUARDED" | "BROKERED" | "VAULT";
  connected: boolean;
};

const AGENT_ID = h32("2a");
export const OPERATOR: OperatorInfo = {
  id: "op_demo",
  label: "Demo operator",
  wallet: "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b",
  agentId: AGENT_ID,
  agentLabel: "agent-01",
  mode: "GUARDED",
  connected: false,
};

// ── Policy ───────────────────────────────────────────────────────────────────────────────────────
const RULES = {
  budgets: { daily: 25, token: TOKEN },
  perCallCap: 10.0,
  onPerCallCapExceeded: "BLOCK" as const,
  escalateAbove: 5.0,
  categories: { allow: ["market-data", "security", "research"], deny: [] as string[] },
  recipients: { allow: [] as Hex[], deny: [] as Hex[] },
  agents: { allowWorkerIds: [] as string[], denyWorkerIds: [] as string[] },
  duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
  cooldowns: { sameServiceMin: 5 },
  rateLimit: { callsPerHour: 40 },
  expiry: "2027-01-31T00:00:00Z",
};
const POLICY: Policy = { id: "12", version: 3, status: "ACTIVE", rules: RULES };
export const POLICY_HASH = hashCanonicalJson(RULES);

export type PolicyView = {
  id: string;
  version: number;
  status: string;
  policyHash: Hex;
  rules: typeof RULES;
  rulesJson: string;
};
export function getPolicy(): PolicyView {
  return {
    id: POLICY.id,
    version: POLICY.version,
    status: POLICY.status,
    policyHash: POLICY_HASH,
    rules: RULES,
    rulesJson: JSON.stringify(RULES, null, 2),
  };
}

// ── Vendors (real scores) ──────────────────────────────────────────────────────────────────────
const APPROVED_CODE = decisionToUint8("APPROVED");
type VendorSeed = { id: Hex; name: string; category: string; orders: number; passes: number; fails: number };
const VENDOR_SEEDS: VendorSeed[] = [
  { id: h32("a1"), name: "orbital-market-data", category: "market-data", orders: 40, passes: 20, fails: 0 },
  { id: h32("b2"), name: "sentinel-research", category: "research", orders: 12, passes: 7, fails: 1 },
  { id: h32("c3"), name: "newcomer-signals", category: "security", orders: 0, passes: 0, fails: 0 },
];

const scoreDs = new MemoryScoreDataSource();
for (const v of VENDOR_SEEDS) {
  for (let i = 0; i < v.orders; i++)
    scoreDs.addOrder({ intentHash: h32(`e${i}`), vendorId: v.id, agentId: AGENT_ID, decision: APPROVED_CODE, counterparty: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", createdAt: iso(60 * 24 * (i + 1)) });
  for (let i = 0; i < v.passes; i++)
    scoreDs.addVerify({ intentHash: h32(`e${i}`), vendorId: v.id, agentId: AGENT_ID, verifyResult: 1, provenance: "store-committed", createdAt: iso(60 * 24 * (i + 1)) });
  for (let i = 0; i < v.fails; i++)
    scoreDs.addVerify({ intentHash: h32(`f${i}`), vendorId: v.id, agentId: AGENT_ID, verifyResult: 2, provenance: "store-committed", createdAt: iso(60 * 24 * (i + 1)) });
}

export type VendorView = { name: string; category: string; score: ScoreResult };
let _vendors: VendorView[] | null = null;
export async function getVendors(): Promise<VendorView[]> {
  if (_vendors) return _vendors;
  _vendors = [];
  for (const v of VENDOR_SEEDS) {
    const score = await scoreVendor(scoreDs, v.id, { nowMs: () => NOW, walletProvider: null, persist: false });
    _vendors.push({ name: v.name, category: v.category, score });
  }
  return _vendors;
}

// ── Intent stream (real decisions) ───────────────────────────────────────────────────────────────
type Scenario = {
  amount: number;
  category: string;
  endpoint: string;
  vendor: string;
  ageMin: number;
  state: LedgerWindowState;
};
const emptyState = (): LedgerWindowState => ({ spentTodayByAgent: 0, recentIntents: [], lastCallByService: {}, callsInLastHour: 0 });

function buildIntent(i: number, s: Scenario): SpendIntentInput {
  return {
    owner: OPERATOR.wallet,
    buyerAgentId: 1n,
    workerAgentId: 0n,
    token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
    maxAmount: BigInt(base(s.amount)),
    taskHash: h32((10 + i).toString(16)),
    acceptanceHash: h32("aa"),
    schemaHash: h32("5c"),
    policyHash: POLICY_HASH,
    deadline: BigInt(Math.floor((NOW + 3_600_000) / 1000)),
    nonce: BigInt(i + 1),
    endpoint: s.endpoint,
    paramsHash: h32((20 + i).toString(16)),
    recipientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    category: s.category,
    amount: s.amount,
  };
}

const SCENARIOS: Scenario[] = [
  { amount: 0.05, category: "market-data", endpoint: "https://orbital.example/v1/quote?sym=okb", vendor: "orbital-market-data", ageMin: 4, state: emptyState() },
  { amount: 8.0, category: "research", endpoint: "https://sentinel.example/v1/deep-report", vendor: "sentinel-research", ageMin: 12, state: emptyState() },
  { amount: 0.2, category: "security", endpoint: "https://newcomer.example/v1/scan", vendor: "newcomer-signals", ageMin: 21, state: { spentTodayByAgent: 0, callsInLastHour: 1, lastCallByService: {}, recentIntents: [{ intentId: "pi_prior", taskHash: h32("0c"), endpoint: "https://newcomer.example/v1/scan", paramsHash: h32("16"), createdAtMs: NOW - 5 * 60_000 }] } },
  { amount: 3.0, category: "market-data", endpoint: "https://orbital.example/v1/history?sym=eth", vendor: "orbital-market-data", ageMin: 33, state: { spentTodayByAgent: 24, callsInLastHour: 3, lastCallByService: {}, recentIntents: [] } },
  { amount: 1.5, category: "trading", endpoint: "https://unknown.example/v1/execute", vendor: "unlisted", ageMin: 48, state: emptyState() },
  { amount: 0.1, category: "research", endpoint: "https://sentinel.example/v1/summary", vendor: "sentinel-research", ageMin: 62, state: emptyState() },
];

export type IntentRow = {
  id: string;
  intentHash: Hex;
  createdAt: string;
  vendor: string;
  endpoint: string;
  category: string;
  amount: number;
  token: string;
  outcome: string;
  decisionCategory: "APPROVED" | "BLOCKED" | "ESCALATED" | "REJECTED";
  reasons: readonly string[];
  rules: readonly RuleTraceEntry[];
};

function categoryOf(outcome: string): IntentRow["decisionCategory"] {
  if (outcome === "APPROVED") return "APPROVED";
  if (outcome.startsWith("ESCALATED")) return "ESCALATED";
  if (outcome.startsWith("REJECTED")) return "REJECTED";
  return "BLOCKED";
}

const STREAM: { intent: SpendIntentInput; decision: Decision; scenario: Scenario }[] = SCENARIOS.map((s, i) => {
  const intent = buildIntent(i, s);
  const decision = evaluateIntent(intent, POLICY, s.state, { now: () => NOW });
  return { intent, decision, scenario: s };
});

export function getIntentStream(): IntentRow[] {
  return STREAM.map(({ intent, decision, scenario }) => ({
    id: decision.intentHash.slice(0, 10),
    intentHash: decision.intentHash,
    createdAt: iso(scenario.ageMin),
    vendor: scenario.vendor,
    endpoint: scenario.endpoint,
    category: intent.category,
    amount: intent.amount,
    token: TOKEN,
    outcome: decision.decision,
    decisionCategory: categoryOf(decision.decision),
    reasons: decision.reasons,
    rules: decision.rules,
  }));
}

// ── Savings (derived from real decisions) ────────────────────────────────────────────────────────
export type SavingsSummary = {
  token: string;
  dailyBudget: number;
  spent: number;
  blockedWaste: number;
  escalatedExposure: number;
  approvedCount: number;
  blockedCount: number;
  escalatedCount: number;
};
export function getSavings(): SavingsSummary {
  let spent = 0, blockedWaste = 0, escalatedExposure = 0, approvedCount = 0, blockedCount = 0, escalatedCount = 0;
  for (const { intent, decision } of STREAM) {
    const cat = categoryOf(decision.decision);
    if (cat === "APPROVED") { spent += intent.amount; approvedCount++; }
    else if (cat === "BLOCKED") { blockedWaste += intent.amount; blockedCount++; }
    else if (cat === "ESCALATED") { escalatedExposure += intent.amount; escalatedCount++; }
  }
  return { token: TOKEN, dailyBudget: RULES.budgets.daily, spent, blockedWaste, escalatedExposure, approvedCount, blockedCount, escalatedCount };
}

// ── Proof-tier distribution (real verifyDelivery) ────────────────────────────────────────────────
export type ProofTierView = {
  finals: { label: string; count: number }[];
  ladder: { tier: string; implemented: boolean; note: string }[];
};
export function getProofTiers(): ProofTierView {
  const mk = (criteria: Record<string, unknown>, payload: unknown) => ({
    acceptanceHash: hashCanonicalJson(criteria),
    criteria,
    delivery: { payload },
  });
  const deliveries = [
    mk({ requiredFields: ["result"] }, { result: "ok" }),
    mk({ requiredFields: ["result", "source"] }, { result: "ok", source: "https://x" }),
    mk({ requiredFields: ["result", "url"] }, { result: "ok" }),
    { acceptanceHash: h32("00"), criteria: undefined, delivery: { payload: {} } },
  ];
  const counts: Record<string, number> = {};
  let ladder: ProofTierView["ladder"] = [];
  for (const d of deliveries) {
    const out = verifyDelivery({ intentHash: h32("de"), acceptanceHash: d.acceptanceHash, criteria: d.criteria, delivery: d.delivery });
    counts[out.final] = (counts[out.final] ?? 0) + 1;
    if (!ladder.length)
      ladder = out.tierResults.map((t) => ({ tier: t.tier, implemented: t.implemented !== false, note: t.note ?? "Live" }));
  }
  const label = (k: string) => ({ VERIFY_PASSED: "Passed", VERIFY_FAILED: "Failed", VERIFY_SKIPPED_UNCOMMITTED: "Skipped (no criteria)", VERIFY_TIER_NOT_IMPLEMENTED: "Tier not implemented" } as Record<string, string>)[k] ?? k;
  const finals = Object.entries(counts).map(([k, v]) => ({ label: label(k), count: v }));
  return { finals, ladder };
}

// ── Receipts / ledger / escalations (seed) → real reconcile + dispute ────────────────────────────
const REAL_TX: (Hex | null)[] = [
  "0x48d41b364ec1d78f1c118a64b44b7b456cb34a62b07a3d1617a21a959472e209",
  "0x84f1eded3f2b9e7ac5c003b60c87f505b146d2aaf9366b8b9c1d84b848c05700",
];

function receiptRows(): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  STREAM.forEach(({ intent, decision }, i) => {
    const anchored = i < 2;
    rows.push({
      receiptId: h32((100 + i).toString(16)),
      kind: "DECISION",
      status: anchored ? "CONFIRMED" : "QUEUED",
      intentHash: decision.intentHash,
      policyId: POLICY.id,
      policyHash: POLICY_HASH,
      agentId: AGENT_ID,
      vendorId: h32((0xa0 + i).toString(16)),
      amount: base(intent.amount),
      token: TOKEN,
      category: h32((0x30 + i).toString(16)),
      payType: 0,
      taskHash: intent.taskHash,
      decision: decisionToUint8(decision.decision),
      verifyResult: 0,
      proofTier: 0,
      metadataHash: h32("00"),
      provenance: "store-committed",
      batchId: anchored ? 7 : null,
      txHash: anchored ? REAL_TX[i]! : null,
      blockNumber: anchored ? 35295900 + i : null,
      createdAt: iso(SCENARIOS[i]!.ageMin),
    });
  });
  // one VERIFY receipt for the first approved intent
  rows.push({
    receiptId: h32("200"),
    kind: "VERIFY",
    status: "CONFIRMED",
    intentHash: STREAM[0]!.decision.intentHash,
    policyId: POLICY.id,
    policyHash: POLICY_HASH,
    agentId: AGENT_ID,
    vendorId: h32("a0"),
    amount: "0",
    token: TOKEN,
    category: h32("30"),
    payType: 0,
    taskHash: STREAM[0]!.intent.taskHash,
    decision: 0,
    verifyResult: 1,
    proofTier: 0,
    metadataHash: h32("00"),
    provenance: "store-committed",
    batchId: 7,
    txHash: REAL_TX[0]!,
    blockNumber: 35295905,
    createdAt: iso(2),
  });
  return rows;
}

function ledgerRows(): LedgerRow[] {
  return STREAM.map(({ intent, decision }, i) => {
    const cat = categoryOf(decision.decision);
    const type: LedgerRow["type"] = cat === "APPROVED" ? "SPEND" : cat === "BLOCKED" ? "BLOCK_SAVED" : "FEE_UNTCH";
    return {
      receiptId: h32((100 + i).toString(16)),
      agentId: AGENT_ID,
      type,
      amount: base(cat === "ESCALATED" ? 0 : intent.amount),
      token: TOKEN,
      counterparty: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      dayKey: "2026-07-11",
      categoryKey: intent.category,
      vendorKey: SCENARIOS[i]!.vendor,
      createdAt: iso(SCENARIOS[i]!.ageMin),
    };
  }).filter((r) => r.type !== "FEE_UNTCH");
}

function escalationRows(): EscalationRow[] {
  const esc = STREAM.find((s) => categoryOf(s.decision.decision) === "ESCALATED");
  if (!esc) return [];
  return [{ intentId: esc.decision.intentHash, status: "APPROVED", createdAt: iso(12), resolvedAt: iso(9), codeExpiresAt: iso(-18) }];
}

export function getReconcile(): ReconcileReport {
  return assembleReconcileReport(AGENT_ID, parsePeriod("2026-07-11"), receiptRows(), ledgerRows(), escalationRows(), {
    assembledAt: new Date(NOW).toISOString(),
  });
}

export function getDispute(): DisputePacket {
  const target = STREAM.find((s) => categoryOf(s.decision.decision) === "ESCALATED") ?? STREAM[0]!;
  const rows = receiptRows().filter((r) => r.intentHash === target.decision.intentHash);
  const led = ledgerRows().filter((r) => rows.some((rr) => rr.receiptId === r.receiptId));
  return assembleDisputePacket(target.decision.intentHash, rows, led, escalationRows(), {
    assembledAt: new Date(NOW).toISOString(),
  });
}

// ── Ledger explorer (derived from the same decisions) ────────────────────────────────────────────
export type LedgerEntry = {
  receiptId: string;
  type: string;
  amount: number;
  token: string;
  counterparty: string;
  vendor: string;
  category: string;
  createdAt: string;
  txHash: Hex | null;
  anchored: boolean;
};
export function getLedgerEntries(): LedgerEntry[] {
  const receipts = receiptRows();
  return ledgerRows().map((l, i) => {
    const receipt = receipts.find((r) => r.receiptId === l.receiptId);
    return {
      receiptId: l.receiptId,
      type: l.type,
      amount: Number(l.amount) / 1_000_000,
      token: l.token,
      counterparty: l.counterparty ?? "",
      vendor: l.vendorKey ?? "",
      category: l.categoryKey ?? "",
      createdAt: l.createdAt,
      txHash: receipt?.txHash ?? null,
      anchored: receipt?.status === "CONFIRMED",
    };
  });
}

// ── Escalation inbox (§15 #4) — SEED, real EscalationStatus + ApprovalsConfig shapes ──────────────
// The live escalation service (@untch/escalation) is not wired here: it depends on BullMQ + Redis
// (a running queue/timeout worker), which the dashboard has no live instance of. Shapes and status
// semantics are the package's real ones; the record is seeded. Flagged in the master review doc.
export type EscalationView = {
  id: string;
  intentHash: Hex;
  amount: number;
  token: string;
  vendor: string;
  reason: string;
  status: "PENDING" | "AWAITING_SECOND_CHANNEL" | "APPROVED" | "DENIED" | "EXPIRED" | "NOTIFY_FAILED";
  createdAt: string;
  timeoutAt: string;
  channels: string[];
  dualChannelAbove: number | null;
  channelCaps: Record<string, number>;
};
export function getEscalations(): EscalationView[] {
  const esc = STREAM.find((s) => categoryOf(s.decision.decision) === "ESCALATED");
  const approvals = { channels: ["imessage", "telegram", "dashboard"], dualChannelAbove: 50, channelCaps: { imessage: 25, telegram: 25 } };
  const list: EscalationView[] = [];
  if (esc)
    list.push({
      id: "esc_" + esc.decision.intentHash.slice(2, 8),
      intentHash: esc.decision.intentHash,
      amount: esc.intent.amount,
      token: TOKEN,
      vendor: "sentinel-research",
      reason: "amount above escalate threshold (5.00)",
      status: "PENDING",
      createdAt: iso(6),
      timeoutAt: iso(-24),
      channels: approvals.channels,
      dualChannelAbove: approvals.dualChannelAbove,
      channelCaps: approvals.channelCaps,
    });
  return list;
}

// ── Vault panel (§15 #6) — REAL deployed testnet addresses/txs + seeded caps ──────────────────────
// Reads are real on-chain artifacts; the epoch gauge / caps are seeded and writes need a live wallet.
export type VaultView = {
  address: Hex;
  factory: Hex;
  token: Hex;
  oracle: Hex;
  paused: boolean;
  perTxCap: number;
  epochBudget: number;
  epochSpent: number;
  epochLenHours: number;
};
export function getVault(): VaultView {
  return {
    address: "0x42e699ffd8215d48397a049b4f7a176db06f4848",
    factory: "0x1562c6eb1813016c8562cf6771cbf715007bb7e9",
    token: "0xf202ce41d76ee1a2aec72e7a9180331d437ddd41",
    oracle: "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b",
    paused: false,
    perTxCap: 10,
    epochBudget: 100,
    epochSpent: 23.6,
    epochLenHours: 24,
  };
}
