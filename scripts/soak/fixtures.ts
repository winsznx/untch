import { hashCanonicalJson } from "../../packages/canon/src/index";
import type {
  LedgerWindowState,
  Policy,
  RecentIntent,
  SpendIntentInput,
} from "../../packages/policy-engine/src/index";
import type { AcceptanceCriteria, Delivery } from "../../packages/proof-engine/src/index";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";

/**
 * Shared soak-test fixtures (PRD §28 testnet soak). Every object here is fed to the REAL engines
 * (`@untch/policy-engine`, `@untch/proof-engine`, `@untch/escalation`) — nothing is mocked. The
 * builders below are deterministic given their `seed`, so every cycle is exactly reproducible: the
 * same seed re-derives the same intentHash and the same decision, which is itself the independent
 * check for the off-chain layer (determinism is the proof — replay yields identical output).
 */

export const OWNER: Address = getAddress("0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b");
export const DEMO_TOKEN: Address = getAddress("0xf202ce41d76ee1a2aec72e7a9180331d437ddd41");
export const RECIPIENT: Address = getAddress("0x000000000000000000000000000000000000beef");
export const DENIED_RECIPIENT: Address = getAddress("0x000000000000000000000000000000000000dead");

/** A deterministic bytes32 from any label — used for the intent's hash-typed fields. */
export function tag(label: string): Hex {
  return keccak256(toHex(label));
}

/**
 * The acceptance criteria a well-formed delivery must satisfy, and the committed acceptanceHash it
 * binds to (§7.3 criteria binding: `hashCanonicalJson(criteria) === acceptanceHash`). A PASS delivery
 * carries `{ status: "ok", resultUrl: "https://…", score: <0..1> }`; a FAIL delivery omits a required
 * field or violates a constraint.
 */
export const ACCEPTANCE_CRITERIA: AcceptanceCriteria = {
  canonVersion: "1",
  requiredFields: ["status", "resultUrl", "score"],
  fieldConstraints: [
    { field: "status", enum: ["ok"] },
    { field: "resultUrl", regex: "^https://.+", regexAnchored: false },
  ],
  sizeBounds: { maxBytes: 4096 },
};

export const ACCEPTANCE_HASH: Hex = hashCanonicalJson(ACCEPTANCE_CRITERIA);

export function passingDelivery(): Delivery {
  return { payload: { status: "ok", resultUrl: "https://vendor.example/result/42", score: 0.98 } };
}

/** Fails T0: `status` violates its enum AND `resultUrl`/`score` are absent → VERIFY_FAILED (§7.3). */
export function failingDelivery(): Delivery {
  return { payload: { status: "garbage", note: "delivery does not meet the committed spec" } };
}

/** A representative §8 policy — the same ruleset shape the dashboard and `prove-policy-onchain` use. */
export function basePolicy(overrides: Partial<Policy["rules"]> = {}): Policy {
  return {
    id: "12",
    version: 1,
    status: "ACTIVE",
    rules: {
      budgets: { daily: 100, token: "USDT" },
      perCallCap: 20,
      onPerCallCapExceeded: "BLOCK",
      escalateAbove: 10,
      categories: { allow: ["market-data", "security", "research"], deny: ["gambling"] },
      recipients: { allow: [], deny: [DENIED_RECIPIENT] },
      agents: { allowWorkerIds: [], denyWorkerIds: ["666"] },
      duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
      cooldowns: { sameServiceMin: 5 },
      rateLimit: { callsPerHour: 40 },
      expiry: "2027-12-31T00:00:00Z",
      ...overrides,
    },
  };
}

export interface IntentOverrides {
  readonly amount?: number;
  readonly maxAmount?: bigint;
  readonly category?: string;
  readonly workerAgentId?: bigint;
  readonly recipientAddress?: Address;
  readonly acceptanceHash?: Hex;
  readonly endpoint?: string;
  readonly taskLabel?: string;
}

/** Build a valid §8.1 intent, deterministic in `seed`; overrides bend it toward a target outcome. */
export function buildIntent(seed: number, o: IntentOverrides = {}): SpendIntentInput {
  const amount = o.amount ?? 5;
  const taskLabel = o.taskLabel ?? `task-${seed}`;
  return {
    owner: OWNER,
    buyerAgentId: 1n,
    workerAgentId: o.workerAgentId ?? 100n,
    token: DEMO_TOKEN,
    maxAmount: o.maxAmount ?? 1_000_000_000n,
    taskHash: tag(taskLabel),
    acceptanceHash: o.acceptanceHash ?? ACCEPTANCE_HASH,
    schemaHash: tag(`schema-${seed}`),
    policyHash: tag(`policy-${seed}`),
    deadline: 4_102_444_800n,
    nonce: BigInt(seed),
    endpoint: o.endpoint ?? `https://vendor.example/api/v1/quote?seed=${seed}`,
    paramsHash: tag(`params-${seed}`),
    recipientAddress: o.recipientAddress ?? RECIPIENT,
    category: o.category ?? "market-data",
    amount,
  };
}

export function freshLedger(overrides: Partial<LedgerWindowState> = {}): LedgerWindowState {
  return {
    budgetUsage: { settledToday: 0, reservedActiveToday: 0, effectiveToday: 0 },
    recentIntents: [],
    lastCallByService: {},
    callsInLastHour: 0,
    ...overrides,
  };
}

export function recentDuplicate(intent: SpendIntentInput, atMs: number): RecentIntent {
  return {
    intentId: "pi_dup",
    taskHash: intent.taskHash,
    endpoint: intent.endpoint,
    paramsHash: intent.paramsHash,
    createdAtMs: atMs,
  };
}

/** Canonical fingerprint of a completed cycle — a tamper-evident id anyone can recompute. */
export function cycleFingerprint(value: unknown): Hex {
  return hashCanonicalJson(value);
}
