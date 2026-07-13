/**
 * Non-blocking escalation handle (PRD §7.2, §14 Mode B "ESCALATE ⇒ held with poll handle").
 *
 * The guard NEVER sleeps on a human-timescale operation. On ESCALATE it returns this handle
 * immediately; the calling application decides its own poll cadence. `poll()` consults an injected
 * resolver if one was provided (e.g. the escalation service), and otherwise reports the hold as still
 * PENDING — it never blocks, never waits, never notifies. Sending the notification is a separate,
 * later component; this handle's only job is to correctly represent "held, pending" and be pollable.
 */

import type {
  EscalationResolver,
  EscalationState,
  PollHandle,
  PreflightDecision,
} from "./types";

export function createPollHandle(
  decision: PreflightDecision,
  heldAt: number,
  resolver?: EscalationResolver,
): PollHandle {
  const id =
    decision.receiptRef?.receiptId ??
    (typeof decision.intentHash === "string" ? decision.intentHash : `held:${heldAt}`);
  const reason = decision.decision;

  return {
    id,
    reason,
    heldAt,
    async poll(): Promise<EscalationState> {
      if (!resolver) return { status: "PENDING", reason };
      return resolver({ id, reason });
    },
  };
}
