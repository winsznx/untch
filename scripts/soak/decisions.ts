import { hashSpendIntent } from "../../packages/canon/src/index";
import {
  ChannelRegistry,
  EscalationService,
  InMemoryEscalationsRepo,
  type ApprovalsConfig,
  type Channel,
  type ChannelReceiver,
  type ChannelSendResult,
  type EscalationMessage,
  type EscalationRequest,
  type InboundResponse,
} from "../../packages/escalation/src/index";
import { evaluateIntent, type Decision, type SpendIntentInput } from "../../packages/policy-engine/src/index";
import { verifyDelivery, type VerifyOutcome } from "../../packages/proof-engine/src/index";
import type { Hex } from "viem";
import {
  ACCEPTANCE_CRITERIA,
  basePolicy,
  buildIntent,
  cycleFingerprint,
  DENIED_RECIPIENT,
  failingDelivery,
  freshLedger,
  recentDuplicate,
} from "./fixtures";

/**
 * Off-chain decision soak (PRD §28): ≥50 REAL cycles across all five §28 decision outcomes —
 * approve · block · escalate-approve · escalate-timeout · verify-fail-withhold. Every cycle runs the
 * REAL `@untch/policy-engine`, and where the outcome demands it the REAL `@untch/escalation` state
 * machine (§7.2) and REAL `@untch/proof-engine` T0 verifier (§7.3). No mocks, no simulation.
 *
 * Why this is the bulk of the soak, on no chain at all: the §7.1 decision is a pure, deterministic
 * function that runs BEFORE any settlement. A BLOCKED_*, an ESCALATED→timeout, and a verify-FAIL
 * cycle all terminate WITHOUT moving money (§7 lines: "no charge" / EXPIRED→default DENY / WITHHOLD),
 * so they never touch a facilitator or a chain. Only a cycle that reaches genuine APPROVED-and-settled
 * needs a real payment — the on-chain layer (soak/onchain.ts) handles that piece on a testnet fork,
 * and the mainnet x402 charge is the D0.1-proven piece.
 */

export type OutcomeType =
  | "approve"
  | "block"
  | "escalate-approve"
  | "escalate-timeout"
  | "verify-fail-withhold";

export interface CycleRecord {
  readonly seq: number;
  readonly outcomeType: OutcomeType;
  readonly variant: string;
  readonly intentHash: Hex;
  readonly decision: Decision["decision"];
  readonly reasons: readonly string[];
  /** Escalation resolution read back from the repo (not the inbound return) — the independent source. */
  readonly escalationFinal?: string;
  readonly verifyFinal?: VerifyOutcome["final"];
  readonly verifyRecommendation?: VerifyOutcome["recommendation"];
  /** True iff the independently recomputed intentHash equals the engine's — off-chain cross-check. */
  readonly intentHashVerified: boolean;
  /** True iff this cycle's terminal state moved (or would move) no money. */
  readonly withheld: boolean;
  readonly fingerprint: Hex;
  readonly ok: boolean;
}

const BOUND_HANDLE = "OPERATOR";

class RecordingChannel implements Channel {
  readonly sent: EscalationMessage[] = [];
  constructor(readonly name: string) {}
  async send(message: EscalationMessage): Promise<ChannelSendResult> {
    this.sent.push(message);
    return { ok: true, meta: {} };
  }
  async startReceiving(): Promise<ChannelReceiver> {
    return { stop: async () => {} };
  }
}

function makeClock(startMs: number) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function approvals(partial: Partial<ApprovalsConfig> = {}): ApprovalsConfig {
  return { channels: ["telegram"], dualChannelAbove: null, channelCaps: {}, escalationTimeoutMin: 30, ...partial };
}

/** A plan entry describes one cycle: how to build the intent and what outcome it must reach. */
interface PlanEntry {
  readonly outcomeType: OutcomeType;
  readonly variant: string;
  readonly build: (seq: number) => { intent: SpendIntentInput; policy: ReturnType<typeof basePolicy> };
}

/**
 * The soak plan. `block` deliberately fans across many BLOCKED_* subtypes (not one repeated) so the
 * whole §7.1 fail family is exercised; the other outcome types repeat to hit the ≥50 total with a
 * meaningful count each. Total below is 56.
 */
function buildPlan(): PlanEntry[] {
  const plan: PlanEntry[] = [];
  const push = (n: number, e: Omit<PlanEntry, "variant"> & { variant: string }) => {
    for (let i = 0; i < n; i++) plan.push(e);
  };

  // approve ×12 — amount under escalateAbove, allowed category, within all windows.
  push(12, {
    outcomeType: "approve",
    variant: "clean-approve",
    build: (s) => ({ intent: buildIntent(s, { amount: 5 }), policy: basePolicy() }),
  });

  // block ×14 across the BLOCKED_* family.
  const blocks: Array<{ variant: string; build: PlanEntry["build"] }> = [
    { variant: "block-budget", build: (s) => ({ intent: buildIntent(s, { amount: 5 }), policy: basePolicy({ budgets: { daily: 3, token: "USDT" } }) }) },
    { variant: "block-per-call-cap", build: (s) => ({ intent: buildIntent(s, { amount: 50 }), policy: basePolicy({ perCallCap: 20, onPerCallCapExceeded: "BLOCK", escalateAbove: 100 }) }) },
    { variant: "block-category", build: (s) => ({ intent: buildIntent(s, { amount: 5, category: "gambling" }), policy: basePolicy() }) },
    { variant: "block-recipient", build: (s) => ({ intent: buildIntent(s, { amount: 5, recipientAddress: DENIED_RECIPIENT }), policy: basePolicy() }) },
    { variant: "block-agent", build: (s) => ({ intent: buildIntent(s, { amount: 5, workerAgentId: 666n }), policy: basePolicy() }) },
    { variant: "block-intent-bound", build: (s) => ({ intent: buildIntent(s, { amount: 5, maxAmount: 1n }), policy: basePolicy() }) },
    { variant: "block-no-active-policy", build: (s) => ({ intent: buildIntent(s, { amount: 5 }), policy: { ...basePolicy(), status: "PAUSED" as const } }) },
  ];
  for (const b of blocks) push(2, { outcomeType: "block", variant: b.variant, build: b.build });

  // escalate-approve ×10 — amount over escalateAbove → ESCALATED_THRESHOLD → human APPROVE.
  push(10, {
    outcomeType: "escalate-approve",
    variant: "threshold-then-approve",
    build: (s) => ({ intent: buildIntent(s, { amount: 15 }), policy: basePolicy() }),
  });

  // escalate-timeout ×10 — same escalation, no response, clock past TTL → EXPIRED (default DENY).
  push(10, {
    outcomeType: "escalate-timeout",
    variant: "threshold-then-timeout",
    build: (s) => ({ intent: buildIntent(s, { amount: 15 }), policy: basePolicy() }),
  });

  // verify-fail-withhold ×10 — APPROVED decision, delivery fails T0 → WITHHOLD.
  push(10, {
    outcomeType: "verify-fail-withhold",
    variant: "approved-then-verify-fail",
    build: (s) => ({ intent: buildIntent(s, { amount: 5 }), policy: basePolicy() }),
  });

  return plan;
}

async function runEscalation(
  intentHash: Hex,
  policyId: string,
  amount: number,
  resolve: "approve" | "timeout",
): Promise<string> {
  const clock = makeClock(1_700_000_000_000);
  const repo = new InMemoryEscalationsRepo();
  const registry = new ChannelRegistry();
  registry.register(new RecordingChannel("telegram"));
  let idSeq = 0;
  let codeSeq = 0;
  const service = new EscalationService({
    repo,
    registry,
    binding: (ch, handle) => ch === "telegram" && handle === BOUND_HANDLE,
    clock: clock.now,
    genId: () => `esc_${(++idSeq).toString(16).padStart(12, "0")}`,
    genCode: () => (++codeSeq).toString(16).padStart(24, "0"),
    scheduleTimeout: async () => {},
    defaultTimeoutMin: 30,
  });

  const req: EscalationRequest = {
    pollRef: `poll_${intentHash.slice(2, 14)}`,
    intentId: intentHash,
    reason: "ESCALATED_THRESHOLD",
    policyId,
    amount,
    token: "USDT",
    approvals: approvals(),
  };
  const { record, code } = await service.createEscalation(req);

  if (resolve === "approve") {
    const inbound: InboundResponse = {
      channel: "telegram",
      senderHandle: BOUND_HANDLE,
      action: "APPROVE",
      code,
      receivedAtMs: clock.now(),
    };
    await service.handleInbound(inbound);
  } else {
    clock.advance(31 * 60_000);
    await service.expire(record.id);
  }

  const fresh = await repo.getById(record.id);
  return fresh?.status ?? "UNKNOWN";
}

export interface SoakSummary {
  readonly total: number;
  readonly byOutcome: Record<OutcomeType, number>;
  readonly allOk: boolean;
  readonly records: CycleRecord[];
}

export async function runDecisionSoak(): Promise<SoakSummary> {
  const plan = buildPlan();
  const records: CycleRecord[] = [];
  const byOutcome: Record<OutcomeType, number> = {
    approve: 0,
    block: 0,
    "escalate-approve": 0,
    "escalate-timeout": 0,
    "verify-fail-withhold": 0,
  };

  let seq = 0;
  for (const entry of plan) {
    seq++;
    const { intent, policy } = entry.build(seq);
    const decision = evaluateIntent(intent, policy, freshLedger(), { now: () => 1_700_000_000_000 });

    const recomputed = hashSpendIntent({
      owner: intent.owner,
      buyerAgentId: intent.buyerAgentId,
      workerAgentId: intent.workerAgentId,
      token: intent.token,
      maxAmount: intent.maxAmount,
      taskHash: intent.taskHash,
      acceptanceHash: intent.acceptanceHash,
      schemaHash: intent.schemaHash,
      policyHash: intent.policyHash,
      deadline: intent.deadline,
      nonce: intent.nonce,
    });
    const intentHashVerified = recomputed.toLowerCase() === decision.intentHash.toLowerCase();

    let escalationFinal: string | undefined;
    let verifyFinal: VerifyOutcome["final"] | undefined;
    let verifyRecommendation: VerifyOutcome["recommendation"] | undefined;
    let ok = intentHashVerified;
    let withheld = true;

    switch (entry.outcomeType) {
      case "approve": {
        ok = ok && decision.decision === "APPROVED";
        withheld = false;
        break;
      }
      case "block": {
        ok = ok && decision.decision.startsWith("BLOCKED_");
        break;
      }
      case "escalate-approve": {
        ok = ok && decision.decision === "ESCALATED_THRESHOLD";
        escalationFinal = await runEscalation(decision.intentHash, decision.policyId, intent.amount, "approve");
        ok = ok && escalationFinal === "APPROVED";
        withheld = false;
        break;
      }
      case "escalate-timeout": {
        ok = ok && decision.decision === "ESCALATED_THRESHOLD";
        escalationFinal = await runEscalation(decision.intentHash, decision.policyId, intent.amount, "timeout");
        ok = ok && escalationFinal === "EXPIRED";
        break;
      }
      case "verify-fail-withhold": {
        ok = ok && decision.decision === "APPROVED";
        const outcome = verifyDelivery({
          intentHash: decision.intentHash,
          acceptanceHash: intent.acceptanceHash,
          criteria: ACCEPTANCE_CRITERIA,
          delivery: failingDelivery(),
          now: () => 1_700_000_000_000,
        });
        verifyFinal = outcome.final;
        verifyRecommendation = outcome.recommendation;
        ok = ok && outcome.final === "VERIFY_FAILED" && outcome.recommendation === "WITHHOLD";
        break;
      }
    }

    byOutcome[entry.outcomeType]++;
    const partial = {
      seq,
      outcomeType: entry.outcomeType,
      variant: entry.variant,
      intentHash: decision.intentHash,
      decision: decision.decision,
      reasons: decision.reasons,
      ...(escalationFinal ? { escalationFinal } : {}),
      ...(verifyFinal ? { verifyFinal } : {}),
      ...(verifyRecommendation ? { verifyRecommendation } : {}),
      intentHashVerified,
      withheld,
      ok,
    };
    records.push({ ...partial, fingerprint: cycleFingerprint(partial) });
  }

  return { total: records.length, byOutcome, allOk: records.every((r) => r.ok), records };
}
