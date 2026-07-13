/**
 * Dashboard data that is NOT per-operator history.
 *
 * The policy list, intent stream, ledger, escalation inbox, and vendor/buyer scores now come from the
 * shared production Postgres, scoped to the signed-in wallet — see lib/dashboard/live.ts. What remains here
 * is the handful of things that are not a wallet's stored history:
 *   • DEFAULT_POLICY_RULES — the starting template the Create form seeds (the operator edits then registers).
 *   • getProofTiers — a live @untch/proof-engine capability demo (the T0–T4 verify ladder), not a data read.
 *   • getVault — the real deployed testnet vault addresses/txs (on-chain artifacts; §15 #6 vault panel).
 */
import type { Hex } from "viem";
import type { PolicyRules } from "../chain/policy-tx";
import { hashCanonicalJson } from "@untch/canon";
import { verifyDelivery } from "@untch/proof-engine";

const h32 = (b: string): Hex => `0x${b.padStart(2, "0").repeat(32).slice(0, 64)}` as Hex;

// ── Policy builder starting template ───────────────────────────────────────────────────────────────
export const DEFAULT_POLICY_RULES: PolicyRules = {
  budgets: { daily: 25, token: "USDT" },
  perCallCap: 10.0,
  onPerCallCapExceeded: "BLOCK",
  escalateAbove: 5.0,
  categories: { allow: ["market-data", "security", "research"], deny: [] },
  recipients: { allow: [], deny: [] },
  agents: { allowWorkerIds: [], denyWorkerIds: [] },
  duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
  cooldowns: { sameServiceMin: 5 },
  rateLimit: { callsPerHour: 40 },
  expiry: "2027-01-31T00:00:00Z",
};

// ── Proof-tier distribution (real verifyDelivery capability demo) ──────────────────────────────────
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
