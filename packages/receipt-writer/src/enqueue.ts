import type { Decision, SpendIntentInput } from "@untch/policy-engine";
import type { Queue } from "bullmq";
import {
  draftFromDecision,
  draftFromDeliveryVerification,
  draftFromVerify,
  type VerifyReceiptContext,
} from "./mapping";
import type { DeliveryVerificationContext } from "./delivery-verification-receipt";
import type { ReceiptDraft } from "./types";
import type { ReceiptsRepo } from "./repo";
import type { TickJob } from "./queue";
import type { EnqueueResult } from "./types";

/**
 * The seller-facing enqueue path. This is the ONLY thing preflight_payment calls, and it MUST NOT
 * block on batching or chain confirmation (HARD RULE): it durably writes the receipt + ledger row to
 * Postgres, best-effort signals the worker via a BullMQ tick, and returns {receiptId, status:"QUEUED"}
 * immediately. Everything downstream (batch, submit, confirm) is the worker's job.
 *
 * Durability does NOT depend on Redis: if the tick add fails, the receipt is already committed and the
 * worker's periodic safety sweep will pick it up. The tick is a latency optimization, not the record.
 */
export class ReceiptEnqueuer {
  constructor(
    private readonly repo: ReceiptsRepo,
    private readonly tickQueue: Queue<TickJob>,
    private readonly onSignalError: (err: unknown) => void = () => {},
  ) {}

  /** §7.4 — enqueue a DECISION receipt from a preflight decision. */
  async enqueue(input: SpendIntentInput, decision: Decision): Promise<EnqueueResult> {
    return this.persist(draftFromDecision(input, decision));
  }

  /** §7.3/§7.4 — enqueue a VERIFY receipt from a real delivery-verification result. This is the path
   *  that finally records a non-default verifyResult/proofTier on-chain. Same durability contract as
   *  a decision receipt: durable write first, best-effort tick, immediate {receiptId, QUEUED}. */
  async enqueueVerify(input: SpendIntentInput, ctx: VerifyReceiptContext): Promise<EnqueueResult> {
    return this.persist(draftFromVerify(input, ctx));
  }

  /**
   * §7.3 — enqueue the VERIFY receipt for one delivery-verification addendum.
   *
   * Idempotent by construction rather than by a guard here: the receipt id is derived from the
   * verification's own immutable identity, so a repeat computes the same id and the insert's
   * `ON CONFLICT DO NOTHING` makes it a no-op. Two callers racing therefore agree on one receipt
   * instead of minting two ids for one claim.
   *
   * Returns the id either way. A caller cannot tell a first request from a repeat and does not need
   * to: both mean "this verification has a receipt", which is the only thing it acts on.
   */
  async enqueueDeliveryVerification(
    input: SpendIntentInput,
    ctx: DeliveryVerificationContext,
  ): Promise<EnqueueResult> {
    return this.persist(draftFromDeliveryVerification(input, ctx));
  }

  private async persist(draft: ReceiptDraft): Promise<EnqueueResult> {
    // 1. DURABLE first — receipt (QUEUED) + ledger entry (if any), one transaction. Source of truth.
    await this.repo.insertDraft(draft);

    // 2. Best-effort signal. Never let a Redis hiccup fail the request or delay the response.
    try {
      await this.tickQueue.add(
        "tick",
        { receiptId: draft.onchain.receiptId },
        { removeOnComplete: true, removeOnFail: 1000 },
      );
    } catch (err) {
      this.onSignalError(err);
    }

    return { receiptId: draft.onchain.receiptId, status: "QUEUED" };
  }
}
