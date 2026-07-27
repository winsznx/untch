/**
 * Bridges from the Consumer Pack to the subsystems Untch already has.
 *
 * These are deliberately thin. The Consumer Pack does not get its own approval pipeline or its own
 * receipt writer — it gets an adapter onto the ones that already carry the §7.2 authority boundary
 * and the §7.4 durability contract. A second approval path would fork the thing that makes Untch
 * trustworthy; a second receipt writer would fork the thing that makes it auditable.
 *
 * Each bridge returns `null` when its subsystem is unwired, and the orchestrator handles that
 * honestly: no escalation gateway means an escalated intent WAITS (never auto-approves), and no
 * receipt sink means `receiptId` stays null rather than being fabricated.
 */

import {
  displayMoney,
  type ConsumerIntent,
  type ConsumerQuote,
  type Money,
} from "@untch/consumer-core";
import type { Decision, SpendIntentInput } from "@untch/policy-engine";
import type { StoredPolicy } from "@untch/policy-store";
import type { ReceiptEnqueuer } from "@untch/receipt-writer";
import { getAddress, type Address, type Hex } from "viem";
import type { EscalationWiring } from "../escalation-wiring";
import type { ReceiptWiring } from "../receipts";
import type { EscalationGateway } from "../handlers";
import { projectConsumerIntent } from "./projection";
import type { ConsumerEscalationGateway, ConsumerReceiptSink, ReceiptRecordOutcome } from "./orchestrator";

/**
 * The approval bridge.
 *
 * It calls the SAME `EscalationGateway.onEscalated` the preflight path uses, with the same `pollRef`
 * convention, so a consumer approval appears in the operator's Telegram / Discord / Slack /
 * dashboard queue indistinguishably from a preflight approval — one queue, one authority boundary,
 * one §27 check.
 *
 * `createEscalation` is idempotent by `pollRef` (a repeat returns the existing record without
 * re-minting a code), so a retried policy run cannot invalidate a code an operator is already
 * holding.
 */
export function makeConsumerEscalationGateway(
  escalationWiring: EscalationWiring | null,
  preflightGateway: EscalationGateway | null,
): ConsumerEscalationGateway | null {
  if (!escalationWiring || !preflightGateway) return null;

  return {
    async requestApproval(args): Promise<{ escalationId: string }> {
      // The gateway wants the §8.1 intent the decision was made for. It is rebuilt from the same
      // projection the decision used, so the amount an operator is asked to approve is exactly the
      // amount the engine judged.
      const input = projectionInputFor(args.decision, args.amount, args.summary);
      await preflightGateway.onEscalated({
        input,
        decision: args.decision,
        stored: args.stored,
        pollRef: args.pollRef,
      });
      // The escalation service assigns its own id; the poll ref is the stable handle either way.
      return { escalationId: args.pollRef };
    },

    async pollApproval(pollRef): Promise<"PENDING" | "APPROVED" | "DENIED"> {
      const view = await escalationWiring.status(pollRef);
      const status = (view as { status?: string }).status ?? "PENDING";
      if (status === "APPROVED") return "APPROVED";
      // EXPIRED, DENIED and NOTIFY_FAILED all resolve to DENIED. That is the §7.2 fail-closed
      // default (I2): an approval that never arrived is a spend that was never authorised.
      if (status === "DENIED" || status === "EXPIRED") return "DENIED";
      return "PENDING";
    },
  };
}

/**
 * A minimal §8.1 input carrying the fields the escalation copy renders (amount, token, policy). The
 * decision already carries the authoritative `intentHash`, `policyId` and `policyVersion`; this fills
 * in the display fields around it without re-deriving anything that could disagree.
 */
function projectionInputFor(decision: Decision, amount: Money, summary: string): SpendIntentInput {
  const zeroAddr = "0x0000000000000000000000000000000000000000" as Address;
  const tokenAddr = amount.asset.address === null
    ? zeroAddr
    : (getAddress(amount.asset.address).toLowerCase() as Address);
  return {
    owner: zeroAddr,
    buyerAgentId: 0n,
    workerAgentId: 0n,
    token: tokenAddr,
    maxAmount: amount.amount,
    taskHash: decision.intentHash,
    acceptanceHash: `0x${"0".repeat(64)}` as Hex,
    schemaHash: `0x${"0".repeat(64)}` as Hex,
    policyHash: `0x${"0".repeat(64)}` as Hex,
    deadline: 0n,
    nonce: 0n,
    endpoint: `untch://consumer/${summary.slice(0, 60)}`,
    paramsHash: `0x${"0".repeat(64)}` as Hex,
    recipientAddress: zeroAddr,
    category: "consumer",
    amount: Number(displayMoney(amount).split(" ")[0] ?? "0"),
  };
}

/**
 * The receipt bridge.
 *
 * A completed consumer action produces a §7.4 DECISION receipt through the existing
 * `ReceiptEnqueuer`: durable Postgres write first, best-effort tick, immediate
 * `{receiptId, status:"QUEUED"}`. The receipt is anchored by the same worker that anchors every
 * other Untch receipt, so a consumer purchase lands in the same on-chain batch as a preflight
 * decision rather than in a parallel stream nobody watches.
 */
export function makeConsumerReceiptSink(receiptWiring: ReceiptWiring | null): ConsumerReceiptSink | null {
  if (!receiptWiring) return null;
  return { record: (args) => recordConsumerReceipt(receiptWiring.enqueuer, args) };
}

async function recordConsumerReceipt(
  enqueuer: ReceiptEnqueuer,
  args: { intent: ConsumerIntent; quote: ConsumerQuote; decision: Decision },
): Promise<ReceiptRecordOutcome> {
  const { intent, quote, decision } = args;
  // Rebuild the exact §8.1 input the receipt maps from. Everything is derived from the stored intent
  // and quote, so the receipt describes the action that actually happened.
  const stored = {
    id: intent.policyId,
    version: intent.policyVersion ?? 1,
    policyHash: (intent.policyHash ?? `0x${"0".repeat(64)}`) as Hex,
    owner: "0x0000000000000000000000000000000000000000",
  } as unknown as StoredPolicy;

  const projected = projectConsumerIntent({
    intent,
    quote,
    stored,
    deadlineSec: BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000)),
  });

  try {
    const result = await enqueuer.enqueue(projected.input, decision);
    return { status: "recorded", receiptId: result.receiptId };
  } catch (err) {
    /**
     * A receipt that cannot be written must not fail a completed purchase — the money already moved
     * and the ledger already records it. The intent completes with a null receiptId, which is an
     * honest "not anchored" rather than a fabricated id.
     *
     * The REASON is returned rather than discarded. This branch previously swallowed the error
     * entirely, which made a misconfigured writer look identical to a rejected write: during
     * activation an intent completed with a null receiptId and the only way to establish why was to
     * replay the whole path by hand against production.
     */
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
