import type { Address, Hex } from "viem";
import type { LedgerWindowState, Policy, RecentIntent, SpendIntentInput } from "../src/types";

/**
 * Shared test fixtures. NOT a `*.test.ts` file, so the runner never executes it directly; the
 * test files import these factories. The fixed clock is pinned to §8.2's example `evaluatedAt`
 * so trace-shape assertions can compare against the PRD verbatim.
 */

/** Fixed evaluation instant — §8.2's example `evaluatedAt` ("2026-07-05T20:44:00Z"). */
export const NOW_MS = Date.parse("2026-07-05T20:44:00Z");
export const now = (): number => NOW_MS;

const b32 = (byte: string): Hex => `0x${byte.repeat(32)}` as Hex;

/** A fully valid intent (all §8.1 struct fields + endpoint/paramsHash/recipient/category/amount). */
export function validIntent(overrides: Partial<SpendIntentInput> = {}): SpendIntentInput {
  return {
    owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address,
    buyerAgentId: 1n,
    workerAgentId: 0n,
    token: "0x382bB369d343125BfB2117af9c149795C6C65C50" as Address,
    maxAmount: 1_000_000n,
    taskHash: b32("11"),
    acceptanceHash: b32("22"),
    schemaHash: b32("33"),
    policyHash: b32("44"),
    deadline: 9_999_999_999n,
    nonce: 1n,
    endpoint: "https://api.example.com/v1/data?b=2&a=1",
    paramsHash: b32("55"),
    recipientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
    category: "market-data",
    amount: 0.05,
    ...overrides,
  };
}

/**
 * An ACTIVE policy with DELIBERATELY GENEROUS thresholds: daily 25 USDT, but per-call cap and
 * escalate-above set high (1000) and all allow/deny lists empty, so a clean `validIntent`
 * (amount 0.05) sails through as APPROVED. Per-rule tests override just the one field they trip.
 */
export function activePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    id: "12",
    version: 3,
    status: "ACTIVE",
    rules: {
      budgets: { daily: 25, token: "USDT" },
      perCallCap: 1000,
      onPerCallCapExceeded: "BLOCK",
      escalateAbove: 1000,
      categories: { allow: [], deny: [] },
      recipients: { allow: [], deny: [] },
      agents: { allowWorkerIds: [], denyWorkerIds: [] },
      duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
      cooldowns: { sameServiceMin: 5 },
      rateLimit: { callsPerHour: 40 },
      expiry: "2999-12-31T00:00:00Z",
    },
    ...overrides,
  };
}

/** Empty ledger window: nothing spent, no recent intents, no prior service calls, zero rate count. */
export function emptyLedger(overrides: Partial<LedgerWindowState> = {}): LedgerWindowState {
  return {
    budgetUsage: { settledToday: 0, reservedActiveToday: 0, effectiveToday: 0 },
    recentIntents: [],
    lastCallByService: {},
    callsInLastHour: 0,
    ...overrides,
  };
}

/** A prior intent record, dedup-matching `validIntent()` by default, created `minutesAgo` ago. */
export function priorIntent(minutesAgo: number, overrides: Partial<RecentIntent> = {}): RecentIntent {
  return {
    intentId: "pi_abc123",
    taskHash: b32("11"),
    endpoint: "https://api.example.com/v1/data?b=2&a=1",
    paramsHash: b32("55"),
    createdAtMs: NOW_MS - minutesAgo * 60_000,
    ...overrides,
  };
}
