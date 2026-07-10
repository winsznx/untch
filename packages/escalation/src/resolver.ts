import type { EscalationResolver } from "@untch/x402-guard";
import type { EscalationService } from "./service";

/**
 * The bridge that wires x402-guard's `poll()` to this real service (§14 Mode B, PRD task 5).
 *
 * The guard, on an ESCALATED preflight decision, returns a non-blocking poll handle whose id is
 * `receiptRef.receiptId ?? intentHash` — the SAME value the service stores as `poll_ref`. This resolver
 * simply asks the service for that escalation's current state. It replaces the stub/injected resolver
 * the guard has been polling against: an ESCALATED decision now resolves for real when (and only when)
 * the operator responds through a channel and the response passes the §27 authority-boundary check —
 * or defaults to DENIED on timeout. The channel never reaches the guard; only the resolved state does.
 */
export function makeEscalationResolver(service: EscalationService): EscalationResolver {
  return ({ id }) => service.getState(id);
}
