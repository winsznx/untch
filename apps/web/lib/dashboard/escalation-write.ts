import {
  ChannelRegistry,
  DashboardChannel,
  EscalationService,
  interimDashboardBinding,
  type EscalationRecord,
} from "@untch/escalation";
import { getPool, escalationRepo, policyRepo } from "./db";

/**
 * The dashboard's escalation WRITE — approve/deny as a genuine fourth channel resolving the SAME shared
 * escalation record Telegram/Discord/Slack resolve, through the SAME EscalationService + PgEscalationsRepo
 * (the shared production Postgres). Not a parallel instance over its own data: `escalationRepo(pool)` is
 * the shared repo, so `handleInbound` transitions the real row a buyer agent's preflight created.
 *
 * Authority is SESSION IDENTITY per §27 — no per-click wallet signature. The dashboard is registered as an
 * identity-authorized channel, so the §27 pt4 single-use code (never available to the dashboard) is
 * replaced by an OWNERSHIP check: the signed-in wallet must (a) be bound to the dashboard channel
 * (`interimDashboardBinding`) AND (b) own the escalation's policy (`verifyOwnership` → PgPolicyRepo). An
 * escalation for a policy the session wallet does not own fails the §27 authority boundary here, exactly
 * like a bad code — the read-scoping is not the only gate.
 */

export interface DecisionResult {
  readonly outcome: string;
  readonly status: string | null;
  readonly detail: string;
}

export async function submitDashboardDecision(params: {
  operatorWallet: string;
  escalationId: string;
  action: "APPROVE" | "DENY";
}): Promise<DecisionResult> {
  const pool = getPool();
  if (!pool) return { outcome: "IGNORED_NOT_FOUND", status: null, detail: "no shared database configured" };

  const registry = new ChannelRegistry();
  const dashboard = new DashboardChannel({});
  registry.register(dashboard);
  const policies = policyRepo(pool);

  const service = new EscalationService({
    repo: escalationRepo(pool),
    registry,
    binding: interimDashboardBinding(params.operatorWallet),
    identityAuthorizedChannels: new Set(["dashboard"]),
    verifyOwnership: async (rec: EscalationRecord, senderHandle: string): Promise<boolean> => {
      const stored = await policies.getById(rec.policyId);
      return stored !== null && stored.owner.trim().toLowerCase() === senderHandle.trim().toLowerCase();
    },
  });

  const inbound = dashboard.toInbound({
    senderHandle: params.operatorWallet,
    action: params.action,
    escalationRef: params.escalationId,
  });
  const res = await service.handleInbound(inbound);
  return { outcome: res.outcome, status: res.status, detail: res.detail };
}
