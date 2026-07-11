import {
  ChannelRegistry,
  DashboardChannel,
  EscalationService,
  InMemoryEscalationsRepo,
  interimDashboardBinding,
  type EscalationRecord,
  type InboundOutcome,
  type EscalationStatus,
} from "@untch/escalation/pure";
import { getEscalations } from "./data";

/**
 * A REAL EscalationService running in-process over the in-memory repo — the same posture the rest of the
 * dashboard uses (real engines, seeded input), now for the §27 escalation lifecycle. This is what makes
 * dashboard-native approve/deny a real fourth channel rather than a mock: an operator's click runs through
 * the exact §27 authority-boundary check in @untch/escalation, via the DashboardChannel, identical to how
 * the ASP server runs a Telegram/Discord/Slack reply.
 *
 * Authority = SESSION IDENTITY. The operator is already SIWE-verified in their dashboard session, so their
 * bound wallet is passed as the sender handle and the binding matches (§27 pt3 satisfied by the session, no
 * fresh signature per click). The single-use code is held server-side and never exposed to the client — the
 * authenticated click is what redeems it. The real adversarial gates still run for real: intent-active,
 * valid-unexpired code, channel caps, dual-channel, and idempotent already-resolved.
 *
 * The singleton lives on globalThis so it survives Next's dev hot-reload; each decision builds a fresh
 * service bound to the requesting operator's wallet over this shared repo.
 */

interface Runtime {
  readonly repo: InMemoryEscalationsRepo;
  readonly registry: ChannelRegistry;
  readonly channel: DashboardChannel;
  /** escalationId -> the plaintext single-use code (server-side only). */
  readonly codes: Map<string, string>;
  ready: Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __untchEscRuntime: Runtime | undefined;
}

function bootstrap(): Runtime {
  const repo = new InMemoryEscalationsRepo();
  const channel = new DashboardChannel();
  const registry = new ChannelRegistry();
  registry.register(channel);
  const codes = new Map<string, string>();

  const rt: Runtime = { repo, registry, channel, codes, ready: Promise.resolve() };

  // Seed the one escalated decision as a real service-managed escalation (fans out to the dashboard inbox).
  rt.ready = (async () => {
    const seed = getEscalations()[0];
    if (!seed) return;
    const service = new EscalationService({
      repo,
      registry,
      binding: () => false, // creation checks no binding; a decision builds its own session-bound service.
    });
    const created = await service.createEscalation({
      pollRef: seed.intentHash,
      intentId: seed.intentHash,
      reason: seed.reason,
      policyId: "12",
      amount: seed.amount,
      token: seed.token,
      approvals: {
        channels: seed.channels,
        dualChannelAbove: seed.dualChannelAbove,
        channelCaps: seed.channelCaps,
        escalationTimeoutMin: 1440,
      },
    });
    codes.set(created.record.id, created.code);
  })();

  return rt;
}

function runtime(): Runtime {
  if (!globalThis.__untchEscRuntime) globalThis.__untchEscRuntime = bootstrap();
  return globalThis.__untchEscRuntime;
}

export interface DashboardEscalationView {
  readonly id: string;
  readonly intentHash: string;
  readonly amount: number;
  readonly token: string;
  readonly vendor: string;
  readonly reason: string;
  readonly status: EscalationStatus;
  readonly channels: readonly string[];
  readonly dualChannelAbove: number | null;
  readonly channelCaps: Readonly<Record<string, number>>;
  readonly resolvedBy: EscalationRecord["resolvedBy"];
  readonly approvedChannels: readonly string[];
}

export async function listDashboardEscalations(): Promise<DashboardEscalationView[]> {
  const rt = runtime();
  await rt.ready;
  const seedVendor = getEscalations()[0]?.vendor ?? "";
  const rows = await collectRecords(rt);
  return rows.map((rec) => ({
    id: rec.id,
    intentHash: rec.intentId,
    amount: rec.amount,
    token: rec.token,
    vendor: seedVendor,
    reason: rec.reason,
    status: rec.status,
    channels: rec.approvals.channels,
    dualChannelAbove: rec.approvals.dualChannelAbove,
    channelCaps: rec.approvals.channelCaps,
    resolvedBy: rec.resolvedBy,
    approvedChannels: rec.approvedChannels,
  }));
}

/** The in-memory repo has no list-all; recover the seeded record by its known pollRef. */
async function collectRecords(rt: Runtime): Promise<EscalationRecord[]> {
  const seed = getEscalations()[0];
  if (!seed) return [];
  const rec = await rt.repo.getByPollRef(seed.intentHash);
  return rec ? [rec] : [];
}

export interface DecisionResult {
  readonly outcome: InboundOutcome;
  readonly status: EscalationStatus | null;
  readonly detail: string;
}

export async function submitDashboardDecision(params: {
  operatorWallet: string;
  escalationId: string;
  action: "APPROVE" | "DENY";
}): Promise<DecisionResult> {
  const rt = runtime();
  await rt.ready;

  const code = rt.codes.get(params.escalationId);
  if (!code) return { outcome: "IGNORED_NOT_FOUND", status: null, detail: "no such escalation" };

  const service = new EscalationService({
    repo: rt.repo,
    registry: rt.registry,
    binding: interimDashboardBinding(params.operatorWallet),
  });

  const inbound = rt.channel.toInbound({
    senderHandle: params.operatorWallet,
    action: params.action,
    code,
    escalationRef: params.escalationId,
  });
  const result = await service.handleInbound(inbound);
  return { outcome: result.outcome, status: result.status, detail: result.detail };
}
