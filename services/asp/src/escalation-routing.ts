import {
  OWNER_BINDING_CHANNEL,
  type EscalationRecord,
  type OperatorsRepo,
} from "@untch/escalation";
import { getAddress } from "viem";

/**
 * Owner-based escalation routing (§27) — the load-bearing use of the operator-identity tables.
 *
 * Before: every escalation ensured `policy_approvers(policyId, op_demo)` and fanned out to op_demo's
 * channels REGARDLESS of who owned the policy (moot only because every policy shared one owner). Now that
 * `create_spend_policy` gives policies genuine, distinct owners, an escalation must route to the RIGHT
 * owner:
 *   • resolve the operator for the policy's REAL owner wallet (`operatorForOwner`, the dashboard binding);
 *   • ensure that operator is the policy's approver;
 *   • fan out only to that operator's bound channels;
 *   • and, on the §27 dashboard identity path, only honor an approval from a session wallet whose operator
 *     is an approver of THIS policy (`makeOwnershipVerifier`).
 *
 * Interim single-operator fallback: an owner not yet bound to its own operator (no §15 onboarding) routes
 * to the instance's configured operator (`interimOperatorId`, the one its env-configured channels belong
 * to). This is the honest interim — a bound owner routes to itself; it is NOT the old "always the constant"
 * behavior. When §15 lands, every owner is bound and routing follows the owner with zero code change.
 */

/** Deterministic operator id for a policy owner wallet (used when provisioning a self-served owner). */
export function deriveOperatorId(owner: string): string {
  return `op:${owner.trim().toLowerCase()}`;
}

/** The set of channel names an operator is reachable on — the fan-out restriction for owner routing. */
export async function operatorChannelSet(
  operators: OperatorsRepo,
  operatorId: string,
): Promise<Set<string>> {
  const bindings = await operators.channelsForOperator(operatorId);
  return new Set(bindings.map((b) => b.channel));
}

/**
 * §27 dashboard ownership verifier: does `senderHandle` (the SIWE-verified session wallet) own the
 * escalation's policy — i.e. is its operator an approver of `rec.policyId`? A wallet that owns a DIFFERENT
 * policy (or none) fails here, exactly like a bad code on the other channels. This is the multi-tenant
 * authority boundary the dashboard needs: a bound wallet can only resolve escalations for policies it owns.
 */
export function makeOwnershipVerifier(
  operators: OperatorsRepo,
): (rec: EscalationRecord, senderHandle: string) => Promise<boolean> {
  return async (rec, senderHandle) => {
    const operator = await operators.operatorForOwner(senderHandle);
    if (!operator) return false;
    const approvers = await operators.approversFor(rec.policyId);
    return approvers.includes(operator);
  };
}

/**
 * Route + record an escalation to the policy's REAL owner. Two cases:
 *
 *   • Owner is bound to its OWN operator (a real §15 onboarding, or a test): that operator approves and its
 *     channels are the fan-out target. Fully self-served, isolated from every other operator.
 *   • Owner is NOT yet bound (interim single-operator reality): first-class the owner as its own operator
 *     (id + dashboard binding, so a later onboarding is additive) AND record it as an approver — so the
 *     owner can already resolve its own escalations via the dashboard. But NOTIFY via the interim operator's
 *     configured channels (Telegram/Discord/Slack), and record it as an approver too, so the escalation
 *     still reaches a live surface until the owner onboards their own.
 *
 * Idempotent. Returns the channel-restriction set the fan-out narrows to (never widens).
 */
export async function routeEscalationToOwner(args: {
  readonly operators: OperatorsRepo;
  readonly owner: string;
  readonly policyId: string;
  readonly interimOperatorId: string;
}): Promise<{ operatorId: string; restrictToChannels: Set<string> }> {
  const { operators, owner, policyId, interimOperatorId } = args;

  const bound = await operators.operatorForOwner(owner);
  if (bound) {
    await operators.ensurePolicyApprover(policyId, bound);
    return { operatorId: bound, restrictToChannels: await operatorChannelSet(operators, bound) };
  }

  // Unbound owner: first-class it (future onboarding is additive), let it approve its own escalations,
  // but notify via — and also approvable by — the interim configured operator.
  const ownOperator = deriveOperatorId(owner);
  await operators.ensureOperator(ownOperator, `policy owner ${safeChecksum(owner)}`);
  await operators.ensureBinding(ownOperator, OWNER_BINDING_CHANNEL, owner.trim().toLowerCase());
  await operators.ensurePolicyApprover(policyId, ownOperator);
  await operators.ensurePolicyApprover(policyId, interimOperatorId);
  return {
    operatorId: interimOperatorId,
    restrictToChannels: await operatorChannelSet(operators, interimOperatorId),
  };
}

function safeChecksum(addr: string): string {
  try {
    return getAddress(addr as `0x${string}`);
  } catch {
    return addr;
  }
}
