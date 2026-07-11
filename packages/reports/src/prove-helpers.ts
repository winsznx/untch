import {
  evaluateIntent,
  type Decision,
  type DecisionOutcome,
  type LedgerWindowState,
  type Policy,
  type SpendIntentInput,
} from "@untch/policy-engine";
import {
  verifyDelivery,
  type AcceptanceCriteria,
  type Delivery,
} from "@untch/proof-engine";
import {
  draftFromDecision,
  draftFromVerify,
  type VerifyIntentProvenance,
} from "@untch/receipt-writer";
import { hashCanonicalJson } from "@untch/canon";
import type { Address, Hex } from "viem";
import type { LedgerRow, ReceiptRow } from "./datasource";

/**
 * Shared REAL-data builders for the two anchor proofs. Nothing here is hand-set: every DECISION receipt
 * comes from running the REAL `@untch/policy-engine` and every VERIFY receipt from the REAL
 * `@untch/proof-engine`, both turned into on-chain receipt payloads by the REAL `@untch/receipt-writer`
 * mapping. The proofs then assemble the report tools over these genuine outputs, so an anchored report
 * hash commits to data the four subsystems actually produced — not a fabrication.
 *
 * The receipts are NOT themselves anchored on-chain in these self-contained proofs (only the assembled
 * REPORT hash is), so their `txHash`/`blockNumber` are honestly null and the artifact labels them as
 * not-yet-anchored — the same honesty the tools apply to sparse history.
 */

const b32 = (byte: string): Hex => (`0x${byte.repeat(32)}`) as Hex;
const BASE_MS = 1_700_000_000_000;

export function buildIntent(tag: string, over: Partial<SpendIntentInput> = {}): SpendIntentInput {
  return {
    owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address,
    buyerAgentId: 42n,
    workerAgentId: 0n,
    token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736" as Address,
    maxAmount: 10_000_000n,
    taskHash: hashCanonicalJson({ tag, kind: "task" }),
    acceptanceHash: b32("22"),
    schemaHash: b32("33"),
    policyHash: b32("44"),
    deadline: 9_999_999_999n,
    nonce: BigInt(Math.abs(hashInt(tag))),
    endpoint: "https://api.vendor.example/v1/market-data?symbol=OKB",
    paramsHash: hashCanonicalJson({ tag, kind: "params" }),
    recipientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
    category: "market-data",
    amount: 0.5,
    ...over,
  };
}

export function buildPolicy(over: Partial<Policy["rules"]> = {}): Policy {
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
      ...over,
    },
  };
}

export function emptyLedger(over: Partial<LedgerWindowState> = {}): LedgerWindowState {
  return { spentTodayByAgent: 0, recentIntents: [], lastCallByService: {}, callsInLastHour: 0, ...over };
}

/** A hex→small-int helper for deterministic-but-varied nonces. */
function hashInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export interface RealDecision {
  readonly receipt: ReceiptRow;
  readonly ledger: LedgerRow | null;
  readonly outcome: DecisionOutcome;
}

/**
 * Run the REAL policy engine for one intent, assert it produced `expected`, and turn the real Decision
 * into a real DECISION receipt row (via receipt-writer's mapping). Throws if the engine's outcome is not
 * the expected one — so the proof can never silently anchor a mislabeled decision.
 */
export function realDecision(args: {
  tag: string;
  expected: DecisionOutcome;
  intent?: Partial<SpendIntentInput>;
  policy?: Partial<Policy["rules"]>;
  ledger?: Partial<LedgerWindowState>;
  createdAt?: string;
}): RealDecision {
  const intent = buildIntent(args.tag, args.intent);
  const policy = buildPolicy(args.policy);
  const state = emptyLedger(args.ledger);
  const now = () => BASE_MS;
  const decision: Decision = evaluateIntent(intent, policy, state, { now });
  if (decision.decision !== args.expected) {
    throw new Error(
      `real policy engine returned ${decision.decision} for "${args.tag}", expected ${args.expected}`,
    );
  }
  const draft = draftFromDecision(intent, decision);
  const createdAt = args.createdAt ?? new Date(BASE_MS).toISOString();
  const receipt = onchainToRow(draft.onchain, "DECISION", createdAt, null);
  const ledger: LedgerRow | null = draft.ledger
    ? {
        receiptId: draft.onchain.receiptId,
        agentId: draft.ledger.agentId,
        type: draft.ledger.type,
        amount: draft.ledger.amount,
        token: draft.ledger.token,
        counterparty: draft.ledger.counterparty,
        dayKey: draft.ledger.dayKey,
        categoryKey: draft.ledger.categoryKey,
        vendorKey: draft.ledger.vendorKey,
        createdAt,
      }
    : null;
  return { receipt, ledger, outcome: decision.decision };
}

export interface RealVerify {
  readonly receipt: ReceiptRow;
  readonly final: string;
}

/**
 * Run the REAL proof engine T0 for one intent's delivery, assert `expectedFinal`, and turn the real
 * VerifyOutcome into a real VERIFY receipt row. Throws if the engine did not produce the expected final
 * result — so the proof can never anchor a mislabeled verification.
 */
export function realVerify(args: {
  tag: string;
  /** Bind the verify receipt to this intentHash — pass the DECISION receipt's intentHash so a dispute
   *  packet groups both under the same intent. */
  intentHash: Hex;
  intent?: Partial<SpendIntentInput>;
  criteria: AcceptanceCriteria;
  delivery: Delivery;
  expectedFinal: string;
  provenance?: VerifyIntentProvenance;
  createdAt?: string;
}): RealVerify {
  const acceptanceHash = hashCanonicalJson(args.criteria as unknown as Record<string, unknown>);
  const intent = buildIntent(args.tag, { acceptanceHash, ...args.intent });
  const outcome = verifyDelivery({
    intentHash: args.intentHash,
    acceptanceHash,
    criteria: args.criteria,
    delivery: args.delivery,
  });
  if (outcome.final !== args.expectedFinal) {
    throw new Error(`real proof engine returned ${outcome.final} for "${args.tag}", expected ${args.expectedFinal}`);
  }
  const createdAt = args.createdAt ?? new Date(BASE_MS + 60_000).toISOString();
  const draft = draftFromVerify(intent, {
    policyId: "12",
    intentHash: outcome.intentHash,
    verifyResultCode: outcome.verifyResultCode,
    proofTier: outcome.proofTier,
    payloadHash: outcome.payloadHash,
    verifiedAt: outcome.verifiedAt,
    provenance: args.provenance ?? "store-committed",
  });
  const receipt = onchainToRow(draft.onchain, "VERIFY", createdAt, draft.provenance ?? null);
  return { receipt, final: outcome.final };
}

/** Map a receipt-writer `ReceiptOnchain` (bigints) into a report `ReceiptRow` (strings + anchor cols).
 *  `txHash`/`blockNumber` are null: these proofs anchor the REPORT, not the individual receipts. */
function onchainToRow(
  o: {
    receiptId: Hex;
    policyId: bigint;
    policyHash: Hex;
    agentId: Hex;
    vendorId: Hex;
    amount: bigint;
    token: Address;
    category: Hex;
    payType: number;
    intentHash: Hex;
    taskHash: Hex;
    decision: number;
    verifyResult: number;
    proofTier: number;
    metadataHash: Hex;
  },
  kind: "DECISION" | "VERIFY",
  createdAt: string,
  provenance: "store-committed" | "caller-supplied" | null,
): ReceiptRow {
  return {
    receiptId: o.receiptId,
    kind,
    status: "BATCHED",
    intentHash: o.intentHash,
    policyId: o.policyId.toString(),
    policyHash: o.policyHash,
    agentId: o.agentId,
    vendorId: o.vendorId,
    amount: o.amount.toString(),
    token: o.token,
    category: o.category,
    payType: o.payType,
    taskHash: o.taskHash,
    decision: o.decision,
    verifyResult: o.verifyResult,
    proofTier: o.proofTier,
    metadataHash: o.metadataHash,
    provenance,
    batchId: null,
    txHash: null,
    blockNumber: null,
    createdAt,
  };
}
